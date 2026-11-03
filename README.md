# dsh-local-kb

知识库 + 长期记忆插件：把 `local-kb` 技能从「靠 AI 自觉」变成「插件确定性兜底」。

**不修改任何技能内容**：`local-kb` 技能被其他工具共用，插件只做旁路增强。

## 功能

- **每轮注入记忆索引 + 知识地图**：全局 `memory/MEMORY.md` 与当前项目
  `projects/<id>/memory/MEMORY.md` 直接进 runtime context；知识只注入地图（项目清单、
  当前项目概览、docs 目录名），不注入任何文档正文。模型不必再主动 read 索引。
- **记忆索引硬上限**：200 行 / 25KB。写入前同步拒绝「越界且变大」，压缩写入放行。
- **禁止 AI 删除知识库内容**：只能 `mv` 进同目录的 `archive/`。删除只由用户在文件管理器里做。
- **镜像同步到 WebDAV**：远端 = 本地镜像。改了什么推什么，本地没有的远端删掉。
  排除 `.DS_Store`、`._*`、`*.tmp`、`Thumbs.db` 与插件状态文件。
- **写入即同步 hook**（默认关闭）：`tools/result` 精确监听对 `<KB_ROOT>` 的写入（write/edit/bash 等），
  成功才触发，防抖 1.5s；失败只记录，不阻塞。**默认不开**，避免新装时第一次写入就把远端备份覆盖掉；
  在设置页手动打开。
- **长对话提醒**：对话用到 60% 上下文窗口时提醒一次「把值得留的写进 KB」，每会话一次。
  不算压缩点（那要复制 dsh 的阈值推导），只是防「攒到压缩前才写」。
- **设置页「知识库」**：KB 位置、打开文件夹、WebDAV 配置、知识库内容概览（项目数、记忆条数、
  索引行数、文档数）、体检统计与警告。
- **双向同步**：
  - **上传到云端**：本地覆盖云端，云端多出的文件删除（先弹框确认）
  - **从云端下载**：云端覆盖本地同名文件，本地独有文件保留（先弹框确认）
  - **服务商**：自定义 / 坚果云 / Nextcloud / 群晖 / AList，只是地址模板
  - **远程根目录**：可改，默认 `local-kb-sync`，支持多级路径
  - **自动同步开关**：关掉后只有手动「上传到云端」
  - **清除配置**：清空 WebDAV 地址、账户、密码（本地知识库不动）
- 安装时把技能副本放到 `$DSH_HOME/skills/local-kb/` 并把 `KB_LOCAL` 常驻块写进
  `$DSH_HOME/AGENTS.md`：**有就覆盖**，内容不同才写，覆盖前备份一份到
  `$DSH_HOME/local-kb/backups/`（只留最近一次）。

## 安全

WebDAV 链接、用户名、密码全部存 DSH `credentials` 服务（`$DSH_HOME/.credentials.yaml`，权限 0600），
与官方 API Key 同一存储通道。浏览器与设置 JSON 中不落任何明文密码。

设置页 API 走 `connection.fetch.register`，由 dsh 判定主人身份：未登录 401、跨站 403。

### 卸载行为

- **自动清理**：插件注册的 hook（同步监听、门禁提醒、防抖定时器、API 路由、运行时技能注册）
  挂在 fiber 上，禁用/卸载时随 dispose 自动注销。
- **文件产物要手动收尾**：`dsh plugin remove` 之后插件代码不再运行，没有钩子可挂。运行一次：

  ```sh
  node install-skill.js --uninstall
  ```

  会删除：

  | 内容 | 说明 |
  |---|---|
  | 技能副本 `$DSH_HOME/skills/local-kb/` | 是软链时只解链接，指向的共享技能库不动 |
  | `AGENTS.md` 的 `KB_LOCAL` 块 | 块外内容一行不动 |
  | WebDAV 凭据 `dsh_local_kb_webdav_*` | 删前备份到 `.credentials.yaml.local-kb-bak`（0600） |
  | 插件状态 `$DSH_HOME/local-kb/` | 设置、同步基准、覆盖前备份 |

  **不会删**：知识库目录（`$KB_ROOT`，默认 `~/.local-kb`）—— 那是你的数据。

## 使用

1. 在插件目录执行安装：`install_bundle`（DSH Plugin Manager）。
2. 打开设置弹框 → 左侧「知识库」。
3. 配置 WebDAV 链接/用户名/密码 → 测试链接 → 保存。
4. AI 向 `~/.local-kb/` 写入即自动同步；可在设置页点击「立即同步」。

## 配置

写在 profile 的 `cordis.patch.yml`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `kbRoot` | `~/.local-kb` | 知识库根（也认 `KB_ROOT` 环境变量） |
| `injectContext` | `true` | 是否每轮注入记忆索引与知识地图 |
| `injectMaxLines` | `80` | 单个索引注入的最大行数 |
| `injectMaxBytes` | `8192` | 单个索引注入的最大字节数 |
| `indexCap` | `true` | 是否启用索引硬上限（删除拦截不受影响） |
| `compactionReminder` | `true` | 是否在长对话时提醒写 KB |
| `reminderPressure` | `0.6` | 触发提醒的上下文占用比例 |
| `installSkill` | `true` | 是否把技能副本安装到 `$DSH_HOME/skills/` |
| `registerSkill` | `true` | 是否在运行时注册技能条目 |

## 知识库优先门禁（v2，2026-10）

判定权交给常驻块 M/K/W 规则；插件只留确定性兜底：

| 场景 | 行为 |
|---|---|
| web_search / web_fetch | 永不拦；本 agent 未查过 KB 时首次事后附一条提示 |
| find / locate / mdfind | 永不拦（KB 无文件清单） |
| read 任意路径 / 工作区内搜索 / home 一级目录 | 永不拦（定点访问 = 知道去哪） |
| grep/rg 目标 = `/` 或整个 home | 仅当本 agent 从未查过 KB 时拦一次 |
| 记忆检索 | memory 未读时，首次本地读/搜后附一条提示（每任务 1 次） |

- 状态 per-agent（WeakMap，随 agent 回收）
- 提醒是 post-execute 附加上下文，不 deny、不重写结果
- 异常安全：门禁内部任何错误 → 放行；`DSH_LOCAL_KB_ENFORCE=0` 总闸

## 同步范围

- **会同步**：`docs/`、`projects/`（含记忆、项目页、arch）、`memory/`、`README.md`、`paths.yaml`
- **不同步**：`.DS_Store`、`._*`、`*.tmp`、`Thumbs.db`、`.kb-sync-state.json`、`settings.json`、`backups/`
- **增量**：按 mtime + size 比对，只传变化的文件；远端多余的文件会删（镜像）
- **自动同步默认关闭**：只有点「上传到云端」才推。打开开关后写入即同步。
- **空闲跳过**：本地没有任何改动和删除时，不扫远端（省约 3 秒）
- **paths.yaml 会同步**：它带的 `git_remote` 是新设备克隆项目的关键。下载后本机路径通常失效，
  地图会标「路径失效（用 git_remote 重新登记）」，不会当成有效路径使用。

## 多设备

当前只支持**单写者**：同一时间只让一台设备上传，另一台只读（下载后不再点上传）。
两端都写会互相删除，这在 `DESIGN-multi-device-sync.md` 里有完整的合并方案，尚未实现。

## 开发

```sh
npm test        # 全部测试（12 个文件，244 项）
```

- `index.js`：Host 半（技能安装、注入、guard、同步、API）
- `inject.js`：记忆索引与知识地图的组装（同步 IO + mtime 缓存）
- `install-skill.js`：技能副本安装 / 卸载 + AGENTS.md 常驻块
- `client.js`：浏览器半（设置页）
- `skill/`：local-kb 技能完整副本（安装源，内容与上游逐字节一致）

## 限制

- 只拦 dsh 的文件工具与 bash 里认得出的删除命令；`python -c os.remove` 这类绕过判不出。
- 索引上限只覆盖 `*/memory/MEMORY.md`；项目页与文档不设行数上限。
- 注入按 `paths.yaml` 匹配当前项目；没登记的项目只出现在地图里，不注入它的记忆索引。
- 单写者模型：同一时间只让一台机器写这个 WebDAV 目录，镜像才成立。
- 设置页文案仍跟随浏览器语言，未接入 dsh 的 locale 服务。
- 长对话提醒是粗粒度：按上下文占用比例，不预测 dsh 的真实压缩点；拿不到
  `tokenMeter` 或上下文窗口时不提醒。
- 未实现：跨项目文档正文注入、大肥鱼/社交模式（记忆类型协议不同，不在本插件范围）。
