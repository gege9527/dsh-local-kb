#!/usr/bin/env python3
"""kb-add-project — 一条命令给代码项目建档。

id 规则与 kb-move-project.py / kb-check.py 完全一致：能保证唯一的最短路径后缀
（各段 kebab 化，多段用 - 连接）。本工具一次做完：
  1. 推导 id——按全库路径算唯一后缀，杜绝「父目录 + 目录名」的手写习惯
  2. 查重——同路径或同 git_remote 已登记时拒绝（属 refresh，不是新建）
  3. 追加 paths.yaml
  4. 建 projects/<id>/ 与 memory/MEMORY.md
  5. 生成项目页骨架（frontmatter 齐全；未验证内容明确写「待补充」）
  6. 跑 kb-check，退出码透传

用法:
  kb-add-project.py <KB_ROOT> --path <绝对路径> [--title 名称] [--description 一句话]
                    [--alias 别名]... [--git-remote URL] [--dry-run] [--no-check]

退出码:
  0 = 完成；1 = 校验失败；2 = 拒绝（路径不存在 / 重复登记 / id 冲突）
"""

import argparse
import datetime
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kb_common import kebab_seg, path_segments, shortest_unique_suffix

HEAD_RE = re.compile(r"^([A-Za-z0-9_\u4e00-\u9fff][\w\u4e00-\u9fff-]*):\s*$")


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def parse_paths(text):
    """极简 paths.yaml 解析：只认 id 行与缩进的 path / git_remote（与 kb-move 一致）。"""
    entries = []
    cur = None
    for line in text.split("\n"):
        m = HEAD_RE.match(line)
        if m:
            cur = {"id": m.group(1), "path": None, "git_remote": None}
            entries.append(cur)
            continue
        m = re.match(r"^\s+path:\s*(.+?)\s*$", line)
        if m and cur is not None:
            cur["path"] = m.group(1).strip("'\"")
            continue
        m = re.match(r"^\s+git_remote:\s*(.+?)\s*$", line)
        if m and cur is not None:
            cur["git_remote"] = m.group(1).strip("'\"")
    return [e for e in entries if e["path"]]


def norm_path(p):
    """路径归一：展开 ~、去掉尾部斜杠、解析软链，避免同一目录登记两次。"""
    return os.path.realpath(os.path.expanduser(p))


def git_remote_of(path):
    try:
        out = subprocess.run(["git", "-C", path, "remote", "get-url", "origin"],
                             capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return "none"
    url = (out.stdout or "").strip()
    return url or "none"


def one_line(text):
    """frontmatter 裸值：压成一行、去掉会破坏 YAML 的引号与结尾冒号。"""
    s = " ".join(str(text or "").split())
    return s.replace('"', "'").rstrip(":")


def page_text(pid, title, description, aliases, remote, today):
    desc = one_line(description)
    what = desc if len(re.sub(r"\s", "", desc)) >= 60 else ""
    if not what:
        parts = []
        if desc:
            parts.append(desc)
        parts.append("待补充：说清它解决什么问题、边界是什么（用什么 / 不用什么）。这节决定后续要不要读这一页。")
        what = "\n\n".join(parts)
    alias_block = "\n".join("  - " + one_line(a) for a in aliases)
    return """---
title: %s
type: code-project
description: %s
aliases:
%s
project_id: %s
git_remote: %s
indexed_at: "%s"
tags:
  - code-kb
---

> **速览**
> 项目ID：`%s`
> 本机路径：见 `paths.yaml`（`/local-kb paths`）
> 技术栈：待补充
> 定位前现读源码确认——本页只存变化慢的信息

## 这是什么

%s

## 项目资料

| 资料 | 位置 | 内容 |
|---|---|---|
| 记忆 | `memory/MEMORY.md` | 项目级记忆索引（0 条） |
""" % (title, desc or "待补充：一句话说清这个项目做什么", alias_block,
       pid, remote, today, pid, what)


def memory_index_text(pid):
    return ("# Memory Index — %s\n\n"
            "> Pointer index for projects/%s/memory/ — pointers only, content lives in linked files.\n"
            "> Protocol: local-kb references/memory.md\n") % (pid, pid)


def main(argv):
    ap = argparse.ArgumentParser(description="一条命令给代码项目建档")
    ap.add_argument("kb_root")
    ap.add_argument("--path", required=True, help="项目本机绝对路径")
    ap.add_argument("--title", help="项目名，默认目录名")
    ap.add_argument("--description", default="", help="一句话描述（≥60 字可免「待补充」提醒）")
    ap.add_argument("--alias", action="append", default=[], help="中文别名，可重复")
    ap.add_argument("--git-remote", help="git 地址；默认自动探测 origin，无则 none")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不写盘")
    ap.add_argument("--no-check", action="store_true", help="写完不跑 kb-check")
    args = ap.parse_args(argv)

    kb_root = norm_path(args.kb_root)
    paths_file = os.path.join(kb_root, "paths.yaml")
    if not os.path.exists(paths_file):
        print("不是知识库根（缺 paths.yaml）: %s" % kb_root, file=sys.stderr)
        return 2

    path = norm_path(args.path)
    if not os.path.isdir(path):
        print("路径不存在或不是目录: %s" % path, file=sys.stderr)
        return 2

    entries = parse_paths(read_text(paths_file))
    for e in entries:
        if norm_path(e["path"]) == path:
            print("该路径已登记为 %s（属刷新，不是新建）: %s" % (e["id"], path), file=sys.stderr)
            return 2

    remote = args.git_remote or git_remote_of(path)
    if remote and remote != "none":
        for e in entries:
            if e.get("git_remote") == remote:
                print("同 git_remote 已登记为 %s（属刷新，不是新建）: %s" % (e["id"], remote), file=sys.stderr)
                return 2

    existing_ids = {e["id"] for e in entries}
    new_parts = path_segments(path)
    siblings = [path_segments(e["path"]) for e in entries] + [new_parts]
    pid = shortest_unique_suffix(new_parts, siblings)
    if not pid:
        print("路径后缀与全部现有项目冲突，无法推导唯一 id: %s" % path, file=sys.stderr)
        return 2
    if pid in existing_ids:
        print("推导出的 id 已被其他路径占用: %s（先跑 kb-move-project.py --scan）" % pid, file=sys.stderr)
        return 2

    drifted = []
    for e in entries:
        old = shortest_unique_suffix(path_segments(e["path"]), siblings)
        if old and old != e["id"]:
            drifted.append("%s→%s" % (e["id"], old))

    title = one_line(args.title) or os.path.basename(path)
    aliases = args.alias or [os.path.basename(path)]
    today = datetime.date.today().isoformat()
    page_path = os.path.join(kb_root, "projects", pid, pid + ".md")
    mem_index = os.path.join(kb_root, "projects", pid, "memory", "MEMORY.md")

    print("id: %s（路径后缀 %d 段）" % (pid, pid.count("-") + 1))
    print("paths.yaml += %s → %s（git_remote: %s）" % (pid, path, remote))
    print("新建 projects/%s/%s.md" % (pid, pid))
    print("新建 projects/%s/memory/MEMORY.md" % pid)
    if drifted:
        print("注意：新增后这些已有 id 不再唯一，需跑 kb-move-project.py --scan: %s" % "、".join(drifted))
    if args.dry_run:
        print("（dry-run：未写文件）")
        return 0

    text = read_text(paths_file)
    if text and not text.endswith("\n"):
        text += "\n"
    text += "%s:\n  path: %s\n  git_remote: %s\n" % (pid, path, remote)
    write_text(paths_file, text)
    write_text(page_path, page_text(pid, title, args.description, aliases, remote, today))
    write_text(mem_index, memory_index_text(pid))

    print(""
          "已建档：projects/%s/%s.md\n"
          "下一步：用一句话补全「这是什么」（≥60 字），再按 code-project.md 步骤 2 补目录结构与概念表。"
          % (pid, pid))

    if args.no_check:
        return 0
    check = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kb-check.py")
    if not os.path.exists(check):
        return 0
    return subprocess.call([sys.executable, check, kb_root])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
