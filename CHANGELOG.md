# Changelog

## 未发布

### 变更

- **技能剥离第三方工具**：`skill/` 下不再出现 codegraph / graphify——删掉工具指引表、
  探测与缺失流程、建索引步骤、架构页模板、`engines` 字段、项目页命令块。检索统一走
  `grep` / `read` / `git ls-files`；保留一句约束「AI 若有更强检索能力可自行使用，
  但流程必须能在纯文件系统下完成」。`code-project.md` 174→121 行，`templates.md` 243→194 行。
- **能力边界写进技能**：`SKILL.md` 新增「能力边界」——只做文件级定位，不做调用关系与影响面；
  判断改动影响靠同文件 grep + 跑测试。
- **技能内容守卫**：新增 `tests/skill-content.spec.mjs`（13 项）——工具名黑名单、SKILL.md 结构、
  模板字段纯净、常驻块版本、步骤编号连续、不用 wikilink。往技能里塞工具名会直接挂测试。
- **记忆召回顺序调整**：`inject.js` 改为项目段在前、全局段在后，全局段带一行定位说明
  （跨项目默认生效层）；注入头加「两级都扫」。删掉 `memory.md` 里「全局记忆是少数派」
  的降权措辞，召回步骤改为「项目 → 全局」两步。
- **文档检索**：新增 `tools/kb-card.py`（每篇文档一张卡：摘要 + 小节标题 + 行号）与
  `tools/kb-search.py`（FTS5 三段式：卡片定位篇 → 原文 grep 行号 → 输出片段）。
  实测单次检索 300~700 token；trigram 对 2 字词自动回落 LIKE。
- **知识网络**：`docs/<主题>/_topic.md` 声明该主题服务哪些项目；`inject.js` 的
  `relatedDocTopics` 读它，在知识地图里给当前项目列出「相关文档」。查项目时能看到
  `docs/DSH` 这类跨库文档，不再只查项目目录。
- **防绕过**：知识地图新增「已收录：<概念关键词>（先看项目页，别重复搜）」，
  从项目页概念表提取短句（≤30 字符，自动生成的英文问句会被过滤）。
- **内容迁移脚本** `scripts/kb-migrate.py`：一次性清理项目页里的 `engines` 字段、
  符号数表、graphify 英文问句、占位符、「怎么查」命令块、`查询指引` 节；
  空表格换成「（待补充）」，空节删除。可重复执行，默认 dry-run。
- **常驻块升到 `KB_LOCAL_VERSION: 6`**：记忆召回加「项目段和全局段都扫」与
  「全局 = 默认生效层」两条；边界段改为「不依赖任何第三方工具」。

### 新增

- **检索前自检卡片**：`kb-search` 每次查询先比对卡片与源文档的 mtime，缺卡或过期就提示
  `kb-card.py`（不自动重建，避免每次检索写 432 个文件）。
- **检索记忆层**：`kb-search` 一次返回文档命中 + 相关记忆正文；记忆层直接 grep
  （193 条 / 1.2M，实测 0.01s，不值得建索引）。排序：description 命中优先，正文按出现次数排。
- **项目关联表 `memory/_links.yaml`**：显式声明 A → B 的项目级关联，注入地图在 A 的上下文里
  列出 B 的记忆指针（最多 3 条），双向生效。不依赖项目 id 的短长——
  实测 193 条记忆里结构化引用只有 3 处、纯文本命中 47 条噪声，文本匹配不可用。
- **归档统一到根层**：技能结构图、模板骨架、`remove` 流程都改成 `archive/projects/<id>` 与
  `archive/docs/<文档集>`（原来是 `projects/archive/` + `docs/archive/`，两种规则）。
  放根层的理由：知识地图只扫 `projects/*`，根层归档天然不被当成项目；同步遍历整个 KB_ROOT，照样备份。
- **记忆归档也统一到根层**：`memory/archive/` 与 `projects/<id>/memory/archive/` 全部移到
  `archive/memory/`、`archive/projects/<id>/memory/`。`MEMORY.md` 不再留归档指针
  （指针只能指向本目录，归档在根层，留了就是断指针）。
- **生成物不参与同步**：`SYNC_EXCLUDE` 增加 `^\.kb-index/`（卡片 + FTS，约 2.4M）。
  `kb-search` 发现缺卡或过期时**自动重建**卡片与索引（`--no-auto` 可退回只提示），
  所以换设备后第一次检索就会补齐，不需要手动跑。

### 修复

- 长对话提示升级为可执行步骤：60% 阈值命中时注入的不再是空泛的「把值得留的写进 KB」，
  而是带条件的三步——任务未完成时写/更新 `status: active` 记忆、索引行加 `⚡`、跑
  `kb-check.py`；任务已完或只是一问一答则明确跳过，避免为满足提示而制造噪音记忆。
  每会话一次，拿不到 `tokenMeter` 或窗口时仍不出声。
- **注入自动标注活跃任务**：`memoryIndexText` 读项目记忆笔记 frontmatter 的
  `status: active`（只读前 512 字节，复用 mtime 缓存），给对应索引行自动加 `⚡`，
  并在索引头单列一行「当前活跃任务」。注入文本同时说明 ⚡ 只是接续锚点，
  其余记忆照常按钩子取舍——不是「只看活跃」。
- **技能协议补齐 active 生命周期**：`references/memory.md` 新增「active 写入时机（硬触发）」
  （跨会话 / 用户说继续 / 改 ≥3 文件或 ≥15 步 / 上下文 ≥60%）、索引 `⚡` 约定、
  「何时才降 completed」（会话结束不算完成）、无 active 时的冷启动兜底；
  `SKILL.md` 新增「上下文将满（≥60%）先落盘」；常驻块升到 `KB_LOCAL_VERSION: 5`。

## 0.2.0 — 2026-11-02

把知识库从「靠 AI 自觉」改成「插件确定性兜底」，并让远端成为本地的镜像。

### 新增

- **每轮注入记忆索引与知识地图**：全局 `memory/MEMORY.md` 与当前项目
  `projects/<id>/memory/MEMORY.md` 直接进 runtime context（`systemPrompt.context`，
  order 300/301，`interpolate:false`），按 80 行 / 8KB 截断并提示压缩；
  知识只注入「地图」——项目清单、当前项目概览、docs 目录名，不注入任何文档正文。
- **记忆索引硬上限**：`ctx.tools.guard` 在写入前同步判定，只拦「超过 200 行 / 25KB
  且比现在变大」，压缩写入放行。只守 `*/memory/MEMORY.md`。
- **禁止 AI 删除知识库内容**：拦截 `rm`/`unlink`/`shred`/`truncate`/`find -delete`
  与移出 KB 的 `mv`；KB 内部移动进 `archive/` 放行。物理删除只能由用户做。
- **WebDAV 镜像同步**：PUT 变化文件后递归 PROPFIND 远端，删除本地没有的文件；
  排除 `.DS_Store`/`._*`/`*.tmp`/`Thumbs.db`/状态文件。
- **同步状态分片**：`$DSH_HOME/local-kb/state/<hash>/` 按目录分片，只写变化的那片；
  旧 `.kb-sync-state.json` 只读迁移、不删除。
- **长对话提醒**：上下文用到 60%（`reminderPressure` 可配）时提醒一次
  「把值得长期留的写进 KB」，每会话一次；拿不到 `tokenMeter` 或窗口时不出声。
- **知识库概览 API 与设置页卡片**：项目数、记忆条数、索引行数、文档数、缺路径标记。
- **体检结构化**：`kb-check.py --json`，设置页显示统计与前 3 条警告。
- **卸载**：`node install-skill.js --uninstall`，移除技能副本与 AGENTS.md 的 KB_LOCAL 块，
  块外内容与别的技能不动；凭据保留。
- **常驻块版本化**：`<!-- KB_LOCAL_VERSION: 2 -->`，低版本才刷新标记之间，手改高版本不覆盖。

### 修复

- **设置页 API 未鉴权**：原 `webServer` exact 路由绕过 dsh 的 `/api` 鉴权围栏，
  未登录请求 `/api/local-kb/state` 返回 200 并回显 WebDAV 地址与用户名。改用
  `connection.fetch.register`，由 dsh 判定主人身份（未登录 401、跨站 403）。
- **路径判定三套并存**：统一为 `classifyPath`，解析符号链接与未创建文件，
  Windows 折叠大小写。
- **bash 写 KB 漏判**：`~/.local-kb`、`$HOME/...`、`cd` 后的相对路径现在都能识别；
  只读命令不再触发同步。
- **门禁提醒文案**：「知识库有索引」是错的——KB 只有记忆索引，项目与文档没有总索引。

### 兼容

- 在 dsh `0.2.2-alpha.2` 上验证；`package.json` 的 `dsh.compatibility.dshReleases` 记录。
- 配置项：`injectContext`（默认 true）、`injectMaxLines`（80）、`injectMaxBytes`（8192）、
  `indexCap`（默认 true）。
