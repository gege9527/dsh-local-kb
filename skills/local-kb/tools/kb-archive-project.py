#!/usr/bin/env python3
"""kb-archive-project — 把项目整体归档到 archive/projects/<id>/（只归档，不删除）。

行为：文件移入 archive/、删掉索引与登记，不在项目页或正文留「已归档」标记：
  1. projects/<id>/ 整体移入 archive/projects/<id>/
  2. 删 paths.yaml 条目（不留归档注释段）
  3. 全库把 projects/<id>/ 改写为 archive/projects/<id>/
  4. kb-card.py --prune 清卡片（归档内容不再进检索）
  5. kb-check.py 校验

归档后可手工恢复：mv archive/projects/<id> projects/<id>，再补回 paths.yaml 条目。
本工具不做 restore。

用法:
  kb-archive-project.py <KB_ROOT> --id <id> [--note 原因] [--apply | --dry-run] [--no-check]

默认 dry-run（只打印计划）；--apply 才写盘。

退出码:
  0 = 完成；1 = 写入或校验失败；2 = 拒绝（参数/目标冲突）
"""

import argparse
import datetime
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {".kb-index", ".backup", ".git", "node_modules", "__pycache__", "dist", "build"}


def read_text(path):
    with open(path, encoding="utf-8", errors="replace") as fh:
        return fh.read()


def write_text(path, text):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def strip_paths_entry(text, pid):
    """删掉 paths.yaml 里 pid 的整个条目（id 行 + 缩进的 path / git_remote），保留其它行与空行。"""
    out = []
    skipping = False
    head = re.compile(r"^%s:\s*$" % re.escape(pid))
    for line in text.split("\n"):
        if skipping:
            if line.startswith((" ", "\t")) and line.strip():
                continue
            skipping = False
        if head.match(line):
            skipping = True
            continue
        out.append(line)
    return "\n".join(out)


def md_files(kb_root):
    hits = []
    for dirpath, dirnames, filenames in os.walk(kb_root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            if name.endswith(".md"):
                hits.append(os.path.relpath(os.path.join(dirpath, name), kb_root))
    return sorted(hits)


def ref_pattern(pid):
    """projects/<id>/ 的引用；排除已经是 archive/projects/<id>/ 的写法，避免二次加前缀。"""
    return re.compile(r"(?<!archive/)" + re.escape("projects/" + pid + "/"))


def main(argv):
    ap = argparse.ArgumentParser(description="把项目整体归档到 archive/projects/<id>/")
    ap.add_argument("kb_root")
    ap.add_argument("--id", required=True, help="项目 id（paths.yaml 或 projects/ 下的目录名）")
    ap.add_argument("--note", default="", help="归档原因（只打印，不写盘）")
    ap.add_argument("--apply", action="store_true", help="真正写盘；不带时只打印计划")
    ap.add_argument("--dry-run", action="store_true", help="显式 dry-run（默认行为）")
    ap.add_argument("--no-check", action="store_true", help="结束时不跑 kb-check")
    args = ap.parse_args(argv)

    kb_root = os.path.realpath(os.path.expanduser(args.kb_root))
    paths_file = os.path.join(kb_root, "paths.yaml")
    if not os.path.exists(paths_file):
        print("不是知识库根（缺 paths.yaml）: %s" % kb_root, file=sys.stderr)
        return 2

    pid = args.id.strip()
    if not pid or "/" in pid:
        print("id 必须是单段项目名，不带路径: %s" % pid, file=sys.stderr)
        return 2

    src = os.path.join(kb_root, "projects", pid)
    dst = os.path.join(kb_root, "archive", "projects", pid)
    if not os.path.isdir(src):
        print("projects/%s 不存在（可能已归档）" % pid, file=sys.stderr)
        return 2
    if os.path.exists(dst):
        print("archive/projects/%s 已存在，拒绝覆盖" % pid, file=sys.stderr)
        return 2

    paths_text = read_text(paths_file)
    has_entry = re.search(r"(?m)^%s:\s*$" % re.escape(pid), paths_text) is not None
    ref_rx = ref_pattern(pid)
    hits = []
    for rel in md_files(kb_root):
        try:
            if ref_rx.search(read_text(os.path.join(kb_root, rel))):
                hits.append(rel)
        except OSError:
            continue

    today = datetime.date.today().isoformat()
    print("归档 projects/%s/ → archive/projects/%s/" % (pid, pid))
    print("paths.yaml 条目: %s" % ("删除" if has_entry else "（本来就没有）"))
    print("改写引用: %d 个文件%s" % (len(hits), ("（" + "、".join(hits[:6]) + "）") if hits else ""))
    print("卡片: 归档后 prune")
    print("归档日期: %s%s" % (today, ("; 原因: " + args.note) if args.note else ""))

    if not args.apply:
        print("（dry-run：未写文件。加 --apply 执行）")
        return 0

    backup_dir = os.path.join(kb_root, ".backup")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(backup_dir, "%s-archive-%s.tar.gz" % (stamp, pid))
    n = 1
    while os.path.exists(backup):
        n += 1
        backup = os.path.join(backup_dir, "%s-archive-%s-%d.tar.gz" % (stamp, pid, n))
    try:
        with tarfile.open(backup, "w:gz") as tar:
            tar.add(paths_file, arcname="paths.yaml")
            tar.add(src, arcname=os.path.join("projects", pid))
    except OSError as error:
        print("备份失败，中止: %s" % error, file=sys.stderr)
        return 1
    print("备份: " + backup)

    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
    except OSError as error:
        print("移动失败（备份在 %s）: %s" % (backup, error), file=sys.stderr)
        return 1

    if has_entry:
        write_text(paths_file, strip_paths_entry(paths_text, pid))

    changed = 0
    for rel in hits:
        full = os.path.join(kb_root, rel)
        try:
            text = read_text(full)
        except OSError:
            continue
        new = ref_rx.sub("archive/projects/%s/" % pid, text)
        if new != text:
            write_text(full, new)
            changed += 1

    tools = os.path.dirname(os.path.abspath(__file__))
    card = os.path.join(tools, "kb-card.py")
    if os.path.exists(card):
        subprocess.run([sys.executable, card, kb_root, "--prune"], capture_output=True, text=True)

    print("已归档：projects/%s → archive/projects/%s（引用改写 %d 个文件）" % (pid, pid, changed))
    print("恢复：mv archive/projects/%s projects/%s，再补回 paths.yaml 条目" % (pid, pid))

    if args.no_check:
        return 0
    check = os.path.join(tools, "kb-check.py")
    if not os.path.exists(check):
        return 0
    return subprocess.call([sys.executable, check, kb_root])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
