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
SKIP_DIRS = {".kb-index", "archive", "node_modules", ".git"}


def frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end]
    meta = {}
    for line in block.split("\n"):
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if m:
            meta[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return meta, text[end + 4:]


def first_paragraph(body):
    for block in re.split(r"\n\s*\n", body):
        s = block.strip()
        if not s or s.startswith("#") or s.startswith(">") or s.startswith("|"):
            continue
        s = re.sub(r"\s+", " ", s)
        return s[:SUMMARY_CHARS]
    return ""


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


def build_card(kb_root, rel, full):
    text = open(full, encoding="utf-8").read()
    meta, body = frontmatter(text)
    offset = text[: len(text) - len(body)].count("\n") + 1
    title = meta.get("title", "").strip('"') or os.path.basename(rel)[:-3]
    summary = first_paragraph(body)
    secs = sections(body, offset)
    lines = [
        "---",
        "doc: " + rel,
        "title: " + title,
        "type: card",
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
    print("文档 %d，写卡 %d，清孤儿 %d → %s" % (count, written, removed, out_dir))


if __name__ == "__main__":
    main(sys.argv)
