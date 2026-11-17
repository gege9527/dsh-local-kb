#!/usr/bin/env python3
"""生成文档卡片：每篇文档一张卡，含摘要、小节标题与行号。

卡片是检索入口，不是正文副本。命中卡片后按行号读原文对应段落。

用法：
    python3 kb-card.py [KB_ROOT] [--check]

输出：<KB_ROOT>/.kb-index/cards/<slug>.md
"""

import os
import re
import sys

CARD_DIR = ".kb-index/cards"
SUMMARY_CHARS = 200
SUMMARY_MIN = 40  # 摘要短于此值时继续累加后续段落（引用块开头的文档常只剩"行记录"这种残句）
SKIP_DIRS = {".kb-index", "archive", "node_modules", ".git"}
CARD_VERSION = 3  # 3 = 摘要回退链（frontmatter summary→引用块→段落累加），检索端靠它判断整库重建
VERSION_FILE = ".card-version"


def version_path(cards_dir):
    """版本文件放 cards/ 的父目录：cards/ 只放卡片，列目录时不会被当成孤儿。"""
    return os.path.join(os.path.dirname(cards_dir), VERSION_FILE)


def read_version(cards_dir):
    """读卡片格式版本；没有文件或读不懂都当 0（触发一次重建成当前版本）。"""
    try:
        with open(version_path(cards_dir), encoding="utf-8") as fh:
            return int(fh.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end]
    lines = block.split("\n")
    meta = {}
    i = 0
    while i < len(lines):
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", lines[i])
        if m is None:
            i += 1
            continue
        key, raw = m.group(1), m.group(2).strip()
        # YAML 块标量（>- / | 等）：把后续缩进行拼成一行，否则 summary/description
        # 会被读成字面量 ">-"，卡片摘要就只剩这个符号。
        if raw in (">", ">-", ">+", "|", "|-", "|+"):
            folded = []
            i += 1
            while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith((" ", "\t"))):
                if lines[i].strip():
                    folded.append(lines[i].strip())
                i += 1
            meta[key] = " ".join(folded)
            continue
        meta[key] = raw.strip('"').strip("'")
        i += 1
    return meta, text[end + 4:]


QUOTE_META = re.compile(r"^\*\*[^*]{1,24}\*\*[:：]?")
NAV_CHAPTER = re.compile(r"上一章|下一章")


def quote_text(block):
    """引用块的正文：剥掉行首 >，跳过 **info** / **分类**: 这类元数据行。"""
    kept = []
    for line in block.split("\n"):
        text = line.lstrip().lstrip(">").strip()
        if not text or QUOTE_META.match(text) or text.startswith("#"):
            continue
        kept.append(text)
    return " ".join(kept)


def first_paragraph(body, meta=None):
    """摘要回退链：frontmatter summary/description → 引用块正文 → 正文段落（不足则累加）。

    旧实现直接跳过以 > 开头的块，而文档模式产出的正文第一块正是 > **info** 引用块，
    导致 AirScript 那类文档的卡片摘要退化成"行记录"这类残句。
    """
    meta = meta or {}
    for key in ("summary", "description"):
        value = " ".join((meta.get(key) or "").split())
        if value:
            return value[:SUMMARY_CHARS]
    picked = []
    size = 0
    for block in re.split(r"\n\s*\n", body):
        s = block.strip()
        if not s or s.startswith("#") or s.startswith("|"):
            continue
        if s.startswith(">"):
            text = quote_text(s)
            if not text:
                continue
        else:
            text = re.sub(r"\s+", " ", s)
            if text.startswith("\x60\x60\x60"):
                continue
        # 书稿常见「上一章：X 下一章：Y」导航段：对检索零信息，跳过继续取下一段
        if text.lstrip().startswith(("上一章", "下一章")) or NAV_CHAPTER.search(text[:30]):
            continue
        picked.append(text)
        size += len(text)
        if size >= SUMMARY_MIN:
            break
    return " ".join(picked)[:SUMMARY_CHARS]


def sections(body, offset):
    out = []
    for i, line in enumerate(body.split("\n")):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            out.append((m.group(1), offset + i + 1))
    return out


def slug_of(rel):
    stem = rel[:-3] if rel.endswith(".md") else rel
    return re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", stem).strip("-")


def iter_docs(kb_root):
    for base in ("docs", "projects"):
        root = os.path.join(kb_root, base)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for name in filenames:
                if not name.endswith(".md") or name in ("MEMORY.md", "_topic.md"):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, kb_root)
                # 记忆不生成卡片（本身是索引）；项目页要生成，否则搜不到「某项目是干嘛的」
                if base == "projects" and "/memory/" in rel:
                    continue
                yield rel, full


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
    tail = text[m.end():]
    for line in tail.split("\n"):
        if not line.strip():
            continue
        mm = re.match(r"^[ \t]+-[ \t]*(.+)$", line)
        if mm:
            out.append(mm.group(1).strip().strip("'\""))
            continue
        break
    return out


def build_card(kb_root, rel, full):
    text = open(full, encoding="utf-8").read()
    meta, body = frontmatter(text)
    offset = text[: len(text) - len(body)].count("\n") + 1
    title = meta.get("title", "").strip('"') or os.path.basename(rel)[:-3]
    summary = first_paragraph(body, meta)
    secs = sections(body, offset)
    desc = " ".join((meta.get("description") or "").split())
    alias = ", ".join(read_aliases(text))
    lines = [
        "---",
        "doc: " + rel,
        "title: " + title,
        "type: card",
        "card: %d" % CARD_VERSION,
    ]
    # 别名与钩子单独成行：检索端给中间权重（不是标题权重），避免宽泛描述误伤排序
    if desc:
        lines.append("desc: " + desc)
    if alias:
        lines.append("alias: " + alias)
    lines += [
        "---",
        "",
        "## 摘要",
        summary or "（无正文段落）",
        "",
        "## 小节",
    ]
    if secs:
        for heading, line in secs[:20]:
            lines.append("- %s (L%d)" % (heading, line))
    else:
        lines.append("- （无二级标题）")
    tags = meta.get("tags", "")
    if tags:
        lines.append("")
        lines.append("## 标签")
        lines.append(tags)
    return "\n".join(lines) + "\n"


def main(argv):
    kb_root = os.path.expanduser(argv[1] if len(argv) > 1 and not argv[1].startswith("-") else "~/.local-kb")
    check_only = "--check" in argv
    prune = "--prune" in argv
    out_dir = os.path.join(kb_root, CARD_DIR)
    count = 0
    stale = 0
    written = 0
    expected = set()
    for rel, full in iter_docs(kb_root):
        count += 1
        expected.add(slug_of(rel) + ".md")
        card = build_card(kb_root, rel, full)
        if check_only:
            path = os.path.join(out_dir, slug_of(rel) + ".md")
            if not os.path.exists(path):
                stale += 1
            continue
        os.makedirs(out_dir, exist_ok=True)
        path = os.path.join(out_dir, slug_of(rel) + ".md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(card)
        written += 1
    if check_only:
        if read_version(out_dir) != CARD_VERSION:
            print("文档 %d，卡片版本需重建（当前 %s，期望 %d）" % (count, read_version(out_dir), CARD_VERSION))
            sys.exit(1)
        print("文档 %d，缺卡 %d" % (count, stale))
        sys.exit(1 if stale else 0)
    removed = 0
    if prune and os.path.isdir(out_dir):
        for name in os.listdir(out_dir):
            if name.endswith(".md") and name not in expected:
                try:
                    os.remove(os.path.join(out_dir, name))
                    removed += 1
                except OSError:
                    pass
    # 版本落盘：卡片格式变了（比如开始收录 desc/alias），检索端据此整库重建一次
    try:
        with open(version_path(out_dir), "w", encoding="utf-8") as fh:
            fh.write(str(CARD_VERSION) + "\n")
    except OSError:
        pass
    print("文档 %d，写卡 %d，清孤儿 %d → %s" % (count, written, removed, out_dir))


if __name__ == "__main__":
    main(sys.argv)
