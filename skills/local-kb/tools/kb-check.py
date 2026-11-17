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
    路径  paths.yaml 条目格式
"""
import json
import os
import re
import sys

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

# paths.yaml
yp = os.path.join(KB, "paths.yaml")
known_projects = set()
if os.path.exists(yp):
    for line in read(yp).splitlines():
        if re.match(r"\s+path:\s*$", line):
            errors.append("paths.yaml 有空 path 值")
        m = re.match(r"^([A-Za-z0-9_.-]+):\s*$", line)
        if m:
            known_projects.add(m.group(1))

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
        if not re.search(r"^topic:\s*\S", text, re.M):
            warns.append("_topic.md 缺 topic 字段: docs/%s" % d)
        block = re.search(r"^projects:\s*\n((?:\s+-\s+.*\n?)*)", text, re.M)
        if block is not None:
            for pid in re.findall(r"^\s+-\s+(\S+)", block.group(1), re.M):
                if known_projects and pid not in known_projects:
                    warns.append("_topic.md 引用未登记项目 %s: docs/%s" % (pid, d))

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
