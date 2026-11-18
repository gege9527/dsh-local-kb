#!/usr/bin/env python3
"""kb_common — kb-card / kb-search 共用的卡片层实现。

为什么单拉一个文件：卡片枚举、slug、frontmatter 解析、格式版本原先在两个脚本里
各写一份，改一处漏一处（行号偏移就是那次分叉的产物）。检索端与建卡端必须用同一套
规则，否则卡片和检索对不上。

只依赖标准库；被同目录脚本 import（python3 tools/kb-card.py 时脚本目录在 sys.path[0]）。
"""

import os
import re

CARD_DIR = ".kb-index/cards"
VERSION_FILE = ".card-version"
# 4 = 多行 tags 进卡片（3 = 摘要回退链）。检索端按它判断整库重建。
CARD_VERSION = 4
SKIP_DIRS = {".kb-index", "archive", "node_modules", ".git"}


def version_path(cards_dir):
    """版本文件放 cards/ 的父目录：cards/ 只放卡片，列目录时不会被当成孤儿。"""
    return os.path.join(os.path.dirname(cards_dir), VERSION_FILE)


def read_version(cards_dir):
    """读卡片格式版本；没有文件或读不懂都当 0（触发一次整库重建）。"""
    try:
        with open(version_path(cards_dir), encoding="utf-8") as fh:
            return int(fh.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def frontmatter(text):
    """返回 (meta, body)。支持块标量（>- / |）与多行列表（tags / aliases）。"""
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
        if raw in (">", ">-", ">+", "|", "|-", "|+"):
            folded = []
            i += 1
            while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith((" ", "\t"))):
                if lines[i].strip():
                    folded.append(lines[i].strip())
                i += 1
            meta[key] = " ".join(folded)
            continue
        if raw == "":
            items = []
            j = i + 1
            while j < len(lines) and re.match(r"^\s+-\s+", lines[j]):
                items.append(re.sub(r"^\s+-\s+", "", lines[j]).strip().strip('"').strip("'"))
                j += 1
            if items:
                meta[key] = ", ".join(items)
                i = j
                continue
        meta[key] = raw.strip('"').strip("'")
        i += 1
    return meta, text[end + 4:]


def slug_of(rel):
    stem = rel[:-3] if rel.endswith(".md") else rel
    return re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", stem).strip("-")


def iter_docs(kb_root):
    """文档 = docs/ 与 projects/<id>/（含项目 docs 与项目页），排除记忆与 _topic。"""
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
                if base == "projects" and "/memory/" in rel.replace(os.sep, "/"):
                    continue
                yield rel, full
