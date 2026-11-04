# Changelog

## 未发布

### 变更

- **长对话提示升级为可执行步骤**：60% 阈值命中时注入的不再是空泛的「把值得留的写进 KB」，
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
