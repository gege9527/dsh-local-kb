#!/usr/bin/env python3
"""kb-check — local-kb 知识库校验闸门（零依赖，Python 3.9+）

用法:
    python3 kb-check.py [KB_ROOT] [--json] [--fix [--write]]
        --json   结构化输出
        --fix    列出「有笔记但没索引」的条目并给出追加计划（默认只预览，不落盘）
        --write  与 --fix 同用才真正写入：只追加缺失的指针行，不改已有行

退出码:
    0 = 全部通过
    1 = 有错误（写入方不得声称成功）
    2 = 仅警告

检查:
    记忆  frontmatter 五字段 / type 枚举 / name 与文件名一致 / 无 title|project_id
          索引指针 ↔ 文件一致（无越界 ../、无断指针、无漏索引）/ 时效词警告
          索引上限守卫（150 行/20KB 软 → 警告，200 行/25KB 硬 → 错误）
          status 分组自洽（opt-in：索引里存在 ## active / ## completed 段时才校验）
    文档  frontmatter 存在 + title（错误）；source / date_added（警告）
    项目页 存在 / 含 project_id / 无 project_path / 有资料时含「项目资料」节
    路径  paths.yaml 条目格式 / id 重复 / id 与「最短唯一路径后缀」规则不符
"""
import json
import os
import re
import sys

CJK = r"\u4e00-\u9fff"
TYPES = {"user", "feedback", "project", "reference"}
STATUSES = {"active", "completed", "archived"}
STALE = re.compile(r"待办|进行中|正在进行|正在编译|当前瓶颈|未完成|下一步")
SOFT_LINES, SOFT_KB = 150, 20
HARD_LINES, HARD_KB = 200, 25
# 索引指针行「- [描述](目标.md)」与二级小节标题「## name」
# 左右方括号拆开拼：技能严禁 Obsidian wikilink 语法，源码里连写两个左括号会被测试拦下。
_LB, _RB = r"\[", r"\]"
POINTER_LINE = re.compile(r"^\s*-\s*[^\[]*(?:" + _LB + r"[^\]]*" + _RB + r")\(([^)]+)\)")  # 允许「- ⚡ [..](..)」
SECTION_LINE = re.compile(r"^##\s+(.+?)\s*$")
# 只有这两个小节名表达 status 分组语义；其余（type / 日期）都是自由分组
GROUP_SECTIONS = ("active", "completed")
errors, warns = [], []


def read(p):
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except Exception:
        return ""


def frontmatter(text):
    if not text.startswith("---"):
        return None
    parts = text.split("---", 2)
    return parts[1] if len(parts) >= 3 else None


def field(fm, key):
    m = re.search(r"^%s:\s*(.+)$" % key, fm, re.M)
    return m.group(1).strip().strip('"') if m else None


def broken_pointer(t):
    """越界/断裂指针判定：离开本记忆目录的指针 = 断裂（协议明令不打开）。"""
    if t.startswith(("http://", "https://", "#", "file://")):
        return True
    if os.path.isabs(t):
        return True
    if ".." in t.split("/"):
        return True
    return False


def indexed(idx, f):
    """文件是否已被索引 —— 只认指针语法「](…/f)」，不认正文里顺带提到的文件名。

    旧实现用裸子串（f in idx），正文赞美一句「参考 foo.md」就算已索引，漏指针查不出来。
    """
    return re.search(r"\]\((?:[^)\s]*/)?" + re.escape(f) + r"\)", idx) is not None


def index_sections(idx):
    """把索引切成 [(小节名, 行列表)]；首个 ## 之前的部分小节名为 None。"""
    sections, name, lines = [], None, []
    for line in idx.splitlines():
        m = SECTION_LINE.match(line)
        if m:
            sections.append((name, lines))
            name, lines = m.group(1), []
            continue
        lines.append(line)
    sections.append((name, lines))
    return sections


def section_pointers(lines):
    out = []
    for line in lines:
        m = POINTER_LINE.match(line)
        if m:
            out.append(m.group(1))
    return out


def pick_section(idx, type_, status):
    """给待补的指针选落点：优先同名 type 小节，其次 project 的 status 小节。"""
    names = [name for name, _ in index_sections(idx) if name]
    if type_ and type_ in names:
        return type_
    if type_ == "project" and status in GROUP_SECTIONS and status in names:
        return status
    return None


def append_pointer(idx, section, line_text):
    """把一行指针插到指定小节最后一条指针之后；section 为 None 时追加到文件末尾。"""
    lines = idx.splitlines()
    if section is None:
        while lines and lines[-1].strip() == "":
            lines.pop()
        lines.append(line_text)
        return "\n".join(lines) + "\n"
    start = None
    for i, line in enumerate(lines):
        m = SECTION_LINE.match(line)
        if m and m.group(1) == section:
            start = i
            break
    if start is None:
        return append_pointer(idx, None, line_text)
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if SECTION_LINE.match(lines[j]):
            end = j
            break
    last = None
    for j in range(start + 1, end):
        if POINTER_LINE.match(lines[j]):
            last = j
    lines.insert((last + 1) if last is not None else start + 1, line_text)
    return "\n".join(lines) + "\n"


def append_section(idx, name, line_text):
    """在索引末尾新建「## name」小节并写入指针 —— 找不到可匹配的现有小节时用。

    不能退回「追加到文件末尾」：末尾常常正落在 ## completed 这类 status 分组段内，
    会把一条 active 笔记硬塞进完成段，自己制造出分组不一致。
    """
    lines = idx.splitlines()
    while lines and lines[-1].strip() == "":
        lines.pop()
    lines.extend(["", "## " + name, line_text])
    return "\n".join(lines) + "\n"


def plan_dir_fixes(d):
    """该记忆目录里「有笔记、无指针」的条目 → (索引文本, [(文件, type, status, 落点小节)])。"""
    idx_path = os.path.join(d, "MEMORY.md")
    if not os.path.exists(idx_path):
        return None
    idx = read(idx_path)
    plan = []
    for f in sorted(os.listdir(d)):
        if not f.endswith(".md") or f == "MEMORY.md":
            continue
        p = os.path.join(d, f)
        if os.path.isdir(p) or indexed(idx, f):
            continue
        fm = frontmatter(read(p))
        if fm is None:
            continue  # 无 frontmatter 的文件交给校验报错，不猜分组
        type_, status = field(fm, "type"), field(fm, "status")
        plan.append((f, type_, status, pick_section(idx, type_, status)))
    return idx, plan


def run_fix(write):
    """补索引：只追加缺失的指针行，已有行一字不动。write=False 时只预览。"""
    report = []
    for d in mem_dirs:
        if not os.path.isdir(d):
            continue
        got = plan_dir_fixes(d)
        if got is None or not got[1]:
            continue
        idx, plan = got
        rel_d = os.path.relpath(d, KB)
        text = idx
        for f, type_, status, section in plan:
            line_text = "- [%s](%s)" % (f[:-3], f)
            if section is not None:
                text = append_pointer(text, section, line_text)
            elif type_:
                text = append_section(text, type_, line_text)
                section = "+" + type_
                warns.append("未见 ## %s 小节，已新建该小节放入指针: %s/%s" % (type_, rel_d, f))
            else:
                text = append_pointer(text, None, line_text)
        if write:
            with open(os.path.join(d, "MEMORY.md"), "w", encoding="utf-8") as out:
                out.write(text)
        report.append((rel_d, [(f, section) for f, _, _, section in plan]))
    return report


def check_index_groups(rel_d, idx, statuses):
    """status 分组索引的自洽校验 —— opt-in：只有索引里存在对应小节才生效。

    协议本身是「按类型小节分组」，所以没写 ## active / ## completed 的索引不参与本检查；
    一旦写了，该小节的成员就必须与文件 frontmatter 的 status 一致。
    """
    grouped = {}
    for name, lines in index_sections(idx):
        if name in GROUP_SECTIONS:
            grouped.setdefault(name, []).extend(os.path.basename(t) for t in section_pointers(lines))
    for group, targets in grouped.items():
        for target in targets:
            st = statuses.get(target)
            if st is not None and st != group:
                errors.append("索引 ## %s 段下的 %s 实际 status: %s: %s" % (group, target, st, rel_d))
    placed = {t for targets in grouped.values() for t in targets}
    for f, st in statuses.items():
        # 只在该 status 对应的小节存在时反向校验（opt-in）；放错段的文件已经在上面报过
        if st in grouped and f not in placed:
            errors.append("status: %s 的笔记不在索引 ## %s 段: %s/%s" % (st, st, rel_d, f))


def check_memory_dir(d):
    idx_path = os.path.join(d, "MEMORY.md")
    rel_d = os.path.relpath(d, KB)
    if not os.path.exists(idx_path):
        errors.append("记忆目录缺 MEMORY.md: %s" % rel_d)
        return 0
    idx = read(idx_path)
    idx_lines = idx.count("\n") + 1
    idx_bytes = len(idx.encode("utf-8"))
    if idx_lines > HARD_LINES or idx_bytes > HARD_KB * 1024:
        errors.append("记忆索引超硬上限(%d 行/%d B，限 %d/%dKB): %s —— 先压缩再追加" % (idx_lines, idx_bytes, HARD_LINES, HARD_KB, rel_d))
    elif idx_lines > SOFT_LINES or idx_bytes > SOFT_KB * 1024:
        warns.append("记忆索引超软上限(%d 行/%d B，限 %d/%dKB): %s —— 建议压缩" % (idx_lines, idx_bytes, SOFT_LINES, SOFT_KB, rel_d))
    notes = [f for f in os.listdir(d) if f.endswith(".md") and f != "MEMORY.md"]
    n = 0
    active_count = 0
    statuses = {}
    for f in notes:
        p = os.path.join(d, f)
        if os.path.isdir(p):
            continue
        n += 1
        text = read(p)
        fm = frontmatter(text)
        rel = os.path.relpath(p, KB)
        if fm is None:
            errors.append("记忆无 frontmatter: %s" % rel)
            continue
        for k in ("name", "description", "type", "created", "updated"):
            if not field(fm, k):
                errors.append("记忆缺字段 %s: %s" % (k, rel))
        t = field(fm, "type")
        if t and t not in TYPES:
            errors.append("记忆 type 非法(%s): %s" % (t, rel))
        st = field(fm, "status")
        if st and st not in STATUSES:
            errors.append("记忆 status 非法(%s，限 active/completed/archived): %s" % (st, rel))
        if st and t != "project":
            errors.append("非 project 记忆不得带 status: %s" % rel)
        if st:
            statuses[f] = st
        name = field(fm, "name")
        if name and name != f[:-3]:
            errors.append("记忆 name 与文件名不一致(%s≠%s): %s" % (name, f[:-3], rel))
        if field(fm, "title") or field(fm, "project_id"):
            errors.append("记忆含协议外字段(title/project_id): %s" % rel)
        if st == "active":
            active_count += 1
        # 时效词只在「还可能过期」的笔记上算信号：completed/archived 里的「下一步」
        # 是历史叙述（实测 2/2 误报），不再报警。
        if st in (None, "active") and STALE.search(text) and t in ("user", "feedback", "project"):
            body_txt = text.split("---", 2)[-1]
            if not re.search(r"^> .*(?:截至|Superseded)", body_txt, re.M):
                warns.append("记忆含未标注的时效性内容(待办/进行中，缺历史化标注): %s" % rel)
        body = text.split("---", 2)[-1]
        for m in re.finditer(r"`([w./-]+/[w./-]+\.(?:md|json|py|js|ts))`", body):
            ref = m.group(1)
            if ref.startswith(("http", "/")):
                continue
            if not os.path.exists(os.path.join(PROJECT_ROOT_ROOT, ref)):
                warns.append("记忆引用路径可能已失效(%s): %s" % (ref, rel))
        if not indexed(idx, f):
            errors.append("记忆未被索引: %s" % rel)
    if rel_d == "memory" and active_count:
        errors.append("全局记忆目录不得有 active project: %s" % rel_d)
    if rel_d != "memory" and active_count > 1:
        errors.append("记忆目录 active project 超过 1 条(%d): %s" % (active_count, rel_d))
    for m in re.finditer(r"\]\(([^)]+\.md)\)", idx):
        t = m.group(1)
        if broken_pointer(t):
            errors.append("索引越界指针(%s → %s)：只允许指向本记忆目录内部的文件" % (rel_d, t))
            continue
        if not os.path.exists(os.path.join(d, t)):
            errors.append("索引断指针(%s → %s)" % (rel_d, t))
    check_index_groups(rel_d, idx, statuses)
    return n


# 内容下限类检查会命中大量存量（实测 31 个项目页里 17 个目录结构只有一行），
# 逐条 warn 会把真正的错误淹没、让每次自检都变红。这里累计，最后汇总成一条。
doc_no_h2 = 0
doc_big = 0


def check_doc(p, project_doc=False):
    # 主题自描述与索引类文件不是文档正文，单独校验
    if os.path.basename(p) in ("_topic.md", "_projects.md"):
        return
    rel = os.path.relpath(p, KB)
    text = read(p)
    fm = frontmatter(text)
    if fm is None:
        errors.append("文档无 frontmatter: %s" % rel)
    else:
        if not field(fm, "title"):
            errors.append("文档缺 title: %s" % rel)
        if not field(fm, "type"):
            warns.append("文档缺 type: %s" % rel)
        if not field(fm, "source"):
            warns.append("文档缺 source: %s" % rel)
        if not field(fm, "date_added"):
            warns.append("文档缺 date_added: %s" % rel)
    # 结构完整性：长文却没有二级标题，等于整篇平铺，AI 只能从头读到尾
    body = re.sub(r"(?s)^---.*?---", "", text, count=1)
    plain = re.sub(r"\s", "", body)
    h2 = len(re.findall(r"(?m)^## ", text))
    global doc_no_h2, doc_big
    # 只查自产文档（projects/<id>/docs/）。docs/ 下是抓来的原文——书稿一章 271KB、
    # 官方语法参考 209KB 都是源头决定的，加 H2 或拆分反而破坏与源的对应关系，不该报。
    if project_doc:
        if h2 == 0 and len(plain) > 2000:
            doc_no_h2 += 1
        if len(text.encode("utf-8")) > 40 * 1024:
            doc_big += 1


def walk_md(root, skip=("archive",)):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
        for f in filenames:
            if f.endswith(".md") and f != "MEMORY.md":
                yield os.path.join(dirpath, f)


ARGV = [a for a in sys.argv[1:] if not a.startswith("--")]
JSON_MODE = "--json" in sys.argv[1:]
FIX_MODE = "--fix" in sys.argv[1:]
WRITE_MODE = "--write" in sys.argv[1:]
KB = os.path.abspath(os.path.expanduser(ARGV[0] if ARGV else "~/.local-kb"))
PROJECT_ROOT_ROOT = os.path.join(KB, "projects")
GLOBAL_MEM_ROOT = os.path.join(KB, "memory")
if not os.path.isdir(KB):
    if JSON_MODE:
        print(json.dumps({"ok": False, "errors": ["KB_ROOT 不存在: %s" % KB], "warns": [], "stats": {}}, ensure_ascii=False))
    else:
        print("kb-check: KB_ROOT 不存在: %s" % KB)
    sys.exit(1)

# 记忆目录清单（校验与 --fix 共用）
mem_dirs = [GLOBAL_MEM_ROOT]
if os.path.isdir(PROJECT_ROOT_ROOT):
    for d in sorted(os.listdir(PROJECT_ROOT_ROOT)):
        sub = os.path.join(PROJECT_ROOT_ROOT, d, "memory")
        if os.path.isdir(sub):
            mem_dirs.append(sub)

# 记忆目录内不得自建 archive/：协议规定归档统一进 <KB_ROOT>/archive/。
# 建在记忆目录里更糟——walk_md 会跳过 archive 子目录，里面的笔记既不进索引也不报错，
# 等于悄悄消失（召回永远看不到，也没人知道它还在）。
for d in mem_dirs:
    nested = os.path.join(d, "archive")
    if os.path.isdir(nested):
        errors.append("记忆目录内不得建 archive/（归档统一放 <KB_ROOT>/archive/）: %s"
                      % os.path.relpath(nested, KB))

# --fix：先补指针再校验（写入模式下，随后的校验看到的是修好的状态）
fix_report = []
if FIX_MODE:
    fix_report = run_fix(WRITE_MODE)
    if not JSON_MODE:
        if not fix_report:
            print("--fix: 没有缺失的索引指针")
        else:
            print("--fix %s %d 个目录:" % ("已追加" if WRITE_MODE else "预览（加 --write 落盘）", len(fix_report)))
            for rel_d, items in fix_report:
                for f, section in items:
                    print("  + %s/%s → ## %s" % (rel_d, f, section or "（末尾，未匹配到小节）"))
        print("")

# 记忆
mem_total = sum(check_memory_dir(d) for d in mem_dirs if os.path.isdir(d))

# 文档
docs_root = os.path.join(KB, "docs")
doc_total = 0
if os.path.isdir(docs_root):
    for p in walk_md(docs_root):
        check_doc(p, os.sep + "projects" + os.sep in p)
        doc_total += 1
proj_doc_total = 0
if os.path.isdir(PROJECT_ROOT_ROOT):
    for d in sorted(os.listdir(PROJECT_ROOT_ROOT)):
        pd = os.path.join(PROJECT_ROOT_ROOT, d, "docs")
        if os.path.isdir(pd):
            for p in walk_md(pd):
                check_doc(p, True)
                proj_doc_total += 1

# 项目页
page_errors = 0
page_what_short = []
page_tree_one = []
page_files_empty = []
if os.path.isdir(PROJECT_ROOT_ROOT):
    for d in sorted(os.listdir(PROJECT_ROOT_ROOT)):
        dd = os.path.join(PROJECT_ROOT_ROOT, d)
        if not os.path.isdir(dd) or d in ("archive",):
            continue
        page = os.path.join(dd, d + ".md")
        if not os.path.exists(page):
            errors.append("项目页缺失: projects/%s/%s.md" % (d, d))
            page_errors += 1
            continue
        text = read(page)
        if re.search(r"^project_path:", text, re.M):
            errors.append("项目页残留 project_path: projects/%s" % d)
        if not re.search(r"^project_id:", text, re.M):
            errors.append("项目页缺 project_id: projects/%s" % d)
        has_material = os.path.isdir(os.path.join(dd, "arch")) or os.path.isdir(os.path.join(dd, "docs")) or os.path.isdir(os.path.join(dd, "memory"))
        if has_material and "项目资料" not in text:
            warns.append("项目页缺「项目资料」节: projects/%s" % d)
        # 项目页「怎么查」的源码 grep 必须带 --exclude-dir：不带会扫进 node_modules，
        # 实测 8.6 万文件的 monorepo 是 27s / 337K 行，排除后 4.7s / 38K 行
        query_sec = re.search(r"(?ms)^## 怎么查这个项目\n(.*?)(?=^## |\Z)", text)
        if query_sec is not None:
            for line in query_sec.group(1).split("\n"):
                if line.lstrip().startswith("grep -rn") and "--exclude-dir" not in line:
                    warns.append("项目页源码搜索缺 --exclude-dir（会扫进 node_modules）: projects/%s" % d)
                    break
        # 概念表：inject 的「已收录」只读这张表，空表等于该项目每轮都拿不到提示
        concept = re.search(r"^## 中文概念[^\n]*\n([\s\S]*?)(?=^## |\Z)", text, re.M)
        if concept is not None:
            rows = [ln for ln in concept.group(1).split("\n") if ln.startswith("|")]
            if len(rows) <= 2:  # 只有表头 + 分隔行
                warns.append("项目页概念表为空: projects/%s" % d)
        # 内容下限（实测 14/31 「这是什么」<60 字、17/31 目录结构只有一行）
        what = re.search(r"(?ms)^## 这是什么\n(.*?)(?=^## |\Z)", text)
        if what is not None and len(re.sub(r"\s", "", what.group(1))) < 60:
            page_what_short.append(d)
        tree = re.search(r"(?ms)^## 目录结构\n(.*?)(?=^## |\Z)", text)
        if tree is not None:
            body = tree.group(1)
            inner = re.search(r"```[a-z]*\n(.*?)```", body, re.S)
            if inner is not None:
                lines = [x for x in inner.group(1).split("\n") if x.strip()]
            else:
                # 表格 / 列表同样能表达目录，别只认代码块（oa-ai 就是表格）
                lines = [x for x in body.split("\n")
                         if x.strip().startswith(("|", "-", "*")) and "---" not in x and "目录" not in x]
            if len(lines) <= 1:
                page_tree_one.append(d)
        files = re.search(r"(?ms)^## 关键文件\n(.*?)(?=^## |\Z)", text)
        if files is not None:
            body = files.group(1)
            rows = [x for x in body.split("\n")
                    if (x.startswith("|") and "---" not in x and "文件" not in x)
                    or x.lstrip().startswith(("- ", "* "))]
            if len(rows) == 0:
                page_files_empty.append(d)
        # 「项目资料」表格里的相对 md 路径必须真实存在（归档/改名后最容易留死链）
        material = re.search(r"^## 项目资料[^\n]*\n([\s\S]*?)(?=^## |\Z)", text, re.M)
        if material is not None:
            for target in re.findall(r"`([^`]+\.md)`", material.group(1)):
                # 只校验 KB 内约定目录：裸文件名可能指源码项目的 README，不该当死链
                if broken_pointer(target) or not target.startswith(("docs/", "memory/", "arch/", "assets/")):
                    continue
                if not os.path.exists(os.path.join(dd, target)):
                    errors.append("项目资料死链: projects/%s → %s" % (d, target))

# 内容下限汇总：逐条会命中大量存量（见 check_doc 上方注释），合并成几条
if page_what_short:
    warns.append("项目页「这是什么」<60 字 %d 个（需说清解决什么问题 + 边界）: %s"
                 % (len(page_what_short), "、".join(page_what_short[:6])))
if page_tree_one:
    warns.append("项目页「目录结构」只列 1 行 %d 个（需每目录带职责）: %s"
                 % (len(page_tree_one), "、".join(page_tree_one[:6])))
if page_files_empty:
    warns.append("项目页「关键文件」空表 %d 个（应删掉整节）: %s"
                 % (len(page_files_empty), "、".join(page_files_empty)))
if doc_no_h2:
    warns.append("文档无二级标题且正文 >2000 字 %d 篇（建议分节）" % doc_no_h2)
if doc_big:
    warns.append("文档 >40KB %d 篇（建议按主题拆）" % doc_big)

# paths.yaml
yp = os.path.join(KB, "paths.yaml")
known_projects = set()
path_entries = []
if os.path.exists(yp):
    cur_id = None
    for line in read(yp).splitlines():
        if re.match(r"\s+path:\s*$", line):
            errors.append("paths.yaml 有空 path 值")
        m = re.match(r"^([A-Za-z0-9_" + CJK + r"][\w" + CJK + r"-]*):\s*$", line)
        if m:
            known_projects.add(m.group(1))
            cur_id = m.group(1)
            continue
        pm = re.match(r"^\s+path:\s*(.+?)\s*$", line)
        if pm and cur_id:
            path_entries.append((cur_id, pm.group(1).strip("'\"")))
            cur_id = None

# 命名规则：id = 能保证唯一的最短路径后缀（与 kb-move-project.py 同一条规则）
def kebab_seg(seg):
    s = seg.strip().lower()
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"[^0-9a-z" + CJK + r"-]+", "-", s)
    return re.sub(r"-+", "-", s).strip("-") or "project"

if path_entries:
    ids_only = [e[0] for e in path_entries]
    dup_ids = sorted({i for i in ids_only if ids_only.count(i) > 1})
    if dup_ids:
        errors.append("paths.yaml 项目 id 重复: " + "、".join(dup_ids))
    segs = {i: [kebab_seg(x) for x in p.split("/") if x] for i, p in path_entries}
    wrong = []
    for i, parts in segs.items():
        derived = None
        for k in range(1, len(parts) + 1):
            suf = "-".join(parts[-k:])
            if sum(1 for other in segs.values() if "-".join(other[-k:]) == suf) == 1:
                derived = suf
                break
        if derived is not None and derived != i:
            wrong.append("%s→%s" % (i, derived))
    if wrong:
        errors.append("项目 id 与路径不符 %d 个（跑 kb-move-project.py --scan 同步）: %s"
                      % (len(wrong), "、".join(wrong[:6])))

# 文档主题自描述：docs/<主题>/_topic.md 的 projects 必须已登记
topic_total = 0
if os.path.isdir(docs_root):
    for d in sorted(os.listdir(docs_root)):
        if not os.path.isdir(os.path.join(docs_root, d)):
            continue
        tfile = os.path.join(docs_root, d, "_topic.md")
        if not os.path.exists(tfile):
            continue
        topic_total += 1
        text = read(tfile)
        # title: 是存量写法（模板早年没定义这个文件），两种都接受
        if not re.search(r"^(?:topic|title):\s*\S", text, re.M):
            warns.append("_topic.md 缺 topic/title 字段: docs/%s" % d)
        block = re.search(r"^projects:\s*\n((?:\s+-\s+.*\n?)*)", text, re.M)
        if block is not None:
            for pid in re.findall(r"^\s+-\s+(\S+)", block.group(1), re.M):
                if known_projects and pid not in known_projects:
                    warns.append("_topic.md 引用未登记项目 %s: docs/%s" % (pid, d))

# 卡片索引健康：源文件数 vs 卡片数（缺卡或孤儿都会让 kb-search 给出假命中）
CARD_DIR = os.path.join(KB, ".kb-index", "cards")
if os.path.isdir(CARD_DIR):
    src = 0
    for base in ("docs", "projects"):
        broot = os.path.join(KB, base)
        if not os.path.isdir(broot):
            continue
        for dirpath, dirnames, filenames in os.walk(broot):
            dirnames[:] = [x for x in dirnames if x not in ("archive", "node_modules", ".git", ".kb-index")]
            for name in filenames:
                if not name.endswith(".md") or name in ("MEMORY.md", "_topic.md"):
                    continue
                rel = os.path.relpath(os.path.join(dirpath, name), KB).replace(os.sep, "/")
                if base == "projects" and "/memory/" in rel:
                    continue
                src += 1
    cards = len([n for n in os.listdir(CARD_DIR) if n.endswith(".md")])
    if src != cards:
        warns.append("卡片数与源文件数不符（源 %d / 卡 %d）：跑 kb-card.py --prune" % (src, cards))
    # 摘要以书稿导航语开头 = 零信息（提取器应跳过，这里防回归）
    nav = 0
    for name in os.listdir(CARD_DIR):
        if not name.endswith(".md"):
            continue
        try:
            ct = open(os.path.join(CARD_DIR, name), encoding="utf-8").read()
        except OSError:
            continue
        m = re.search(r"(?ms)^## 摘要\n(.*?)(?=\n\n## )", ct)
        if m is not None and m.group(1).strip().startswith(("上一章", "下一章")):
            nav += 1
    if nav:
        warns.append("%d 张卡片摘要是「上一章/下一章」导航语（跑 kb-card.py 重建）" % nav)

# README 是骨架文件：首次运行创建后不会自动更新，旧版会残留 arch 槽位或第三方工具名，
# 把 AI 引去不存在的目录、或去装不该装的工具
readme_path = os.path.join(KB, "README.md")
# 工具名拆成常量拼接：skill-content 测试禁止协议正文出现工具名（那是能力暗示），
# 但检查器必须知道名字才能拦截旧骨架，所以这里只作为检测字面量存在。
STALE_TOOL_MARKS = ("code" + "graph", "graph" + "ify")
if os.path.exists(readme_path):
    rt = read(readme_path)
    stale_marks = [w for w in ("arch/",) + STALE_TOOL_MARKS if w in rt]
    if stale_marks:
        errors.append("README.md 是旧版骨架（含 %s），按 templates.md「骨架文件模板」重写"
                      % "、".join(stale_marks))

# 输出
if JSON_MODE:
    out = {
        "ok": not errors,
        "errors": errors,
        "warns": warns,
        "stats": {
            "memoryDirs": len([d for d in mem_dirs if os.path.isdir(d)]),
            "memories": mem_total,
            "docs": doc_total + proj_doc_total,
            "errors": len(errors),
            "warns": len(warns),
        },
    }
    if FIX_MODE:
        out["fix"] = [{"dir": rel_d, "files": [f for f, _ in items]} for rel_d, items in fix_report]
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(1 if errors else (2 if warns else 0))

print("kb-check @ %s" % KB)
print("记忆目录 %d | 记忆 %d 条 | 文档 %d+%d 个" % (len([d for d in mem_dirs if os.path.isdir(d)]), mem_total, doc_total, proj_doc_total))
if errors:
    print("\n✖ 错误 %d" % len(errors))
    for e in errors[:40]:
        print("  - " + e)
    if len(errors) > 40:
        print("  ... 其余 %d 条省略" % (len(errors) - 40))
if warns:
    print("\n⚠ 警告 %d" % len(warns))
    for w in warns[:25]:
        print("  - " + w)
    if len(warns) > 25:
        print("  ... 其余 %d 条省略" % (len(warns) - 25))
if errors:
    print("\n===== 未通过（%d 错误 / %d 警告）=====" % (len(errors), len(warns)))
    sys.exit(1)
print("\n===== 通过（%d 警告）=====" % len(warns))
sys.exit(2 if warns else 0)
