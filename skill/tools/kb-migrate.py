#!/usr/bin/env python3
"""一次性迁移：把项目页里的工具产物段落去掉，保留人工内容。

删除：engines 字段、符号数表、graphify 英文问句、占位符行、工具提示行。
替换：「怎么查这个项目」整节改成纯 grep 三行。
保留：人工写的「中文概念 → 位置」条目、目录结构、项目资料、正文。

用法：
    python3 kb-migrate.py [KB_ROOT] [--apply]    # 默认 dry-run
"""

import os
import re
import sys

FENCE = chr(96) * 3

QUERY_SECTION = (
    "## 怎么查这个项目\n\n"
    + FENCE + "bash\n"
    + "# 1. 先查知识库\n"
    + 'grep -rn "<中文关键词>" <KB_ROOT>/projects/{pid}/\n'
    + "\n"
    + "# 2. 再查源码（本机路径从 paths.yaml 取）\n"
    + 'grep -rn "<中文关键词>" "<本机路径>" --include="*.js" --include="*.ts" --include="*.py"\n'
    + "\n"
    + "# 3. 命中后读文件确认行号\n"
    + FENCE + "\n\n"
    + "> **新鲜度**：本页只存变化慢的信息。符号/关系等快变信息不写——查询前现读源码。\n"
)


def drop_engines(text):
    return re.sub(r"(?m)^engines:.*\n(?:[ \t]+.*\n)*", "", text)


def drop_table_by_header(text, needle):
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        if lines[i].startswith("|") and needle in lines[i]:
            while i < len(lines) and lines[i].startswith("|"):
                i += 1
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def drop_table_rows(text, needle):
    kept = [l for l in text.split("\n") if not (l.startswith("|") and needle in l)]
    return "\n".join(kept)


def replace_query_section(text, pid):
    pattern = r"(?ms)^## 怎么查这个项目\n.*?(?=^## |\Z)"
    return re.sub(pattern, QUERY_SECTION.format(pid=pid), text, count=1)


def fix_verification(text):
    for old, new in (
        ("（验证方式：codegraph）", "（验证：读文件）"),
        ("（验证方式：grep）", "（验证：读文件）"),
        ("（验证方式：codegraph / grep）", "（验证：读文件）"),
        ("（codegraph 验证）", "（验证：读文件）"),
        ("（grep 验证）", "（验证：读文件）"),
    ):
        text = text.replace(old, new)
    return text


def drop_tool_notes(text):
    kept = []
    for line in text.split("\n"):
        s = line.strip()
        if s.startswith(">") and ("codegraph" in s or "graphify" in s):
            continue
        kept.append(line)
    return "\n".join(kept)


def collapse_blank(text):
    return re.sub(r"\n{3,}", "\n\n", text)


def clean_empty_tables(text):
    """表头 + 分隔行后没有数据行的表格 → 换成一句占位。"""
    lines = text.split("\n")
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if (
            line.startswith("|")
            and i + 1 < len(lines)
            and re.match(r"^\|[\s\-:|]+\|$", lines[i + 1])
        ):
            j = i + 2
            if j >= len(lines) or not lines[j].startswith("|"):
                out.append("（待补充）")
                i = j
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


def clean_empty_sections(text):
    """只有标题、没有正文的节 → 删掉。"""
    return re.sub(r"(?ms)^## [^\n]+\n(?=\n*## |\s*\Z)", "", text)


def migrate(text, pid):
    changes = []
    if re.search(r"(?m)^engines:", text):
        changes.append("engines")
    text = drop_engines(text)
    if re.search(r"见 graphify 报告对应章节", text):
        changes.append("graphify-rows")
    text = drop_table_rows(text, "见 graphify 报告对应章节")
    if "codegraph query" in text:
        changes.append("placeholder")
    text = drop_table_rows(text, "codegraph query")
    if re.search(r"^\| 文件 \| 符号数", text, re.M):
        changes.append("symbol-table")
    text = drop_table_by_header(text, "符号数")
    if "## 怎么查这个项目" in text:
        changes.append("query-section")
    text = replace_query_section(text, pid)
    text = fix_verification(text)
    text = drop_tool_notes(text)
    text = re.sub(r"(?m)^(?:codegraph|graphify):.*\n", "", text)
    text = re.sub(r"(?m)^.*(?:codegraph sync|\.codegraph 建过索引).*\n", "", text)
    text = text.replace("无 codegraph 索引", "")
    text = re.sub(r"(?ms)^## 查询指引\n.*?(?=^## |\Z)", "", text)
    text = clean_empty_tables(text)
    text = clean_empty_sections(text)
    text = collapse_blank(text)
    return text, changes


def main(argv):
    paths = [a for a in argv[1:] if not a.startswith("--")]
    kb = os.path.abspath(os.path.expanduser(paths[0] if paths else "~/.local-kb"))
    apply = "--apply" in sys.argv
    root = os.path.join(kb, "projects")
    total = 0
    touched = 0
    for pid in sorted(os.listdir(root)):
        page = os.path.join(root, pid, pid + ".md")
        if not os.path.exists(page):
            continue
        total += 1
        text = open(page, encoding="utf-8").read()
        new, changes = migrate(text, pid)
        if new == text:
            continue
        touched += 1
        print("%-28s %s" % (pid, ",".join(changes) if changes else "cleanup"))
        if apply:
            with open(page, "w", encoding="utf-8") as fh:
                fh.write(new)
    print("")
    print("项目页 %d，需改 %d%s" % (total, touched, "（已写入）" if apply else "（dry-run）"))


if __name__ == "__main__":
    main(sys.argv)