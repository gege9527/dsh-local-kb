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
- **插件安装的文件不自动删**：知识库内容与用户目录只由用户处置。卸载后手动运行一次：

  ```sh
  node install-skill.js --uninstall
  ```

  它会移除技能副本 `$DSH_HOME/skills/local-kb/` 与 `$DSH_HOME/AGENTS.md` 中的 `KB_LOCAL` 块，
  块外内容原样保留，别的技能不动。
- **凭据保留**：`$DSH_HOME/.credentials.yaml` 中 `dsh_local_kb_webdav_url` / `dsh_local_kb_webdav_user` /
  `dsh_local_kb_webdav_password` 需要时手动删除。

## 使用

1. 在插件目录执行安装：`install_bundle`（DSH Plugin Manager）。
2. 打开设置弹框 → 左侧「知识库」。
3. 配置 WebDAV 链接/用户名/密码 → 测试链接 → 保存。
4. AI 向 `~/.local-kb/` 写入即自动同步；可在设置页点击「立即同步」。

## 知识库优先门禁（v2，2026-10）

插件不再替模型判断「该不该查知识库」，判定权交给常驻块 M/K/W 规则；插件只留确定性兜底：

| 场景 | 行为 |
|---|---|
| web_search / web_fetch | 永不拦（外部知识不归 KB 管）；本 agent 未查过 KB 时，首次事后附一条 KB 提示 |
| find / locate / mdfind | 永不拦（KB 无文件清单） |
| read 任意路径 / 工作区内搜索 / home 一级目录（~/Documents 等） | 永不拦（定点访问 = 知道去哪） |
| grep/rg 目标 = `/` 或整个 home | 仅当本 agent 从未查过 KB 时拦一次（唯一硬闸）；查过即永不再拦 |
| 记忆检索 | 无条件必走 KB：memory 未读时，首次本地读/搜后附记忆提醒（每任务 1 次，用户新消息重置） |

- 状态 per-agent（WeakMap，随 agent 回收）：跨会话/子代理互不影响
- 提醒是 post-execute 附加上下文（form: notice），不 deny、不重写结果、零打断
- 异常安全：门禁内部任何错误 → 放行；`DSH_LOCAL_KB_ENFORCE=0` 总闸
- Windows：路径判定退化为软规则（不假装支持盘符解析）

## 开发

- `index.js`：Host 半（技能安装、写入钩子、WebDAV、HTTP API）
- `install-skill.js`：技能副本安装 + AGENTS.md 常驻块
- `client.js`：浏览器半（设置页）
- `skill/`：local-kb 技能完整副本（安装源，内容与上游逐字节一致）
