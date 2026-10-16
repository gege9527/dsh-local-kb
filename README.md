# dsh-local-kb

知识库插件：让 `local-kb` 技能以插件形式获得确定性的 hook、常驻规范自动落地、GUI 设置页与 WebDAV 同步。

**不修改任何技能内容**：`local-kb` 技能被其他工具共用，插件只做旁路增强。

## 功能

- 安装时自动把 local-kb 技能副本放到 `$DSH_HOME/skills/local-kb/`，并把 KB_LOCAL 常驻块写入 `$DSH_HOME/AGENTS.md`（幂等）。
- 运行时注册技能条目（`ctx.skills.register`），文件系统扫描不可用时技能仍在目录中。
- **写入即同步 hook**：`tools/result` 事件精确监听模型对 `<KB_ROOT>` 的写入工具调用（write/edit/str_replace/insert/bash），成功才触发一次异步 WebDAV 同步；不是文件监听、不轮询。同步失败不阻塞任何操作，只把失败记录到设置页（红色横幅 + 失败时间）。
- 设置弹框新增「知识库」菜单：
  - 显示 KB 位置（`KB_ROOT` 环境变量优先，默认 `~/.local-kb`）
  - 「打开文件夹」与「使用 VSCode 打开」按钮（复用 DSH 自带 `ctx.remote.session.openWorkspacePath` 打开能力）
  - WebDAV 链接 / 用户名 / 密码配置、测试链接、立即同步
  - 密码框配置后显示为空，提示「输入新密码以修改」——与官方 API Key 行为一致

## 安全

WebDAV 链接、用户名、密码全部存 DSH `credentials` 服务（`$DSH_HOME/.credentials.yaml`，权限 0600），
与官方 API Key 完全同一存储通道。浏览器与设置 JSON 中不落任何明文密码。

### 卸载行为

- **自动清理**：插件注册的 hook（写入即同步 `tools/result` 监听、KB-first 提醒、防抖定时器、
  WebDAV API 路由、运行时技能注册）挂在插件 fiber 上，禁用/卸载插件时随 fiber dispose 自动注销，零残留。
- **不会自动清理**（需要时手动删除）：
  - 技能副本 `$DSH_HOME/skills/local-kb/`
  - `$DSH_HOME/AGENTS.md` 中的 `KB_LOCAL` 常驻块
  - WebDAV 凭据：`$DSH_HOME/.credentials.yaml` 中 `dsh_local_kb_webdav_url` / `dsh_local_kb_webdav_user` / `dsh_local_kb_webdav_password` 条目

## 使用

1. 在插件目录执行安装：`install_bundle`（DSH Plugin Manager）。
2. 打开设置弹框 → 左侧「知识库」。
3. 配置 WebDAV 链接/用户名/密码 → 测试链接 → 保存。
4. AI 向 `~/.local-kb/` 写入即自动同步；可在设置页点击「立即同步」。

## 开发

- `index.js`：Host 半（技能安装、写入钩子、WebDAV、HTTP API）
- `install-skill.js`：技能副本安装 + AGENTS.md 常驻块
- `client.js`：浏览器半（设置页）
- `skill/`：local-kb 技能完整副本（安装源，内容与上游逐字节一致）
