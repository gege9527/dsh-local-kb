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


CARD_SKIP_DIRS = {".kb-index", "archive", "node_modules", ".git"}


def iter_docs(kb_root):
    """与 kb-card.py 同一套枚举规则：doc 卡片对应 docs/ 与 projects/<id>/docs/。"""
    for base in ("docs", "projects"):
        root = os.path.join(kb_root, base)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in CARD_SKIP_DIRS]
            for name in filenames:
                if not name.endswith(".md") or name in ("MEMORY.md", "_topic.md"):
                    continue
                full = os.path.join(dirpath, name)
                rel = os.path.relpath(full, kb_root)
                if base == "projects":
                    parts = rel.split("/")
                    if len(parts) == 3 and parts[2] == parts[1] + ".md":
                        continue
                    if "/memory/" in rel:
                        continue
                yield rel, full


def slug_of(rel):
    import re as _re
    stem = rel[:-3] if rel.endswith(".md") else rel
    return _re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "-", stem).strip("-")


def detect_stale(kb_root, cards_dir):
    """卡片缺失或比源文档旧 → 返回计数。查询前自检，避免拿旧摘要作答。"""
    missing = 0
    stale = 0
    for rel, full in iter_docs(kb_root):
        card = os.path.join(cards_dir, slug_of(rel) + ".md")
        try:
            if not os.path.exists(card):
                missing += 1
            elif os.path.getmtime(card) < os.path.getmtime(full):
                stale += 1
        except OSError:
            continue
    return missing, stale


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

    missing, stale = detect_stale(kb_root, cards_dir)
    if missing or stale:
        parts = []
        if missing:
            parts.append("缺卡 %d 篇" % missing)
        if stale:
            parts.append("过期 %d 篇" % stale)
        print(
            "# 卡片索引需更新（%s）：python3 %s <KB_ROOT>"
            % ("，".join(parts), os.path.join(os.path.dirname(__file__), "kb-card.py")),
            file=sys.stderr,
        )

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
