#!/usr/bin/env python3
"""项目改名 / 移动的同步工具。

id 规则：id = 能保证唯一的最短路径后缀（每段 kebab 化，多段用 - 连接）。
移动项目后必须跑本工具，一次性更新 paths.yaml、projects/ 目录、项目页 frontmatter、
全库引用与卡片索引；不允许只手改 paths.yaml。

三段式用法：
  kb-move-project.py <kb_root> --scan --plan plan.json          只分析，生成计划，不动盘
  kb-move-project.py <kb_root> --from-path A --to-path B --plan plan.json
  kb-move-project.py <kb_root> --apply --plan plan.json         执行（计划须与现状一致）

不带 --plan 时只打印，不写文件。--apply 必须配 --plan。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import time

CJK = r"\u4e00-\u9fff"
HEAD_RE = re.compile(r"^([A-Za-z0-9_" + CJK + r"][\w" + CJK + r"-]*):\s*$")


def kebab(seg):
    s = seg.strip().lower()
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"[^0-9a-z" + CJK + r"-]+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "project"


def read_text(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read()


def write_text(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def parse_paths(text):
    """极简 paths.yaml 解析：只认 id 行与缩进的 path / git_remote。"""
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


def derive_ids(entries):
    """按「最短唯一路径后缀」给每条算 id。返回 {旧 id: 新 id}。"""
    segs = {e["id"]: [kebab(x) for x in e["path"].split("/") if x] for e in entries}
    out = {}
    for pid, parts in segs.items():
        k = 1
        chosen = None
        while k <= len(parts):
            suffix = "-".join(parts[-k:])
            clashes = [o for o, p in segs.items() if "-".join(p[-k:]) == suffix]
            if len(clashes) == 1:
                chosen = suffix
                break
            k += 1
        out[pid] = chosen if chosen is not None else "-".join(parts)
    return out


def md_files(kb_root):
    hits = []
    for base in ("projects", "docs", "memory"):
        root = os.path.join(kb_root, base)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in ("archive", ".kb-index", "__pycache__")]
            for name in filenames:
                if name.endswith(".md"):
                    hits.append(os.path.relpath(os.path.join(dirpath, name), kb_root))
    return sorted(hits)


def bare_re(old_id):
    """裸 id 边界：只用 ASCII 词字符判断，中文相邻不算粘连。"""
    return re.compile(r"(?<![0-9A-Za-z_-])" + re.escape(old_id) + r"(?![0-9A-Za-z_-])")


def find_refs(kb_root, old_id):
    """引用 = projects/<id>/ 路径，或独立的裸 id（_topic.md、子项目表、笔记正文）。"""
    needle = "projects/" + old_id + "/"
    rx = bare_re(old_id)
    out = []
    for rel in md_files(kb_root):
        try:
            text = read_text(os.path.join(kb_root, rel))
        except OSError:
            continue
        if needle in text or rx.search(text):
            out.append(rel)
    return out


def build_plan(kb_root, moves, kind):
    plan = {
        "version": 1,
        "kind": kind,
        "kb_root": os.path.abspath(kb_root),
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "moves": [],
    }
    for m in moves:
        plan["moves"].append({
            "id_old": m["id_old"],
            "id_new": m["id_new"],
            "path_old": m["path_old"],
            "path_new": m["path_new"],
            "dir_old": "projects/" + m["id_old"],
            "dir_new": "projects/" + m["id_new"],
            "page_old": "projects/%s/%s.md" % (m["id_old"], m["id_old"]),
            "page_new": "projects/%s/%s.md" % (m["id_new"], m["id_new"]),
            "ref_files": find_refs(kb_root, m["id_old"]),
        })
    blob = json.dumps(plan["moves"], ensure_ascii=False, sort_keys=True)
    plan["fingerprint"] = hashlib.sha256(blob.encode("utf-8")).hexdigest()
    return plan


def apply_plan(kb_root, plan_path):
    plan = json.loads(read_text(plan_path))
    moves = plan.get("moves") or []
    if not moves:
        print("计划里没有改动")
        return 0
    blob = json.dumps(moves, ensure_ascii=False, sort_keys=True)
    if hashlib.sha256(blob.encode("utf-8")).hexdigest() != plan.get("fingerprint"):
        print("✖ 计划指纹不匹配（文件被改过），拒绝执行")
        return 2

    for m in moves:
        src = os.path.join(kb_root, m["dir_old"])
        dst = os.path.join(kb_root, m["dir_new"])
        if not os.path.isdir(src):
            print("✖ 源目录不存在，计划已过期: " + m["dir_old"])
            return 2
        if os.path.exists(dst):
            print("✖ 目标目录已存在，拒绝覆盖: " + m["dir_new"])
            return 2

    backup_dir = os.path.join(kb_root, ".backup")
    os.makedirs(backup_dir, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(backup_dir, stamp + ".tar.gz")
    with tarfile.open(backup, "w:gz") as tar:
        for name in ("paths.yaml", "projects", "memory", "docs"):
            p = os.path.join(kb_root, name)
            if os.path.exists(p):
                tar.add(p, arcname=name)
    print("备份: " + backup)

    staged = []
    for m in moves:
        src = os.path.join(kb_root, m["dir_old"])
        tmp = src + ".__mv__"
        os.rename(src, tmp)
        staged.append((m, tmp))
    for m, tmp in staged:
        os.rename(tmp, os.path.join(kb_root, m["dir_new"]))

    for m in moves:
        new_page = os.path.join(kb_root, m["page_new"])
        old_page = os.path.join(kb_root, m["dir_new"], m["id_old"] + ".md")
        if os.path.exists(old_page):
            text = read_text(old_page)
            text = re.sub(r"(?m)^title:.*$", "title: " + m["id_new"], text, count=1)
            text = re.sub(r"(?m)^project_id:.*$", "project_id: " + m["id_new"], text, count=1)
            write_text(new_page, text)
            if os.path.abspath(old_page) != os.path.abspath(new_page):
                os.remove(old_page)

    replaced = 0
    for m in moves:
        old_path = "projects/" + m["id_old"] + "/"
        new_path = "projects/" + m["id_new"] + "/"
        rx = bare_re(m["id_old"])
        for rel in m["ref_files"]:
            # 目录已改名：本项目自己的引用要用新路径打开
            if rel.startswith(m["dir_old"] + "/"):
                rel = m["dir_new"] + rel[len(m["dir_old"]):]
            p = os.path.join(kb_root, rel)
            if not os.path.isfile(p):
                continue
            text = read_text(p)
            updated = text.replace(old_path, new_path)
            updated = rx.sub(m["id_new"], updated)
            if updated != text:
                write_text(p, updated)
                replaced += 1

    paths_file = os.path.join(kb_root, "paths.yaml")
    lines = read_text(paths_file).split("\n")
    bmap = {m["id_old"]: m for m in moves}
    out = []
    cur = None
    for line in lines:
        m = HEAD_RE.match(line)
        if m and m.group(1) in bmap:
            cur = bmap[m.group(1)]
            out.append(cur["id_new"] + ":")
            continue
        if m:
            cur = None
        if cur is not None:
            pm = re.match(r"^(\s+path:\s*)(.+?)\s*$", line)
            if pm:
                out.append(pm.group(1) + cur["path_new"])
                continue
        out.append(line)
    write_text(paths_file, "\n".join(out))

    print("完成 %d 个项目，替换引用 %d 处" % (len(moves), replaced))

    here = os.path.dirname(os.path.abspath(__file__))
    card_tool = os.path.join(here, "kb-card.py")
    if os.path.exists(card_tool):
        subprocess.run([sys.executable, card_tool, kb_root, "--prune"], check=False)
    check_tool = os.path.join(here, "kb-check.py")
    if os.path.exists(check_tool):
        subprocess.run([sys.executable, check_tool, kb_root], check=False)
    return 0


def main(argv):
    ap = argparse.ArgumentParser(description="项目改名/移动同步工具（默认只分析）")
    ap.add_argument("kb_root")
    ap.add_argument("--scan", action="store_true", help="按当前 paths.yaml 算目标 id")
    ap.add_argument("--from-path")
    ap.add_argument("--to-path")
    ap.add_argument("--plan", help="计划文件路径；--apply 时必需")
    ap.add_argument("--apply", action="store_true", help="执行计划（必须配 --plan）")
    args = ap.parse_args(argv)

    kb_root = os.path.abspath(os.path.expanduser(args.kb_root))
    if not os.path.isdir(kb_root):
        print("✖ 知识库不存在: " + kb_root)
        return 2

    if args.apply:
        if not args.plan:
            print("✖ --apply 必须配 --plan")
            return 2
        return apply_plan(kb_root, args.plan)

    paths_file = os.path.join(kb_root, "paths.yaml")
    if not os.path.isfile(paths_file):
        print("✖ 缺 paths.yaml")
        return 2
    entries = parse_paths(read_text(paths_file))

    if args.from_path and args.to_path:
        target_old = os.path.abspath(os.path.expanduser(args.from_path))
        target_new = os.path.abspath(os.path.expanduser(args.to_path))
        hit = next((e for e in entries if os.path.abspath(os.path.expanduser(e["path"])) == target_old), None)
        if hit is None:
            print("✖ paths.yaml 里没有这个路径: " + target_old)
            return 2
        for e in entries:
            if e["id"] == hit["id"]:
                e["path"] = target_new
        ids = derive_ids(entries)
        moves = [{
            "id_old": hit["id"],
            "id_new": ids[hit["id"]],
            "path_old": hit["path"],
            "path_new": target_new,
        }]
        plan = build_plan(kb_root, moves, "move")
    else:
        ids = derive_ids(entries)
        moves = [{
            "id_old": e["id"],
            "id_new": ids[e["id"]],
            "path_old": e["path"],
            "path_new": e["path"],
        } for e in entries if ids[e["id"]] != e["id"]]
        plan = build_plan(kb_root, moves, "scan")

    print("计划 %d 项（%s）" % (len(plan["moves"]), plan["kind"]))
    for m in plan["moves"]:
        flag = "移动" if m["path_old"] != m["path_new"] else "改名"
        print("  %-4s %-28s → %-28s  引用 %d 处" % (flag, m["id_old"], m["id_new"], len(m["ref_files"])))
    if args.plan:
        target = os.path.abspath(os.path.expanduser(args.plan))
        write_text(target, json.dumps(plan, ensure_ascii=False, indent=2) + "\n")
        print("计划已写入: " + target)
    else:
        print("（未写文件；加 --plan 保存后，用 --apply --plan 执行）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
