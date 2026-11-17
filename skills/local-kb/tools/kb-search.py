#!/usr/bin/env python3
"""知识库检索：拆词 → 卡片打分 → 原文行定位。

三段式：
  1. 查询拆词（多字停用词剥离 + 中文 bigram + 英文 token），整句提问也能命中；
  2. 卡片层打分（标题/路径权重 3、摘要与小节权重 1，idf 加权覆盖率），缩到几篇；
  3. 原文 grep 出具体行号，输出 1~2K token 的片段，不返回整章正文。

用法：
    python3 kb-search.py "<关键词>" [KB_ROOT] [--limit N] [--rebuild] [--no-auto]
"""

import math
import os
import re
import subprocess
import sys

CARD_DIR = ".kb-index/cards"
VERSION_FILE = ".card-version"
CARD_VERSION = 2  # 与 kb-card.py 同步：2 起卡片收录 desc / alias
MAX_HITS_PER_DOC = 3
SNIPPET_CHARS = 110
TITLE_WEIGHT = 8  # 标题/文件名命中是强信号，实测 3 → 8 把 hit@1 从 13/18 拉到 15/18
DESC_WEIGHT = 3  # description/别名命中给中间权重：实测用 TITLE_WEIGHT 会把宽泛描述顶成误伤
ALIAS_BONUS = 1000.0  # 查询里出现声明过的别名 → 直接置顶，不参与比例截断
EXACT_BONUS_TITLE = 1.0
EXACT_BONUS_BODY = 0.5
MIN_RATIO_OF_TOP = 0.30
MIN_SCORE = 1.0
BM25_K1 = 1.5
BM25_B = 0.75

CARD_SKIP_DIRS = {".kb-index", "archive", "node_modules", ".git"}

# 多字停用词：只剥离「问句骨架」，不动实词。单字（的/和/与）不剥，避免切坏词。
STOP_PHRASES = [
    "可不可以", "能不能", "有没有", "是不是", "告诉我", "在哪里",
    "是什么", "怎么样", "怎么办", "怎么用", "怎么查", "为什么",
    "请问", "帮我", "一下", "想要", "知道", "介绍", "说明",
    "用法", "写法", "相关", "关于", "这个", "那个", "以及",
    "还是", "或者", "但是", "因为", "所以", "如果", "需要",
    "应该", "一般", "通常", "具体", "怎么", "如何", "什么",
    "哪里", "哪个", "哪些", "我们", "你们",
]

ASCII_RE = re.compile(r"[a-z0-9][a-z0-9_.#+/-]*")
CJK_RE = re.compile(r"[\u4e00-\u9fff]+")


def frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    meta = {}
    for line in text[3:end].split("\n"):
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if m:
            meta[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return meta, text[end + 4:]


def iter_docs(kb_root):
    """与 kb-card.py 同一套枚举规则：doc 卡片对应 docs/ 与 projects/<id>/docs/。"""
    for base in ("docs", "projects"):
        root = os.path.join(kb_root, base)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in CARD_SKIP_DIRS]
            for name in filenames:
                if not name.endswith(".md") or name in ("MEMORY.md", "_topic.md"):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, kb_root)
                if base == "projects" and "/memory/" in rel:
                    continue
                yield rel, full


def slug_of(rel):
    stem = rel[:-3] if rel.endswith(".md") else rel
    return re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", stem).strip("-")


def detect_stale(kb_root, cards_dir):
    """卡片缺失、比源文档旧、或格式版本不符 → 返回计数。查询前自检，避免拿旧摘要作答。"""
    missing = 0
    stale = 0
    if read_version(cards_dir) != CARD_VERSION:
        return 0, 1
    for rel, full in iter_docs(kb_root):
        card = os.path.join(cards_dir, slug_of(rel) + ".md")
        try:
            if not os.path.exists(card):
                missing += 1
            elif os.path.getmtime(card) < os.path.getmtime(full):
                stale += 1
        except OSError:
            continue
    return missing, stale


# 中文里只连接两个名词的虚字：按它切段，段落才是「主词」
CJK_SPLIT = re.compile(r"[的和与及或、]")


def split_query(query):
    """查询 → (主词, 辅助词)。

    主词 = ASCII token + 按连接虚字切开的中文段。记忆层只认主词命中，
    否则「量子纠缠」会靠 bigram「纠缠」撞上一条讲方案纠缠的记忆。
    辅助词 = 中文 bigram，只给文档打分和记忆加分，不能单独触发记忆命中。
    """
    text = query.lower()
    for phrase in STOP_PHRASES:
        text = text.replace(phrase, " ")
    primary = []
    secondary = []
    for m in ASCII_RE.finditer(text):
        tok = m.group(0).strip("-/")
        if len(tok) >= 2:
            primary.append(tok)
    for seg in CJK_RE.findall(text):
        if len(seg) < 2:
            continue
        for part in CJK_SPLIT.split(seg):
            if len(part) >= 2:
                primary.append(part)
        if len(seg) > 2:
            for i in range(len(seg) - 1):
                secondary.append(seg[i:i + 2])
    seen = set()
    prim = []
    for t in primary:
        if t not in seen:
            seen.add(t)
            prim.append(t)
    sec = []
    for t in secondary:
        if t not in seen:
            seen.add(t)
            sec.append(t)
    return prim, sec


def make_terms(query):
    """文档层用的全部检索词（主词 + 辅助词）。"""
    prim, sec = split_query(query)
    return prim + sec


def load_cards(kb_root):
    cards_dir = os.path.join(kb_root, CARD_DIR)
    cards = []
    try:
        names = sorted(os.listdir(cards_dir))
    except OSError:
        return cards
    for name in names:
        if not name.endswith(".md"):
            continue
        try:
            text = open(os.path.join(cards_dir, name), encoding="utf-8").read()
        except OSError:
            continue
        meta, body = frontmatter(text)
        doc = meta.get("doc") or name[:-3]
        title = meta.get("title") or name[:-3]
        desc = " ".join((meta.get("desc") or "").split()).lower()
        cards.append({
            "doc": doc,
            "title": title,
            "desc": desc,
            "aliases": parse_aliases(meta.get("alias")),
            "head": (title + " " + os.path.basename(doc)[:-3]).lower(),
            "body": body.lower(),
            "raw_body": body,
        })
    return cards


def idf_table(cards, terms):
    n = len(cards) or 1
    table = {}
    for t in terms:
        df = 0
        for c in cards:
            if t in c["head"] or t in c["body"] or (c["desc"] and t in c["desc"]):
                df += 1
        if df:  # df=0 的词谁也命中不了，直接跳过
            table[t] = math.log(1 + (n - df + 0.5) / (df + 0.5))
    return table


def read_aliases(text):
    """别名取多种写法：aliases: a, b / aliases: [a, b] / YAML 多行 - a 换 - b。
    项目页一直用多行列表，只认单行会把已有别名全部读丢。"""
    m = re.search(r"^aliases:[ \t]*(.*)$", text, re.M)
    if not m:
        return []
    rest = m.group(1).strip()
    if rest and rest not in ("|", ">"):
        return [x.strip().strip("'\"") for x in re.split(r"[,、]", rest.strip("[]")) if x.strip()]
    out = []
    for line in text[m.end():].split("\n"):
        if not line.strip():
            continue
        mm = re.match(r"^[ \t]+-[ \t]*(.+)$", line)
        if mm:
            out.append(mm.group(1).strip().strip("'\""))
            continue
        break
    return out


def parse_aliases(raw):
    """把 frontmatter 的 aliases 拆成列表，兼容 [a, b] / a, b / a、b。"""
    if not raw:
        return []
    out = []
    for piece in re.split(r"[,、;；]", str(raw).strip().strip("[]")):
        name = piece.strip().strip("'\"")
        if name:
            out.append(name)
    return out


def read_version(cards_dir):
    """读卡片格式版本；缺失或读不懂都当 0（触发一次整库重建）。
    版本文件在 cards/ 的父目录，cards/ 里只有卡片。"""
    try:
        with open(os.path.join(os.path.dirname(cards_dir), VERSION_FILE), encoding="utf-8") as fh:
            return int(fh.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def norm_name(text):
    """别名/查询归一化：去空白与常见标点，只保留可比较的字符。"""
    return re.sub(r"[\s，。、；：！？,.;:!?（）()\[\]\"'“”‘’]", "", str(text or "").lower())


def alias_hit(aliases, query):
    """查询里出现了声明过的别名（整串包含即算，别名是精确词表不是同义词）。"""
    nq = norm_name(query)
    if not nq:
        return False
    for name in aliases or []:
        n = norm_name(name)
        if n and (nq == n or n in nq):
            return True
    return False


def term_matcher(term):
    """ASCII 词要词边界（oa 不能命中 clipboard），中文走子串。返回 (count_fn, contains)。"""
    if term.isascii():
        pat = re.compile(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])")
        return (lambda text: len(pat.findall(text)), lambda text: pat.search(text) is not None)
    return (lambda text: text.count(term), lambda text: term in text)


def score_cards(cards, terms, query, table=None):
    """BM25 累加：部分命中也能拿到分，稀有词不会把其它文档压成 0。

    不做「除以理论最大分」的归一化——整句提问里只要有一个只在单篇出现的片段，
    分母就会暴涨，导致其余文档全被阈值砍掉（旧实现的坑）。
    """
    if table is None:
        table = idf_table(cards, terms)
    if not table:
        # 一个词都没落库时仍要认别名：查询用的俗称可能整库一次都没出现过
        return [(ALIAS_BONUS, c, []) for c in cards if alias_hit(c["aliases"], query)]
    avgdl = max(1, sum(len(c["body"]) for c in cards) // max(1, len(cards)))
    q = " ".join(query.lower().split())
    matchers = {t: term_matcher(t) for t in table}
    scored = []
    for c in cards:
        dl = len(c["body"]) or 1
        s = 0.0
        hit_terms = []
        for t, w in table.items():
            count, contains = matchers[t]
            tf = count(c["body"]) if t in c["body"] else 0
            if tf:
                s += w * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl))
                hit_terms.append(t)
            if contains(c["head"]):
                s += w * TITLE_WEIGHT
                hit_terms.append(t)
            elif c["desc"] and contains(c["desc"]):
                s += w * DESC_WEIGHT
                hit_terms.append(t)
        if s <= 0 and not alias_hit(c["aliases"], query):
            continue
        if q and q in c["head"]:
            s += EXACT_BONUS_TITLE * 10
        elif q and q in c["body"]:
            s += EXACT_BONUS_BODY * 10
        scored.append((s, c, hit_terms))
    # 别名命中的卡片置顶，且不受比例截断（gbrain 的 alias hop 语义：声明过的名字必须能召回到）
    scored.sort(key=lambda row: (0 if alias_hit(row[1]["aliases"], query) else 1, -row[0]))
    if not scored:
        return []
    floor = max(scored[0][0] * MIN_RATIO_OF_TOP, MIN_SCORE)
    return [row for row in scored if row[0] >= floor or alias_hit(row[1]["aliases"], query)]


def evidence_of(card, query):
    """这条结果凭什么被召回，供 --explain 和置信判断使用。"""
    if alias_hit(card["aliases"], query):
        return "alias_hit"
    q = " ".join(query.lower().split())
    if q and q in card["head"]:
        return "exact_title"
    if card["desc"] and q and q in card["desc"]:
        return "desc_match"
    if q and q in card["body"]:
        return "exact_body"
    return "keyword"


def grade_hits(rows, sec, query):
    """给本次检索定置信：strong / moderate / weak / none。

    借 gbrain 的 CRAG 分级思路，纯计算、零模型调用：
    覆盖率只数「辅助词」（bigram / 关键词）在库里的命中比例——分母用查询的
    全部辅助词，不是能匹配的词，否则「量子纠缠的贝尔不等式」这种整句里只剩
    一个「不等」，1/1 会被误判成高置信。
    """
    if not rows:
        return "none", ""
    top = rows[0]
    if alias_hit(top[1]["aliases"], query) or evidence_of(top[1], query) == "exact_title":
        return "strong", "别名或标题精确命中"
    if not sec:
        # 单字/超短查询没有辅助词：词面直接命中就算可信
        return ("strong", "短查询词面命中") if top[2] else ("weak", "无词面命中")
    denom = len(sec)
    hit = sorted(set(top[2]) & set(sec))
    cov = len(hit) / denom
    detail = "命中 %d/%d 个词%s" % (len(hit), denom, ("（%s）" % "、".join(hit)) if hit else "")
    if cov >= 0.5:
        return "strong", detail
    if cov >= 0.34:
        return "moderate", detail
    return "weak", detail


def snippets(path, terms, kb_root):
    best = sorted(terms, key=len, reverse=True)
    hits = []
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError:
        return hits
    for i, line in enumerate(lines, 1):
        low = line.lower()
        if any(t in low for t in best):
            hits.append((i, line.strip()[:SNIPPET_CHARS]))
            if len(hits) >= MAX_HITS_PER_DOC:
                break
    return hits


MEMORY_SKIP = {"MEMORY.md", "_topic.md"}


def memory_roots(kb_root):
    roots = [os.path.join(kb_root, "memory")]
    projects = os.path.join(kb_root, "projects")
    if os.path.isdir(projects):
        for name in sorted(os.listdir(projects)):
            mem = os.path.join(projects, name, "memory")
            if os.path.isdir(mem):
                roots.append(mem)
    return roots


def load_memories(kb_root):
    """记忆层：直接读正文，不建索引——188 条 / 1.2M，实测几十毫秒。"""
    items = []
    for root in memory_roots(kb_root):
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d != "archive"]
            for name in filenames:
                if not name.endswith(".md") or name in MEMORY_SKIP:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    text = open(full, encoding="utf-8").read()
                except OSError:
                    continue
                m = re.search(r"^description:\s*(.+)$", text[:1024], re.M)
                desc = m.group(1).strip() if m else ""
                items.append({
                    "rel": os.path.relpath(full, kb_root),
                    "desc": desc,
                    "aliases": read_aliases(text[:2048]),
                    "body": text.lower(),
                    "raw": text,
                })
    return items


def memory_hits(kb_root, query, limit=5):
    prim, sec = split_query(query)
    items = load_memories(kb_root)
    if not items or (not prim and not sec):
        return []
    n = len(items)
    table = {}
    for t in prim + sec:
        df = sum(1 for it in items if t in it["body"])
        if df:
            table[t] = math.log((n + 1) / (df + 0.5))
    if not table:
        hit = [it for it in items if alias_hit(it.get("aliases"), query)]
        return [it for _, it in sorted(((ALIAS_BONUS, it) for it in hit), key=lambda p: -p[0])][:limit]
    total = sum(table.get(t, 0) for t in prim + sec)
    scored = []
    for it in items:
        s = 0.0
        primary_hit = False
        sec_hits = 0
        for t, w in table.items():
            if t in it["body"]:
                s += w * (3 if t in it["desc"].lower() else 1)
                if t in prim:
                    primary_hit = True
                else:
                    sec_hits += 1
        hit_alias = alias_hit(it.get("aliases"), query)
        if s <= 0 and not hit_alias:
            continue
        # 只命中 bigram 的记忆要有足够覆盖才算相关，挡住「纠缠」这种单词巧合
        if hit_alias or primary_hit or (len(sec) >= 2 and sec_hits >= 2):
            scored.append((s + (ALIAS_BONUS if hit_alias else 0), it))
    if not scored:
        return []
    scored.sort(key=lambda pair: -pair[0])
    floor = max(scored[0][0] * 0.35, total * 0.15)
    return [it for s, it in scored if s >= floor or alias_hit(it.get("aliases"), query)][:limit]


def rebuild_cards(kb_root):
    card_py = os.path.join(os.path.dirname(__file__), "kb-card.py")
    subprocess.run([sys.executable, card_py, kb_root], capture_output=True, check=False)


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print('用法: kb-search.py "<关键词>" [KB_ROOT] [--limit N] [--rebuild] [--no-auto]', file=sys.stderr)
        return 2
    query = argv[1]
    rest = [a for a in argv[2:] if not a.startswith("--")]
    kb_root = os.path.expanduser(rest[0] if rest else "~/.local-kb")
    limit = 5
    for i, a in enumerate(argv):
        if a == "--limit" and i + 1 < len(argv):
            limit = int(argv[i + 1])
    cards_dir = os.path.join(kb_root, CARD_DIR)

    if "--rebuild" in argv:
        rebuild_cards(kb_root)
        print("# 卡片已重建", file=sys.stderr)

    missing, stale = detect_stale(kb_root, cards_dir)
    if missing or stale:
        parts = []
        if missing:
            parts.append("缺卡 %d 篇" % missing)
        if stale:
            parts.append("过期 %d 篇" % stale)
        if "--no-auto" in argv:
            print(
                "# 卡片索引需更新（%s）：python3 %s <KB_ROOT>"
                % ("，".join(parts), os.path.join(os.path.dirname(__file__), "kb-card.py")),
                file=sys.stderr,
            )
        else:
            # 自动补齐：卡片是纯生成物（排除同步），换设备后第一次检索就会建好
            rebuild_cards(kb_root)
            print("# 卡片已自动更新（%s）" % "，".join(parts), file=sys.stderr)

    prim, sec = split_query(query)
    terms = prim + sec
    cards = load_cards(kb_root)
    table = idf_table(cards, terms)
    rows = score_cards(cards, terms, query, table)[:limit]
    memories = memory_hits(kb_root, query)
    explain = "--explain" in argv

    if not rows and not memories:
        # 未命中分型：分清「库里没有」和「有词但没达阈值」，别让空结果冒充结论
        if not table:
            print("未命中：查询里的词在知识库里都没出现过——这个主题多半没入库")
        else:
            seen = "、".join(list(table)[:6])
            print("未命中：%d 个词在库中出现过（%s），但没有一篇达到相关阈值" % (len(table), seen))
        return 0
    if rows:
        level, detail = grade_hits(rows, sec, query)
        print("命中 %d 篇（关键词：%s）" % (len(rows), query))
        if level == "weak":
            print("⚠ 低置信：%s——可能只是字面巧合，别直接当答案" % detail)
            if memories:
                print("   下面「相关记忆」里的条目可能更贴近，优先看那里。")
        elif explain:
            print("置信：%s（%s）" % (level, detail))
    for idx, (score, card, hit_terms) in enumerate(rows, 1):
        print("")
        print("%d. %s" % (idx, card["doc"]))
        if explain:
            print("   证据：%s  分数：%.1f  命中词：%s"
                  % (evidence_of(card, query), score, "、".join(sorted(set(hit_terms))) or "无"))
        if card["title"] and card["title"] not in card["doc"]:
            print("   标题：%s" % card["title"])
        summary = ""
        for block in card["raw_body"].split("\n"):
            block = block.strip()
            if block and not block.startswith("#") and not block.startswith("-"):
                summary = block[:SNIPPET_CHARS]
                break
        if summary:
            print("   摘要：%s" % summary.replace("\n", " "))
        for line, text in snippets(os.path.join(kb_root, card["doc"]), terms, kb_root):
            print("   L%d: %s" % (line, text))
    if memories:
        print("")
        print("相关记忆 %d 条" % len(memories))
        for it in memories:
            print("- %s%s" % (it["rel"], (" — " + it["desc"]) if it["desc"] else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
