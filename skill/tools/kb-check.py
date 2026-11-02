#!/usr/bin/env python3
"""kb-check — local-kb 知识库校验闸门（零依赖，Python 3.9+）

用法:
    python3 kb-check.py [KB_ROOT] [--json]   # 默认 ~/.local-kb；--json 输出结构化结果

退出码:
    0 = 全部通过
    1 = 有错误（写入方不得声称成功）
    2 = 仅警告

检查:
    记忆  frontmatter 五字段 / type 枚举 / name 与文件名一致 / 无 title|project_id
          索引指针 ↔ 文件一致（无越界 ../、无断指针、无漏索引）/ 时效词警告
          索引上限守卫（150 行/20KB 软 → 警告，200 行/25KB 硬 → 错误）
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
        name = field(fm, "name")
        if name and name != f[:-3]:
            errors.append("记忆 name 与文件名不一致(%s≠%s): %s" % (name, f[:-3], rel))
        if field(fm, "title") or field(fm, "project_id"):
            errors.append("记忆含协议外字段(title/project_id): %s" % rel)
        if st == "active":
            active_count += 1
        if STALE.search(text) and t in ("user", "feedback", "project"):
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
        if f not in idx:
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
    return n


def check_doc(p, project_doc=False):
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
KB = os.path.abspath(os.path.expanduser(ARGV[0] if ARGV else "~/.local-kb"))
PROJECT_ROOT_ROOT = os.path.join(KB, "projects")
GLOBAL_MEM_ROOT = os.path.join(KB, "memory")
if not os.path.isdir(KB):
    if JSON_MODE:
        print(json.dumps({"ok": False, "errors": ["KB_ROOT 不存在: %s" % KB], "warns": [], "stats": {}}, ensure_ascii=False))
    else:
        print("kb-check: KB_ROOT 不存在: %s" % KB)
    sys.exit(1)

# 记忆
mem_dirs = [GLOBAL_MEM_ROOT]
if os.path.isdir(PROJECT_ROOT_ROOT):
    for d in sorted(os.listdir(PROJECT_ROOT_ROOT)):
        sub = os.path.join(PROJECT_ROOT_ROOT, d, "memory")
        if os.path.isdir(sub):
            mem_dirs.append(sub)
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
if os.path.exists(yp):
    for line in read(yp).splitlines():
        if re.match(r"\s+path:\s*$", line):
            errors.append("paths.yaml 有空 path 值")

# 输出
if JSON_MODE:
    print(json.dumps({
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
    }, ensure_ascii=False))
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
