# 笔记模板（纯标准 Markdown）

**只写标准 Markdown**：不用 `[[wikilink]]`、不用 `[!callout]`、不用 `.base`。
链接一律用标准 `[文本](相对路径)`。frontmatter 用简单 YAML 子集（裸值或引号包裹；列表用 `- ` 项，不用 `>-` 折叠标量）。

## 代码项目主页

路径：`<KB_ROOT>/projects/<project_id>/<project_id>.md`

```md
---
title: <项目名>
type: code-project
description: <一句话说清干什么>
aliases:
  - <中文别名1>
  - <中文别名2>
project_id: <kebab-case 稳定ID｜中文目录原样>
git_remote: <git 地址，无则 none>
# 可选：查询例外（默认命令在常驻规则里，只有与本项目不同才写）
# search_roots: [子目录]              # 只在这个子目录里搜
# search_exclude: [额外排除目录]        # 追加到默认排除集
# search_projects: [其他项目 id]        # 要一起搜的其他项目
indexed_at: "YYYY-MM-DD"
tags:
  - code-kb
---

> **速览**
> 项目ID：`<project_id>`
> 本机路径：见 `paths.yaml`（`/local-kb paths`）
> 技术栈：<语言分布摘要>
> 定位前现读源码确认——本页只存变化慢的信息

## 这是什么

<3–5 句，必须回答两件事：>
<- 解决什么问题——项目存在的理由，不是复述名字>
<- 边界：用什么 / 不用什么（例：「没用 AirPlay、没越狱、不需要 Xcode」）>
<禁止一句话或只复述项目名结束（实测 14/31 曾 <60 字）>

## 目录结构

```text
<一级目录>/      <一句话职责>
```

> 每个一级目录都要带职责；**禁止只列名字用「·」连接**（实测 17/31 这么写过，等于没写）。

## 项目资料

| 资料 | 位置 | 内容 |
|---|---|---|
| 产出文档 | `docs/<文件名>` | 分析/方案/报告（若存在，逐个列出） |
| 记忆 | `memory/MEMORY.md` | 项目级记忆索引（若存在，标条数） |

> 只列**实际存在**的条目；一节都没有就不写本节。这节是 AI 发现项目内文档/记忆的唯一入口——漏写等于隐形。

## 中文概念 → 位置

| 想找什么 | 去哪 |
|---|---|
| <用户会用的中文说法> | <相对文件路径>:<行号>（验证：读文件） |

> 每条都必须命中并打开文件确认行号才写；没验证过的不写。

## 关键文件

| 文件 | 说明 |
|---|---|
| <相对路径> | <这个文件是什么> |

> 只列入口文件与 README 点名的文件；**少于 3 行就删掉本节**——空表比没有更误导。

> **新鲜度**：本页只存变化慢的信息。符号/关系等快变信息不写——查询前现读源码。
> 查询命令不写进本页：默认命令在常驻规则 `references/agents-snippet.md`（每轮注入），
> 项目例外写在 frontmatter 的 `search_roots` / `search_exclude` / `search_projects`，inject 每轮带出。
```

## 文档页

路径：项目产出物 → `<KB_ROOT>/projects/<project_id>/docs/<文档名>.md`；通用文档 → `<KB_ROOT>/docs/<文档名>.md`（多文件文档集 → `<归属目录>/<文档集名>/…`）

```md
---
title: "<文档标题>"
type: doc
source: "<本地文件绝对路径或粘贴来源说明>"
date_added: "YYYY-MM-DD"
last_checked: "YYYY-MM-DD"  # 可选：最近一次回源核对；没回源过不写
local_edits: false          # 可选：本地加工过（清洗/补图）；覆写前必须提示
aliases:                 # 可选：用户可能用的俗称，命中即置顶
  - <2~12 字的说法>
tags:
  - docs
---

<正文：AI 转换后的干净 Markdown，保留标题层级>
```

## 文档主题声明

文档集目录（≥2 篇 md）**必须**有 `_topic.md`：声明主题、服务哪些项目。
插件每轮注入时据此在「相关文档」列出该主题；`kb-check` 校验字段、存在性与项目引用。

路径：`<KB_ROOT>/docs/<主题>/_topic.md`

```md
---
topic: "<主题名>"          # 必须与目录名一致
summary: "<一句话：这个主题收集什么>"
projects:                  # 已登记的项目 id；通用主题写 []
  - <project_id>
---
```

正文不写内容：标题、summary、服务项目都已在 frontmatter 里，重复一遍只会漂移。

## 记忆文件

路径：全局 `<KB_ROOT>/memory/<slug>.md` 或 项目 `<KB_ROOT>/projects/<project_id>/memory/<slug>.md`

```md
---
name: <kebab-case-slug>            # 记忆 slug 固定英文（索引/检索标识符）；中文含义放 description/aliases
description: <一句话钩子——召回时靠它判断是否打开>
type: user | feedback | project | reference
status: active | completed | archived   # 仅 project 可带；active = 当前活跃任务（每目录最多一条）
                                        # 触发条件见 references/memory.md「active 写入时机」
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

<正文>

<feedback / project 类型尽量带：>
Why: <为什么>
How to apply: <下次怎么用>
```

记忆索引（`MEMORY.md`）只放指针行；活跃任务的指针行加 `⚡`：

```md
## user
- [一句话名片](slug.md) — description 钩子

## project
- [⚡ 恢复迁移：修 serializer 测试](repair-serializer.md) — active；阻塞：prod 表锁
- [登录改版已完成](login-revamp.md) — completed
```

## 骨架文件模板（首次运行 / 换设备新装时创建）

### README.md

```md
# 知识库（local-kb）

给 AI 用的纯文件知识库。根 `<KB_ROOT>/`（默认 `~/.local-kb/`，`KB_ROOT` 环境变量可覆盖；Windows 隐藏：`attrib +h`）。

## 结构

\`\`\`text
<KB_ROOT>/
  README.md      本文件
  paths.yaml     项目 ID → 本机路径 + git_remote（唯一路径来源）
  memory/        全局记忆，MEMORY.md 为索引
  docs/          跨项目文档；多文件集才建子目录 + _topic.md
  projects/<id>/ <id>.md 项目页 · docs/ · memory/
  archive/       归档（只移入，不删除）
  .kb-index/     卡片索引（生成物，不同步，可整目录删）
\`\`\`

## 检索（按顺序）

1. 项目 / 文档：`python3 <技能目录>/tools/kb-search.py "关键词"`，按置信分级取用，weak 别当答案。
   裸 grep 限定 `projects/` 与 `docs/`，排除 `archive/`。
2. 代码位置：项目页「中文概念 → 位置」→ `paths.yaml` 取路径 → grep 源码 → 读文件确认行号。
3. 记忆：先读对应 `MEMORY.md` 索引，只开钩子相关的笔记，别批量读正文。

## 写入铁律

- 路径只写 `paths.yaml`，笔记、索引、项目页里不出现绝对路径。
- 一事实一文件，frontmatter 必填 `name/description/type/created/updated`；type ∈ user|feedback|project|reference。
- 索引只放指针：一行一个笔记，不搬正文。上限 200 行 / 25 KB，超了先压缩或归档。
- 只归档不删除：`mv` 进根层 `archive/`，同时删索引行；物理删除只由用户做。
- 可由源码机械再生的产物（调用图、符号表、依赖清单）不入库——代码一变就失效。
- 存前先问：换会话还用得上吗？repo/README 已写的不重复存，只存指针。

## 工具（技能 `tools/`）

| 脚本 | 用途 |
|---|---|
| `kb-search.py` | 检索，带置信分级 |
| `kb-card.py` | 生成 / 更新卡片索引；`--prune` 清孤儿 |
| `kb-check.py` | 体检；`--fix --write` 补缺失索引 |
| `kb-move-project.py` | 项目移动 / 改名的原子迁移 |
| `kb-add-project.py` | 新项目一条命令建档：推导 id、写 paths、建目录与索引 |
| `kb-archive-project.py` | 项目整体归档到 `archive/projects/`：删登记、改引用、清卡片 |
| `kb-archive-note.py` | 单条记忆归档到 `archive/`：删索引行 |

写入后跑 `kb-check.py`；增删文档后跑 `kb-card.py --prune`。

## 换设备

同步本目录 → 把 `paths.yaml` 的 `path` 改成新机器路径 → 缺失项目先问用户是否克隆；同意才按 `git_remote` 克隆，否则标缺失。
```

### paths.yaml

```yaml
# project_id -> local path mapping (the only place paths live in local-kb)
#
# syntax:
#   <project_id>:
#     path: <absolute local path>
#     git_remote: <url | none>
#
# Device switch / project move: edit only this file, notes stay untouched.
# Manage with: /local-kb paths
```

### 全局记忆索引 memory/MEMORY.md

```md
# Global Memory Index

> Pointer index for memory/ — pointers only, content lives in linked files.
> Soft cap: ~100 entries (compress/archive past that).
> Protocol: local-kb references/memory.md
```

（项目级 `memory/MEMORY.md` 用同样头部，路径改为项目记忆目录。）
