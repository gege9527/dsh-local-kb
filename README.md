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
- **写入即同步 hook**：`tools/result` 精确监听对 `<KB_ROOT>` 的写入（write/edit/bash 等），
  成功才触发，防抖 1.5s；失败只记录，不阻塞。
- **设置页「知识库」**：KB 位置、打开文件夹、WebDAV 配置、知识库内容概览（项目数、记忆条数、
  索引行数、文档数）、体检统计与警告、立即同步。
- 安装时把技能副本放到 `$DSH_HOME/skills/local-kb/` 并把 `KB_LOCAL` 常驻块写进
  `$DSH_HOME/AGENTS.md`（块带版本号，低版本才刷新，块外内容不动）。

## 安全

WebDAV 链接、用户名、密码全部存 DSH `credentials` 服务（`$DSH_HOME/.credentials.yaml`，权限 0600），
与官方 API Key 同一存储通道。浏览器与设置 JSON 中不落任何明文密码。

设置页 API 走 `connection.fetch.register`，由 dsh 判定主人身份：未登录 401、跨站 403。

### 卸载行为

- **自动清理**：插件注册的 hook（同步监听、门禁提醒、防抖定时器、API 路由、运行时技能注册）
  挂在 fiber 上，禁用/卸载时随 dispose 自动注销。
- **插件安装的文件不自动删**：卸载后手动运行一次：

  ```sh
  node install-skill.js --uninstall
  ```

  移除技能副本与 `AGENTS.md` 的 `KB_LOCAL` 块，块外内容与别的技能不动。
- **凭据保留**：`$DSH_HOME/.credentials.yaml` 中的 `dsh_local_kb_webdav_*` 需要时手动删除。

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

## 开发

```sh
npm test        # 全部测试（10 个文件，187 项）
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
- 未实现压缩前提醒：需要复制 dsh compaction 的阈值推导，收益不确定，暂不做。
- 未实现：跨项目文档正文注入、大肥鱼/社交模式（记忆类型协议不同，不在本插件范围）。
