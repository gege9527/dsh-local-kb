#!/usr/bin/env python3
"""知识库检索：卡片命中 → 原文行定位。

两段式：卡片层（摘要 + 小节标题）先缩到几篇，再在原文里 grep 出具体行。
输出控制在 1~2K token，不返回整章正文。

用法：
    python3 kb-search.py "<关键词>" [KB_ROOT] [--limit N] [--rebuild]
"""

import os
import re
import sqlite3
import sys

CARD_DIR = ".kb-index/cards"
DB_PATH = ".kb-index/index.db"
MAX_HITS_PER_DOC = 3
SNIPPET_CHARS = 110


def frontmatter(text):
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    meta = {}
    for line in text[3:end].split("\n"):
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if m:
            meta[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return meta, text[end + 4:]


def rebuild(db, cards_dir):
    con = sqlite3.connect(db)
    con.execute("DROP TABLE IF EXISTS cards")
    con.execute("CREATE VIRTUAL TABLE cards USING fts5(doc UNINDEXED, title, body, tokenize='trigram')")
    rows = []
    for name in sorted(os.listdir(cards_dir)):
        if not name.endswith(".md"):
            continue
        text = open(os.path.join(cards_dir, name), encoding="utf-8").read()
        meta, body = frontmatter(text)
        rows.append((meta.get("doc", name), meta.get("title", name), body))
    con.executemany("INSERT INTO cards (doc, title, body) VALUES (?, ?, ?)", rows)
    con.commit()
    con.close()
    return len(rows)


def query_rows(db, term, limit):
    con = sqlite3.connect(db)
    try:
        if len(term) >= 3:
            sql = "SELECT doc, title, body FROM cards WHERE cards MATCH ? LIMIT ?"
            return con.execute(sql, (term, limit)).fetchall()
        sql = "SELECT doc, title, body FROM cards WHERE body LIKE ? OR title LIKE ? LIMIT ?"
        like = "%" + term + "%"
        return con.execute(sql, (like, like, limit)).fetchall()
    except sqlite3.OperationalError:
        return []
    finally:
        con.close()


def snippets(path, term, kb_root):
    hits = []
    try:
        lines = open(path, encoding="utf-8").read().split("\n")
    except OSError:
        return hits
    for i, line in enumerate(lines, 1):
        if term in line:
            hits.append((i, line.strip()[:SNIPPET_CHARS]))
            if len(hits) >= MAX_HITS_PER_DOC:
                break
    return hits


def main(argv):
    if len(argv) < 2:
        print("用法: kb-search.py \"<关键词>\" [KB_ROOT] [--limit N] [--rebuild]", file=sys.stderr)
        return 2
    term = argv[1]
    rest = [a for a in argv[2:] if not a.startswith("--")]
    kb_root = os.path.expanduser(rest[0] if rest else "~/.local-kb")
    limit = 5
    for i, a in enumerate(argv):
        if a == "--limit" and i + 1 < len(argv):
            limit = int(argv[i + 1])
    db = os.path.join(kb_root, DB_PATH)
    cards_dir = os.path.join(kb_root, CARD_DIR)

    if "--rebuild" in argv or not os.path.exists(db):
        n = rebuild(db, cards_dir)
        print("# 索引重建：%d 张卡片" % n, file=sys.stderr)

    rows = query_rows(db, term, limit)
    if not rows:
        print('未命中：%s' % term)
        return 0
    print("命中 %d 篇（关键词：%s）" % (len(rows), term))
    for idx, (doc, title, body) in enumerate(rows, 1):
        print("")
        print("%d. %s" % (idx, doc))
        if title and title not in doc:
            print("   标题：%s" % title)
        summary = ""
        for block in body.split("\n"):
            block = block.strip()
            if block and not block.startswith("#") and not block.startswith("-"):
                summary = block[:SNIPPET_CHARS]
                break
        if summary:
            print("   摘要：%s" % summary)
        for line, text in snippets(os.path.join(kb_root, doc), term, kb_root):
            print("   L%d: %s" % (line, text))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
