# dsh-local-kb

知识库 + 长期记忆插件。给 `local-kb` 技能补上确定性：每轮注入记忆、写入前拦住越界、备份到 WebDAV。

**不修改任何技能内容**：`local-kb` 技能被其他工具共用，插件只做旁路增强。

## 快速开始

1. 在 DSH 插件管理里安装本插件。
2. 打开 设置 → 知识库，填 WebDAV 地址、账户、密码 → 测试连接 → 保存配置。
3. 点「上传到云端」建立第一份备份。

默认**不会自动上传**——写知识库只改本地，什么时候推由你决定。

## 它做什么

| 能力 | 行为 |
|---|---|
| **每轮注入** | 全局 + 当前项目的 `MEMORY.md` 索引，以及知识地图（项目清单、当前项目概览、docs 目录名）。不注入任何文档正文。 |
| **活跃任务标注** | 注入时读项目记忆的 `status: active`，自动给索引行加 `⚡` 并单列「当前活跃任务」。⚡ 只是恢复锚点，其余记忆照常按钩子取舍。 |
| **索引上限** | 200 行 / 25KB。写入前同步拒绝「越界且变大」；压缩写入放行。 |
| **禁止删除** | AI 只能 `mv` 进同目录的 `archive/`。物理删除由用户在文件管理器里做。 |
| **上传 / 下载** | 见下方「同步」。两个方向都会先弹框确认。 |
| **长对话落盘提示** | 上下文到 60% 时提示：任务未完成就写/更新 `status: active` 记忆 → 索引行加 `⚡` → 跑 `kb-check.py`；已完的会话明确可跳过。每会话一次。 |
| **设置页** | KB 位置、打开文件夹、WebDAV 配置、知识库概览（项目/记忆/索引/文档数）、体检结果。 |

底层还注册了一条兜底门禁：`grep/rg` 扫 `/` 或整个 home 且本 agent 从未查过 KB 时拒绝一次；其余场景一律放行
（`DSH_LOCAL_KB_ENFORCE=0` 可整体关闭）。

## 同步

### 两个方向

| 操作 | 语义 |
|---|---|
| **上传到云端** | 本地覆盖云端。云端有、本地没有的文件会被**删除**（镜像）。 |
| **从云端下载** | 云端覆盖本地同名文件。本地多出的文件**保留**。 |

### 范围

- **同步**：`docs/`、`projects/`（记忆、项目页、arch）、`memory/`、`README.md`、`paths.yaml`
- **不同步**：`.DS_Store`、`._*`、`*.tmp`、`Thumbs.db`、`.kb-sync-state.json`、`settings.json`、`backups/`
- **增量**：按 mtime + size 比对，只传变化的文件
- **空闲跳过**：本地没有任何改动时连远端都不扫（省约 3 秒）
- **远端根目录**：可配置，默认 `local-kb-sync`，支持多级路径

### `paths.yaml` 也同步

它带的 `git_remote` 是新设备克隆项目的唯一线索。下载到新机器后本机路径通常失效，
地图会标「路径失效（用 git_remote 重新登记）」，不会拿错误路径去查。

## 设置页

| 区域 | 内容 |
|---|---|
| 知识库位置 | `KB_ROOT` 路径 + 打开文件夹 / 打开 VSCode |
| 知识库内容 | 项目数、文档数；每个项目的记忆条数、索引行数、路径状态（未登记 / 失效） |
| WebDAV 备份 | 地址、账户、密码、远程根目录、自动同步开关 |
| 状态 | 上次上传/下载结果、知识库体检（错误/警告数与前几条） |

密码存在 DSH `credentials` 服务里，页面永不回显；填了新密码才覆盖。

## 配置

写进 profile 的 `cordis.patch.yml`：

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

WebDAV 相关设置（地址、账户、密码、远程根目录、自动同步）不走这里，存在
`$DSH_HOME/local-kb/settings.json` 与 credentials，由设置页管理。

## 安全

- WebDAV 地址、账户、密码存 DSH `credentials` 服务（`$DSH_HOME/.credentials.yaml`，0600），
  浏览器与设置页 JSON 中不落明文密码。
- 设置页 API 走 `connection.fetch.register`，由 dsh 判定主人身份：未登录 401，跨站 403。

## 卸载

`dsh plugin remove` 之后插件代码不再运行，没有钩子可挂，需要手动收尾一次：

```sh
node install-skill.js --uninstall
```

| 删除 | 说明 |
|---|---|
| 技能副本 `$DSH_HOME/skills/local-kb/` | 是软链时只解链接，指向的共享技能库不动 |
| `AGENTS.md` 的 `KB_LOCAL` 块 | 块外内容一行不动 |
| WebDAV 凭据 `dsh_local_kb_webdav_*` | 删前备份到 `.credentials.yaml.local-kb-bak`（0600） |
| 插件状态 `$DSH_HOME/local-kb/` | 设置、同步基准、覆盖前备份 |

**不会删**知识库目录（`$KB_ROOT`，默认 `~/.local-kb`）——那是你的数据。

## 限制

- 删除拦截只认 dsh 文件工具和 bash 里认得出的删除命令；`python -c os.remove` 这类绕过判不出。
- 索引上限只覆盖 `*/memory/MEMORY.md`；项目页与文档不设行数上限。
- 注入按 `paths.yaml` 匹配当前项目；没登记的项目只出现在地图里，不注入它的记忆索引。
- **单写者**：同一时间只让一台设备上传，另一台下载后不再上传。两端都写会互相删除；
  合并方案在 [DESIGN-multi-device-sync.md](DESIGN-multi-device-sync.md)，尚未实现。
- 设置页文案跟随浏览器语言，未接入 dsh 的 locale 服务。
- 长对话提醒是粗粒度：按上下文占用比例，不预测 dsh 的真实压缩点；拿不到
  `tokenMeter` 或上下文窗口时不提醒。

## 开发

```sh
npm test        # 12 个测试文件，255 项
```

| 文件 | 职责 |
|---|---|
| `index.js` | Host 半：技能安装、注入、guard、同步、API |
| `inject.js` | 记忆索引与知识地图的组装（同步 IO + mtime 缓存） |
| `install-skill.js` | 技能副本安装 / 卸载 + AGENTS.md 常驻块 |
| `client.js` | 浏览器半：设置页 |
| `skill/` | local-kb 技能完整副本（安装源，与上游逐字节一致） |
