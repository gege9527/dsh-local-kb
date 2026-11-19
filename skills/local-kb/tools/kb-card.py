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

# 默认知识库根：与环境变量保持一致（插件侧也读 KB_ROOT）
DEFAULT_KB = os.environ.get("KB_ROOT") or "~/.local-kb"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kb_common import CARD_DIR, CARD_VERSION, frontmatter, iter_docs, read_version, slug_of, version_path

SUMMARY_CHARS = 200
SUMMARY_MIN = 40  # 摘要短于此值时继续累加后续段落（引用块开头的文档常只剩"行记录"这种残句）


QUOTE_META = re.compile(r"^\*\*[^*]{1,24}\*\*[:：]?")
NAV_CHAPTER = re.compile(r"上一章|下一章")


def quote_text(block):
    """引用块的正文：剥掉行首 >，跳过 **info** / **分类**: 这类元数据行。"""
    kept = []
    for line in block.split("\n"):
        text = line.lstrip().lstrip(">").strip()
        if not text or QUOTE_META.match(text) or text.startswith("#"):
            continue
        kept.append(text)
    return " ".join(kept)


def first_paragraph(body, meta=None):
    """摘要回退链：frontmatter summary/description → 引用块正文 → 正文段落（不足则累加）。

    旧实现直接跳过以 > 开头的块，而文档模式产出的正文第一块正是 > **info** 引用块，
    导致 AirScript 那类文档的卡片摘要退化成"行记录"这类残句。
    """
    meta = meta or {}
    for key in ("summary", "description"):
        value = " ".join((meta.get(key) or "").split())
        if value:
            return value[:SUMMARY_CHARS]
    picked = []
    size = 0
    for block in re.split(r"\n\s*\n", body):
        s = block.strip()
        if not s or s.startswith("#") or s.startswith("|"):
            continue
        if s.startswith(">"):
            text = quote_text(s)
            if not text:
                continue
        else:
            text = re.sub(r"\s+", " ", s)
            if text.startswith("\x60\x60\x60"):
                continue
        # 书稿常见「上一章：X 下一章：Y」导航段：对检索零信息，跳过继续取下一段
        if text.lstrip().startswith(("上一章", "下一章")) or NAV_CHAPTER.search(text[:30]):
            continue
        picked.append(text)
        size += len(text)
        if size >= SUMMARY_MIN:
            break
    return " ".join(picked)[:SUMMARY_CHARS]


def sections(body, offset):
    out = []
    for i, line in enumerate(body.split("\n")):
        m = re.match(r"^##\s+(.+?)\s*$", line)
        if m:
            # offset 已是 body 第一行的真实行号，不要再 +1（旧实现多算一行）
            out.append((m.group(1), offset + i))
    return out





def read_aliases(text):
    """别名取多种写法：aliases: a, b / aliases: [a, b] / YAML 多行 - a 换 - b。
    项目页一直用多行列表，只认单行会把已有别名全部读丢。"""
    m = re.search(r"^aliases:[ \t]*(.*)$", text, re.M)
    if not m:
        return []
    rest = m.group(1).strip()
    if rest and rest not in ("|", ">"):
        return [x.strip().strip("'\"") for x in re.split(r"[,、]", rest.strip("[]")) if x.strip()]
    out = []
    tail = text[m.end():]
    for line in tail.split("\n"):
        if not line.strip():
            continue
        mm = re.match(r"^[ \t]+-[ \t]*(.+)$", line)
        if mm:
            out.append(mm.group(1).strip().strip("'\""))
            continue
        break
    return out


FILE_TOKEN = re.compile(r"([A-Za-z0-9_./-]+\.(?:js|mjs|ts|tsx|vue|py|kt|java|html|sh|json|md|go|rs|swift|css))(?::\d+)?")


def table_rows(text, heading):
    """取某个二级标题下 Markdown 表格的数据行（已去掉表头与分隔行）。"""
    m = re.search(r"(?ms)^## " + re.escape(heading) + r"[^\n]*\n(.*?)(?=^## |\Z)", text)
    if not m:
        return []
    rows = []
    for line in m.group(1).split("\n"):
        if not line.startswith("|") or "---" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if not cells or cells[0] in ("想找什么", "概念", "文件", ""):
            continue
        rows.append(cells)
    return rows


def project_terms(text):
    """项目页的检索词：概念（第一列）+ 文件路径（概念表位置列与关键文件表）+ 额外关键词列。"""
    concepts, paths, extras = [], [], []
    for cells in table_rows(text, "中文概念"):
        if len(cells) < 2:
            continue
        if len(cells[0]) <= 30:
            concepts.append(cells[0])
        for token in FILE_TOKEN.findall(cells[1]):
            name = token.replace("\\", "/").split("/")[-1]
            if name not in paths:
                paths.append(name)
        for cell in cells[2:]:
            for part in re.split(r"[,，、/\s]+", cell):
                part = part.strip().strip("\u0060")
                if part and len(part) <= 24 and part not in extras:
                    extras.append(part)
    for cells in table_rows(text, "关键文件"):
        for cell in cells[:1]:
            for token in FILE_TOKEN.findall(cell):
                name = token.replace("\\", "/").split("/")[-1]
                if name not in paths:
                    paths.append(name)
            plain = cell.strip().strip("\u0060").strip()
            if plain and not FILE_TOKEN.fullmatch(plain) and "/" not in plain and len(plain) <= 40:
                if plain not in paths:
                    paths.append(plain)
    return concepts[:12], paths[:16], extras[:8]


def build_card(kb_root, rel, full):
    text = open(full, encoding="utf-8", errors="replace").read()
    meta, body = frontmatter(text)
    offset = text[: len(text) - len(body)].count("\n") + 1
    title = meta.get("title", "").strip('"') or os.path.basename(rel)[:-3]
    summary = first_paragraph(body, meta)
    secs = sections(body, offset)
    desc = " ".join((meta.get("description") or "").split())
    alias = ", ".join(read_aliases(text))
    lines = [
        "---",
        "doc: " + rel,
        "title: " + title,
        "type: card",
        "card: %d" % CARD_VERSION,
    ]
    # 别名与钩子单独成行：检索端给中间权重（不是标题权重），避免宽泛描述误伤排序
    if desc:
        lines.append("desc: " + desc)
    if alias:
        lines.append("alias: " + alias)
    lines += [
        "---",
        "",
        "## 摘要",
        summary or "（无正文段落）",
    ]
    # 项目页的小节是固定模板（这是什么/目录结构/项目资料…），对检索与导航都没有信息量；
    # 长文档的小节才是有效目录。只给非项目页输出「## 小节」。
    parts = rel.replace(os.sep, "/").split("/")
    is_project_page = len(parts) == 3 and parts[0] == "projects" and parts[2] == parts[1] + ".md"
    if is_project_page:
        # 项目页的固定小节没有信息量；换成页面里真正的检索线索：
        # 概念表第一列（收录）、第三列（关键词）、以及概念/关键文件里的文件名（路径）。
        concepts, paths, extras = project_terms(text)
        if concepts:
            lines.append("")
            lines.append("## 收录")
            for key in concepts:
                lines.append("- " + key)
        if extras:
            lines.append("")
            lines.append("## 关键词")
            lines.append("- " + "、".join(extras))
        if paths:
            lines.append("")
            lines.append("## 路径")
            for key in paths:
                lines.append("- " + key)
    else:
        lines.append("")
        lines.append("## 小节")
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
    kb_root = os.path.expanduser(argv[1] if len(argv) > 1 and not argv[1].startswith("-") else DEFAULT_KB)
    check_only = "--check" in argv
    prune = "--prune" in argv
    force = "--force" in argv
    out_dir = os.path.join(kb_root, CARD_DIR)
    full_rebuild = force or read_version(out_dir) != CARD_VERSION
    count = 0
    missing = 0
    stale = 0
    written = 0
    expected = set()
    for rel, full in iter_docs(kb_root):
        count += 1
        slug = slug_of(rel) + ".md"
        expected.add(slug)
        path = os.path.join(out_dir, slug)
        # 增量：卡片不存在、比源文档旧、或格式版本变了才重写（旧实现每次全量重写 447 篇）。
        need = full_rebuild or not os.path.exists(path) or os.path.getmtime(path) < os.path.getmtime(full)
        if check_only:
            if not os.path.exists(path):
                missing += 1
            elif need:
                stale += 1
            continue
        if not need:
            continue
        os.makedirs(out_dir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(build_card(kb_root, rel, full))
        written += 1
    if check_only:
        if read_version(out_dir) != CARD_VERSION:
            print("文档 %d，卡片版本需重建（当前 %s，期望 %d）" % (count, read_version(out_dir), CARD_VERSION))
            sys.exit(1)
        print("文档 %d，缺卡 %d，过期 %d" % (count, missing, stale))
        sys.exit(1 if (missing or stale) else 0)
    removed = 0
    if prune and os.path.isdir(out_dir):
        for name in os.listdir(out_dir):
            if name.endswith(".md") and name not in expected:
                try:
                    os.remove(os.path.join(out_dir, name))
                    removed += 1
                except OSError:
                    pass
    # 版本落盘：卡片格式变了（比如开始收录 desc/alias），检索端据此整库重建一次
    try:
        with open(version_path(out_dir), "w", encoding="utf-8") as fh:
            fh.write(str(CARD_VERSION) + "\n")
    except OSError:
        pass
    print("文档 %d，写卡 %d，清孤儿 %d → %s" % (count, written, removed, out_dir))


if __name__ == "__main__":
    main(sys.argv)
