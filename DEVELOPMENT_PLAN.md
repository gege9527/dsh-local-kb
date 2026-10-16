# dsh-local-kb 知识库插件 — 开发计划

## 1. 目标

为 DSH 做一个「知识库插件」，让 `local-kb` 技能（`~/.dsh/skills/local-kb`）以插件形式获得：
技能做不到的确定性 hook、常驻规范自动落地、GUI 设置页与 WebDAV 同步。

**硬约束（用户指定）**：`local-kb` 技能内容**一字不改**——它被其他工具（非 DSH 环境）共用，
插件只能旁路增强，不能侵入技能。

## 2. 需求拆解

| # | 需求 | 实现要点 |
|---|---|---|
| R1 | 安装后自动把技能文件放到 `$DSH_HOME/skills/local-kb/` | 插件自带一份技能副本，激活时幂等安装（复刻 checkpoint-memory 的 install-skill 机制） |
| R2 | 把技能「常驻规范」自动写入全局 `~/.dsh/AGENTS.md` | 用技能自带的 `references/agents-snippet.md`（KB_LOCAL_START/END 块），幂等追加/原位刷新 |
| R3 | 新增技能无法实现的 hook 机制，保证「知识库优先」稳定触发 | 重新设计：见 §3 |
| R4 | 设置弹框新增「知识库」菜单 | `settings.section` 槽注册一页，弹框左侧导航自动出现入口 |
| R5 | 菜单内显示知识库文件位置 + 按钮打开文件夹 / VSCode | 复用 DSH 现有打开能力 `ctx.remote.session.openWorkspacePath`（同一 Remote 通道） |
| R6 | WebDAV 同步配置：链接、用户名、密码 | 见 R9 安全设计 |
| R7 | 测试链接按钮、立即同步按钮 | Host HTTP 层实现，设置页按钮触发 |
| R8 | 默认在技能向 `.local-kb` 写入时自动同步（非文件监听，只有写入才同步）；异步、不阻塞；失败在设置页下方红色提示（含时间） | hook（R3）+ 设置页状态栏 |
| R9 | 安全：WebDAV 链接/用户名/密码存储位置分析 | **已确认方案**：全部走 DSH `credentials` 服务 → `$DSH_HOME/.credentials.yaml`（0600），与官方 API Key 完全同一机制；密码框配置后显示为空、输入即改密码 |

## 3. Hook 机制设计（R3，重新设计）

技能是纯 Markdown 指令，无法拦截模型行为；插件需要的是**确定性**的机制。设计如下：

### 3.1 常驻触发加固：运行时技能注册
- `ctx.inject(['skills'])` 注册一个 `source: 'runtime'` 的 `local-kb` 技能（描述/whenToUse 与
  技能文件一致的精简版），保证「文件系统扫描不可用/目录不对」时技能仍存在于技能目录。
  —— 复用 checkpoint-memory 已验证的 `ctx.inject(['skills'])` + `inner.skills.register` 模式。

### 3.2 写入即同步：`tools/result` 事件钩子（核心新机制）
- 技能本身做不到「写入后自动同步」；插件用 Host 事件 `ctx.on('tools/result')` 监听
  模型**对 KB_ROOT 的文件写入工具调用**（`write`/`edit`/`str_replace`/`insert`/`bash` 等写工具，
  校验 `exec.arguments` 中的路径落在 `<KB_ROOT>` 内）。
- **只在写入成功（`result.isError === false`）时触发**一次异步 WebDAV 同步。
- 这是「写入才同步」的精确实现——不监听文件系统（无 watcher、无轮询），
  工具调用是知识库写入的唯一通道（与技能铁律「所有读写走文件系统工具」一致）。
- 同步失败**绝不阻塞**工具结果返回：同步在 `void promise.catch()` 中跑，失败只记录到
  设置页可见的同步状态（Host 存最后失败时间+原因，Client 轮询/拉取显示红色提示）。

### 3.3 为什么不用文件监听
- `fs.watch` 对编辑器/外部进程的写入也会触发 → 违背「只有写入才同步」。
- 工具调用钩子能拿到「谁、写了什么、成没成」，与技能的写入流程精确对应。

## 4. 架构

```
dsh-local-kb/
├── package.json            # bundle manifest + client 声明 + locale/icon exports
├── cordis.patch.yml        # 插入一行插件
├── index.js                # Host 半：install-skill / tools/result hook / WebDAV / 打开路径 / HTTP
├── install-skill.js        # 技能副本幂等安装 + AGENTS.md 常驻块写入（复刻 checkpoint-memory）
├── skill/                  # local-kb 技能完整副本（安装源，不改内容）
├── client.js               # Client 半：settings.section「知识库」页
├── locale/en.json, locale/zh.json
└── icon.svg
```

### 4.1 Host 半（index.js）关键点
- `inject: ['tools']`；`skills`、`credentials`、`webServer` 等用 `ctx.inject` 懒注入（可选服务不阻塞启动）。
- WebDAV 同步引擎：node:https 直连，WebDAV `MKCOL` + `PUT`（逐文件），
  用 `process.env.KB_ROOT ?? ~/.local-kb` 解析根，冲突/重名安全策略见 §7。
- Host 向 Client 暴露：
  - `harness.handle('kb.syncNow')` — 立即同步
  - `harness.handle('kb.testLink')` — 测试链接（OPTIONS/HEAD 或 PROPFIND）
  - `harness.handle('kb.state')` — 最近同步状态（成功/失败+时间+原因）
  - `harness.handle('kb.openPath')` — 打开文件夹/VSCode（复用 session Remote）
  - 凭据读写直接走 `ctx.remote.credentials`（Client 侧）或 Host `ctx.credentials`
- 打开路径：Host 端调用 `sessionController.openWorkspacePath` Remote 方法
  （`{ path, action: 'reveal' }` 打开 Finder/Explorer；`{ path, action: 'open', application }` 用 VSCode）。

### 4.2 Client 半（client.js）关键点
- 零构建 lazy-CJS（`window.__ModuleLoader__.load`），React 由运行时提供。
- `ctx.slots.inject('settings.section', …)` 注册：
  `{ name: 'settings.section', id: 'knowledge-base', order: 30, label: () => '知识库', inject, locale }`。
- 页面内容：
  - KB 位置展示（`~/.local-kb/` 或 KB_ROOT）+「打开文件夹」按钮 +「VSCode 打开」按钮
    （按钮调用 `ctx.remote.session.canOpenWorkspacePath` / `openWorkspacePath`）
  - WebDAV 配置：链接、用户名、密码（密码框 `type=password`，已配置时留空、placeholder
    提示「输入即修改密码」——与 Models 页 API Key 行为一致）
  - 「测试链接」按钮 → `kb.testLink`，结果内联显示
  - 「立即同步」按钮 → `kb.syncNow`
  - 下方同步状态区：最后同步时间/结果；失败显示红色横幅（`--dsw-alias-*` 错误色 token）+ 失败时间
- 密码回显语义：`describe` 只告诉 configured，不返回值；非空输入 → set（覆盖）；
  空输入 + 已有配置 → 不改动。不提供「清除」按钮：凭据、技能副本与 AGENTS.md 常驻块需要删除时由用户手动处理（插件只装不卸）。

### 4.3 安全存储（R9 定稿）
- WebDAV 链接、用户名、密码三个 ref 全部存 DSH `credentials` 服务
  （`$DSH_HOME/.credentials.yaml`，0600），ref 形如
  `dsh-local-kb/webdav:url`、`dsh-local-kb/webdav:user`、`dsh-local-kb/webdav:password`。
- 设置 JSON/浏览器不落任何明文；密码框永远不回显。
- 与官方 API Key 完全同一通道 → 行为、权限、可审计性一致。

## 5. 开发步骤（每步可验证）

1. **脚手架**：package.json / cordis.patch.yml / locale / icon / 目录结构。
2. **install-skill.js**：技能副本安装 + AGENTS.md 常驻块（KB_LOCAL 块）幂等写入。
3. **index.js 骨架**：apply() 挂载 install-skill + runtime 技能注册。
4. **tools/result 写入钩子**：路径判定（KB_ROOT 内）+ 成功判定 + 异步触发同步队列。
5. **WebDAV 引擎**：`syncRoot()`（MKCOL + PUT 增量）、`testLink()`、并发/错误处理、状态记录。
6. **Host harness.handle**：syncNow / testLink / state / openPath + credentials 读写。
7. **client.js 设置页**：settings.section 注册 + 全 UI（位置/打开按钮/WebDAV 表单/测试/立即同步/红色失败条）。
8. **安装与联调**：`plugin_manager install_bundle` 安装到当前 profile，页面验证。
9. **验收测试**：逐条对照 §2 需求表 + 密码行为 + 失败红色提示 + 不阻塞验证。

## 6. 验证清单

- [ ] 插件安装后 `$DSH_HOME/skills/local-kb/` 出现技能副本（校验 .skill-version）
- [ ] `~/.dsh/AGENTS.md` 出现 KB_LOCAL_START/END 常驻块且不重复、不动块外内容
- [ ] 设置弹框左侧出现「知识库」，点击打开页面
- [ ] 页面显示 KB 路径；「打开文件夹」在 Finder/Explorer 中揭示该目录；「VSCode 打开」调起 VSCode
- [ ] WebDAV 表单：链接/用户名/密码保存后重开设置页，密码框为空 + placeholder 提示；再填密码即覆盖
- [ ] 「测试链接」对可达/不可达地址分别正确反馈
- [ ] 技能向 `~/.local-kb/` 写一个文件 → 自动触发同步（日志/状态可见）；失败时不阻塞对话，设置页下方红色提示含失败时间
- [ ] 不改动技能内容（`skill/SKILL.md` 与源技能逐字节一致）
- [ ] 配置文件不含明文密码；`.credentials.yaml` 中三个 ref 存在

## 7. 风险与决策

- **同步冲突**：本版做「本地→远端增量 PUT」单向推送（新增/修改文件），删除采用墓碑记录
  （.kb-sync-state.json 记录已推清单），不做双向合并；冲突风险接受，后续版本再议。
- **WebDAV 服务器差异**：只依赖 MKCOL/PUT（RFC 4918 通用能力），个别服务器需 PROPFIND 时降级为
  逐个 PUT 覆盖（服务器无锁/版本特性一律不依赖）。
- **KB_ROOT 可被环境变量覆盖**：Host 与 Client 都按同一规则解析（env KB_ROOT → `~/.local-kb`），
  设置页展示实际生效路径。
- **技能「不修改」约束**：install-skill 只把副本写入 `$DSH_HOME/skills/`（DSH 的技能库位置），
  永不触碰 `~/.dsh/skills/local-kb` 源目录（那是用户手动维护/其他工具共用的副本）。
- **多实例/多 Agent**：tools/result 是 scope 过滤事件；同步状态做全局单例，串行化同步任务。

## 8. 交付物

- 插件目录 `dsh-local-kb/`（含本计划、源码、技能副本、locale、icon）
- 安装到当前 profile 后可用的完整能力
- 本文件作为开发记录保留

## 9. 开发进度（2026-10-13）

**已交付**：

| 步骤 | 状态 |
|---|---|
| 1 脚手架 | ✅ package.json / cordis.patch.yml / locale / icon / 目录 |
| 2 install-skill.js | ✅ 只缺则补：目标已有 SKILL.md → 绝不覆盖；AGENTS.md KB_LOCAL 块存在 → 不重写 |
| 3 index.js 骨架 | ✅ apply + installSkill + 运行时技能注册 |
| 4 tools/result 写入钩子 | ✅ 成功写入 KB_ROOT 内文件 → 防抖 1.5s → 异步同步 |
| 5 WebDAV 引擎 | ✅ syncRoot（增量 PUT + MKCOL 目录链 + 状态基准）/ testLink（PROPFIND）|
| 6 Host HTTP API | ✅ /state /sync /test-link（静态插件 Client↔Host 通道）|
| 7 client.js 设置页 | ✅ settings.section「知识库」页：位置/打开文件夹/VSCode/WebDAV 表单/测试/立即同步/红色失败横幅 |
| 8 安装挂载 | ✅ web profile package.json + cordis.patch.yml + node_modules link |

**测试**（node 内联集成测试，5 组全过）：
1. install-skill 幂等 + 只缺则补（不覆盖用户技能、不覆盖新版 AGENTS 块）
2. webdav 引擎（增量 PUT、MKCOL 目录链、无变化 0 push、深层子目录、PROPFIND 测试）
3. tools/result 钩子：KB 内写入成功 → 自动同步 ok；失败写入/非 KB 写入 → 不触发；同步失败 → 状态 failed + 不阻塞
4. HTTP API 三端点（state / sync / test-link 空值回退）
5. testLink 回归 + 全部 JS 语法检查

**修复记录**：
- install-skill 从「copyPayload 全量覆盖」改为「只缺则补」——用户 local-kb 技能是共享源目录，覆盖会降级/毁掉用户版本
- appendRulesToAgents 移除 refresh 覆盖——AGENTS.md 块已存在即保留（用户可能手动维护更新版）
- test-link 空串回退已存凭据——空密码不覆盖已存密码去测试
- apply 补 sync timer cleanup
- client.js 密码框永不回显（describe 只报 configured）、url 加 configured 状态

## 10. 验收清单（实机激活：2026-10-13 完成 ✅）

**激活证据（HMR 热应用，无需重启）**：
- `dsh-local-kb` Host 半：`listConfigs` 状态 `absent`（激活运行，与 workspace-toolkit/turn-undo 一致）
- Host 路由：`GET /api/local-kb` → 200
- Client 半：`settings.section` occupants 新增 `knowledge-base`（order 30, active）
- 触发方式：profile patch 里 `dsh-local-kb` 条目改内容 → HMR `reconcileProfilePatches` → Loader 重新导入 → 激活

**全量测试证据（node 集成测试 + 真实 WebDAV 服务器 E2E）**：
1. ✅ install-skill 幂等 + 只缺则补（不覆盖用户技能、不覆盖新版 AGENTS 块）
2. ✅ webdav 引擎（增量 PUT、MKCOL 目录链、无变化 0 push、深层子目录、PROPFIND 测试）
3. ✅ tools/result 钩子：KB 内写入成功 → 自动同步 ok；失败写入/非 KB 写入 → 不触发
4. ✅ E2E 真实 WebDAV：正确凭据 → 远端更新；错误密码(401) → 状态 failed + 时间，不阻塞
5. ✅ HTTP API：/state /sync /test-link 全部返回正确 JSON
6. ✅ client.js：settings.section 注入 + 密码框永不回显（describe-only）

**待用户 GUI 目视确认**（代码已就绪，打开设置弹框即可见）：
- 设置左侧「知识库」导航项 + 页面（位置/打开文件夹/VSCode/WebDAV 表单/测试/立即同步/红色失败横幅）

1. 刷新 Web GUI → 设置弹框左侧出现「知识库」导航项
2. 打开「知识库」页：
   - [ ] 显示 KB 位置 `~/.local-kb`（或 KB_ROOT）
   - [ ] 「打开文件夹」在 Finder 中揭示该目录
   - [ ] 「使用 VSCode 打开」调起 VSCode
3. WebDAV 表单：
   - [ ] 填链接/用户名/密码 → 保存 → 重开页面密码框为空 + 提示「输入新密码以修改」
   - [ ] 「测试链接」对可达/不可达地址分别正确反馈
4. 自动同步：
   - [ ] 让 AI 向 `~/.local-kb/` 写一个文件 → 状态区出现「上次同步成功（时间）」+ 远端出现该文件
   - [ ] 配置错误链接 → 写入后状态区出现红色横幅「同步失败（时间）：原因」，对话不被阻塞
5. 安全：
   - [ ] `~/.dsh/.credentials.yaml` 出现 `dsh-local-kb.webdav.*` 三个 ref，密码非明文存储（与 API Key 同机制）
   - [ ] 技能内容未被插件改动（`~/.dsh/skills/local-kb/SKILL.md` 与用户源一致）
