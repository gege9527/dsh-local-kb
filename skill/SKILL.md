---
name: local-kb
description: >-
  独立知识库。把代码项目与本地文档存入纯 Markdown 文件知识库，供 AI 检索定位与长期记忆，
  纯本地文件、无 MCP / 第三方服务。触发词：存进知识库、加入知识库、保存这个文档、
  保存这个项目、查某功能在哪个代码位置、查…实现、找…逻辑/代码/位置、…在哪、功能怎么实现、
  知识库里有什么、记住、别忘了、我之前说过。
---

# local-kb — 独立知识库 + 长期记忆

一个技能、**两个存储**：知识库 `<KB_ROOT>/` 存项目索引与文档正文（给人检索），
内嵌记忆（全部在知识库目录内，**永不写到源项目**）：全局 `<KB_ROOT>/memory/`、
项目级 `<KB_ROOT>/projects/<id>/memory/`。全部是 Markdown 文件 + 一个路径映射，
零服务依赖。**同一套策展纪律管两者。记忆路径永远带 `<KB_ROOT>/` 前缀。**

**本技能只做一件事：告诉 AI 用什么工具、按什么流程查询和保存。**
不安装、不校验、不替代任何工具。检索全部走文件系统：grep / read / find / git。

**工具是加速器，不是前置依赖。** 缺失不阻塞流程：探测 → 提示用户自行安装 → 继续 → 按 AI 现有能力降级。
工具在 → 保存/查询更精细快；工具缺 → 仍保存 AI 能确证的内容，绝不硬编未验证数据。

## 操作边界

- 所有读写走文件系统，只用本技能的 KB_ROOT。
- 不修改任何其他技能、宿主配置文件或既有笔记库。
- 与其他触发词重叠的技能并存时，互不干扰。

## 能力边界

本技能提供**文件级定位**：某功能在哪个文件、哪个目录、哪段文档。
不提供**调用关系与影响面分析**——那需要语言级解析，超出文件检索范围。
判断改动影响时：同文件 grep 调用 + 跑项目测试，以测试结果为准。

## KB_ROOT — 知识库根

- 默认：`~/.local-kb/`（解析为 `$HOME/.local-kb/`，主目录根下隐藏目录，跨设备同一相对路径）
  Windows：路径同为 `%USERPROFILE%\.local-kb`，需隐藏可执行 `attrib +h`
- 覆盖：环境变量 `KB_ROOT`（绝对路径）。覆盖时校验存在且可写。
- 首次运行：目录不存在则按 `references/templates.md` 的「骨架文件模板」创建 README.md、paths.yaml、memory/MEMORY.md。
- 结构（首次运行自动创建缺失目录）：

```
<KB_ROOT>/
  README.md                    # 检索指引（给 AI 看）
  paths.yaml                   # 项目ID → 本机路径 + git_remote（路径唯一存放处）
  memory/                      # 全局记忆（user / 全局 feedback / reference）
  docs/                        # 通用/跨项目文档（扁平；多文件文档集才建子目录）
  projects/                    # 代码项目（活跃）
    <project_id>/
      <project_id>.md          # 项目主页
      arch/<project_id>-arch.md  # 架构摘要
      docs/                    # 项目产出文档（分析/方案/报告）
      memory/                  # 项目级记忆（project / 本项目 reference）
  archive/                     # 归档（不删除）：离线的项目、文档、记忆都放这里
    projects/<project_id>/     # 归档的项目（整体移入）
    docs/<文档集>/              # 归档的文档集
    memory/<slug>.md           # 归档的记忆笔记
    projects/<project_id>/memory/<slug>.md  # 归档的项目记忆
```

所有目录名与文件名一律用英文/拼音/ASCII。

## 路由：先判断输入类型

| 输入 | 模式 |
|---|---|
| `http://` / `https://` 开头 | **拒绝**：本技能不收网页，提示先保存为本地文件 |
| 本地文件（md/txt/html/docx/odt/pdf/csv 等） | 文档模式 |
| 用户直接粘贴的内容 | 文档模式 |
| 目录，含代码特征（`.git` / `package.json` / `src` / `*.py` / `*.js` / `go.mod`…） | **代码模式** |
| 目录，纯文档 | 文档模式（批量） |

代码模式 → 加载 `references/code-project.md`；文档模式 → `references/doc-archive.md`。

## 检索方式

全部走文件系统，零工具依赖：

| 用途 | 做法 |
|---|---|
| 知识库内部检索（中文别名、文档、记忆） | `grep -rn "<关键词>" <KB_ROOT>/projects/*/*.md <KB_ROOT>/docs/` |
| 大库检索（文档多、正文长） | `python3 <技能目录>/tools/kb-search.py "<关键词>"`——卡片定位篇，再按行号读原文 |
| 代码定位（"X 功能在哪 / 怎么实现"） | 先 grep KB → 再 grep 源码 → 读文件确认行号 |
| 元数据提取（语言分布、关键文件） | 读 README / package.json + 列目录 + `git ls-files` |
| **知识库自检** | `python3 <技能目录>/tools/kb-check.py [KB_ROOT]`；带 `--fix` 预览补索引，加 `--write` 落盘 |

技能不安装、不探测、不依赖任何第三方工具。AI 若有更强的检索能力可自行使用，
但技能流程必须能在纯文件系统下完成。

`kb-search` 需要卡片索引（首次或文档变更后建一次）：

```bash
python3 <技能目录>/tools/kb-card.py <KB_ROOT>       # 生成卡片
python3 <技能目录>/tools/kb-search.py "<关键词>" --rebuild   # 建索引并检索
```

## 动作清单

| 动作 | 说明 |
|---|---|
| add <路径/目录> [别名…] | 存入（自动路由） |
| list | 列出已有条目（读 README.md / 列目录） |
| show <名> | 查看条目（读对应笔记） |
| refresh <名> | 刷新（代码重新索引 / 文档重新读取源文件） |
| alias <名> <别名…> | 追加中文别名（改 frontmatter） |
| paths | 查看/更新 paths.yaml |
| remove <名> | **归档**条目（移入 archive/ + 标记，**不删除**） |

所有动作的详细步骤见 `references/actions.md`。

记忆不设命令。自然语言触发（"记住 XXX"、"我之前说过…吗"、"别忘了"、"继续/上次/接着做"）→ **必须先读
`references/memory.md` 全文**，按协议执行召回/写入：frontmatter 五字段（name/description/type/created/updated，
type 限 user/feedback/project/reference，project 按触发条件带 status: active|completed|archived）+ 补 MEMORY.md 指针；
会话接续靠 `status: active` 记忆（每目录最多一条，写前走接管协议，索引行加 `⚡`）；写完过一遍「写入自检」清单。

**写前先判类型（强制，不能跳）**：用户要「下次接着干」→ `type: project` + `status: active` + 索引行 `⚡`；
要「下次查资料」→ `type: reference`，不写 status、不加 ⚡。
判错的典型后果：把进行中的任务写成 reference，索引行没有 ⚡，下个会话不会自动打开，恢复点丢失。

**active 不是可选项**：任务跨会话 / 改了 ≥3 个文件 / 上下文到 60%（任一命中）→ 立刻建或更新 active，
条件与写法见 memory.md「active 写入时机」。不建 active 的长任务 = 超限后无法接续。

### 用户说「把这个项目加进知识库」

1. 确认路径与项目 id（与已有 id 重名 → 加父前缀，如 `oa-ai-excel-form-designer`）。
2. 读结构（`package.json` / `pom.xml` / 顶层目录），写项目页 `projects/<id>/<id>.md`。
3. 在 `paths.yaml` 登记 `id → path`。
4. 报告：已建档（写了哪些文件、概念表几条）。

用户没这么说、只是在一个未入库目录里干活时：**不自动建档**，按普通检索处理。

## 上下文将满（≥60%）先落盘

上下文用到约 60% 时，插件会**提示落盘并给出具体步骤**，但只在任务未完成时才写——做完的会话直接跳过，
不要为了满足提示而制造记忆。收到它、或自己判断"这轮可能聊不完"时，按顺序：

1. 有 active → 就地更新（目标 / 当前状态 / 阻塞 / 下一步），不新建第二条；
2. 无 active → 新建一条 `type: project` + `status: active`，索引行加 `⚡`，走接管协议；
3. 跑 `python3 <技能目录>/tools/kb-check.py`；
4. **再继续任务**。

**落盘优先于继续**：被压缩或超限后丢的是对话，不是笔记。反过来说，落盘晚了就等于没落。

## 铁律

1. 所有读写走**文件系统**（read/write/bash），绝不用任何 MCP 工具。
2. **任何代码/项目/文档/记忆查询，先查知识库，再查源项目或网络**：未 grep `<KB_ROOT>/` 前，不得调用 `web_search`、`bash` 全局 grep、读 node_modules/源码等全局搜索。
3. 写任何笔记前读 `references/templates.md` 全文，按模板写，不凭记忆编 frontmatter。
4. 项目路径**不写进笔记**——只在 `paths.yaml`。项目页存 `project_id` 与 `git_remote`（无则 `none`）。
5. 代码模式项目页只存变化慢的信息（描述/结构/概念→位置）。快变信息不写，查询前现读源码确认。
6. 不覆盖用户已有笔记，除非明确要求。
7. 绝不动源项目目录里的任何文件；只读。
8. 记忆文件遵循 `references/memory.md`：不存凭据，不重述代码已告诉的内容。
9. 本技能不写任何 .gitignore（由用户决定版本控制范围）。
10. **文档归属**：内容属于某已入库项目 → 归 `<KB_ROOT>/projects/<project_id>/docs/`；
   跨项目/通用文档才落 `<KB_ROOT>/docs/`。判断不了先问用户，不猜。
11. **只归档不删除**：知识库内容永不物理删除（`rm`/`rm -rf`）；下线走 `remove` 归档到 `archive/`，
    物理删除由用户手动执行。流程见 `references/actions.md`。
12. **写入后必跑校验**：
    ```bash
    python3 <技能目录>/tools/kb-check.py [KB_ROOT]
    ```
    退出码非 0（有错误）→ 报告并修正，**不得声称写入成功**。
    漏了索引指针时用 `--fix` 补：默认只预览要追加什么，`--fix --write` 才落盘。
    它只追加缺失的指针行（`- [name](file.md)` 占位，描述留给你补），**不改任何已有行**。

## 完成报告

每次操作后回报：模式（代码/文档/记忆）、写入的笔记路径、校验结果、下一步可用操作。

## 维护

- 项目页会过期：定位前重新读源码确认，别信页面里记的行号。
- 工具后装：库里的降级产物不会自动升级，用 `refresh <名>` 重跑；多处降级时批量提示用户。
- **KB_ROOT 是数据不是代码**：默认根在用户主目录隐藏目录（`~/.local-kb/`），技能更新/重装不会覆盖它。
  换设备时同步该目录即可；`KB_ROOT` 环境变量可指向任意位置。
- 新增文档类型：在 `references/doc-archive.md` 的转换表加一行。
- 换设备：同步 KB_ROOT（含 paths.yaml）→ 改 paths.yaml 指向新设备路径 →
  缺失项目按 git_remote 克隆或标记缺失。详见 `references/code-project.md` 末节。
- 常驻块 = `references/agents-snippet.md`：改动后必须同步 `~/.dsh/AGENTS.md`
  的 KB_LOCAL 块（**只取 START..END，不带尾部注释**）与 `SKILLS/local-kb/` 副本。
