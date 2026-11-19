#!/usr/bin/env python3
"""kb-archive-note — 把一条记忆笔记移入 archive/ 并删掉它的索引行（只归档，不删除）。

行为对齐上游 engramory：文件移入 archive/、删索引行；recall 不扫 archive，所以归档即退出召回。
  - 全局记忆：memory/<slug>.md → archive/memory/<slug>.md
  - 项目记忆：projects/<id>/memory/<slug>.md → archive/projects/<id>/memory/<slug>.md
  - 对应 MEMORY.md 里指向该笔记的指针行一并删除（含 ⚡ 行；不留归档指针，指针只能指向本目录）

用法:
  kb-archive-note.py <KB_ROOT> --path <笔记路径> [--apply | --dry-run] [--no-check]

默认 dry-run；--apply 才写盘。恢复：mv 回来 + 补索引行。

退出码: 0 = 完成；1 = 写入失败；2 = 拒绝（路径不合法/目标冲突）
"""

import argparse
import os
import re
import shutil
import subprocess
import sys


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def locate(rel, kb_root):
    """把笔记路径归到 (记忆目录相对路径, slug, 归档目标相对路径)；不合法返回 None。"""
    rel = rel.strip().replace(os.sep, "/")
    if rel.startswith("./"):
        rel = rel[2:]
    if not rel.endswith(".md") or rel.endswith("MEMORY.md"):
        return None
    slug = os.path.basename(rel)
    m = re.match(r"^projects/([^/]+)/memory/([^/]+)$", rel)
    if m:
        return ("projects/%s/memory" % m.group(1), slug, "archive/projects/%s/memory/%s" % (m.group(1), slug))
    m = re.match(r"^memory/([^/]+)$", rel)
    if m:
        return ("memory", slug, "archive/memory/%s" % slug)
    return None


def drop_pointer(text, slug):
    """删掉指向 slug 的指针行；返回 (新文本, 删掉的行数)。"""
    kept = []
    removed = 0
    needle = "](" + slug + ")"
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("-") and needle in stripped:
            removed += 1
            continue
        kept.append(line)
    return "\n".join(kept), removed


def main(argv):
    ap = argparse.ArgumentParser(description="归档一条记忆笔记")
    ap.add_argument("kb_root")
    ap.add_argument("--path", required=True, help="笔记路径（相对知识库根，或绝对路径）")
    ap.add_argument("--apply", action="store_true", help="真正写盘；不带时只打印计划")
    ap.add_argument("--dry-run", action="store_true", help="显式 dry-run（默认行为）")
    ap.add_argument("--no-check", action="store_true", help="结束时不跑 kb-check")
    args = ap.parse_args(argv)

    kb_root = os.path.realpath(os.path.expanduser(args.kb_root))
    if not os.path.exists(os.path.join(kb_root, "paths.yaml")):
        print("不是知识库根（缺 paths.yaml）: %s" % kb_root, file=sys.stderr)
        return 2

    raw = args.path
    if os.path.isabs(raw):
        raw = os.path.relpath(raw, kb_root)
    where = locate(raw, kb_root)
    if where is None:
        print("只支持记忆笔记：memory/<slug>.md 或 projects/<id>/memory/<slug>.md → %s" % raw, file=sys.stderr)
        return 2
    mem_dir, slug, target_rel = where
    src = os.path.join(kb_root, mem_dir, slug)
    target = os.path.join(kb_root, target_rel)
    index = os.path.join(kb_root, mem_dir, "MEMORY.md")
    if not os.path.exists(src):
        print("笔记不存在: %s" % os.path.join(mem_dir, slug), file=sys.stderr)
        return 2
    if os.path.exists(target):
        print("归档目标已存在，拒绝覆盖: %s" % target_rel, file=sys.stderr)
        return 2

    text, removed = drop_pointer(read_text(index), slug) if os.path.exists(index) else ("", 0)
    print("归档 %s → %s" % (os.path.join(mem_dir, slug), target_rel))
    print("索引行: %s" % (("删除 %d 行" % removed) if removed else "（索引里没有该指针）"))

    if not args.apply:
        print("（dry-run：未写文件。加 --apply 执行）")
        return 0

    os.makedirs(os.path.dirname(target), exist_ok=True)
    try:
        shutil.move(src, target)
    except OSError as error:
        print("移动失败: %s" % error, file=sys.stderr)
        return 1
    if removed:
        write_text(index, text)

    print("已归档：%s" % target_rel)
    print("恢复：mv %s %s，再补回索引行" % (target_rel, os.path.join(mem_dir, slug)))

    if args.no_check:
        return 0
    check = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kb-check.py")
    if not os.path.exists(check):
        return 0
    return subprocess.call([sys.executable, check, kb_root])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
