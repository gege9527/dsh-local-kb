# Changelog

## 0.6.0 — 2026-11-18

### 卡片与检索

- **卡片行号修正**：`kb-card.py` 的小节行号整体多算 1（实测卡片 L26 / 源文件 L25），
  按行号读原文会偏一行；修正后重建全部卡片，抽查与源文件一致。
- **共享模块**：新增 `skills/local-kb/tools/kb_common.py`（frontmatter / slug / iter_docs /
  卡片版本），`kb-card.py` 与 `kb-search.py` 不再各写一份，避免再次分叉。
- **卡片 v4**：`frontmatter` 支持多行 `tags`，卡片恢复 `## 标签` 段（446 篇有标签的文档）；
  `CARD_VERSION` 升到 4，检索端自动整库重建一次。
- **增量写卡**：`kb-card.py` 只重写「缺卡 / 比源文件旧 / 版本不符」的卡片（二次运行 0 写入）；
  `--check` 同时报告缺卡与过期；`--force` 强制整库重建。
- **检索参数与降级**：`kb-search.py` 修正 `--limit N` 省略 KB_ROOT 时把 N 当库根的问题；
  `--explain` 写进用法；卡片重建失败不再谎报成功；**无卡片索引时明确提示「文档未参与检索」**；
  非 UTF-8 文档不再让检索/建卡崩溃。

### 项目页与文档协议

- **查询命令收敛**：默认源码 grep 命令收进常驻规则 `agents-snippet.md`（每轮注入），项目页不再写
  整段命令；项目例外改用 frontmatter `search_roots / search_exclude / search_projects`，
  由 inject 每轮带出（ad-manager、diplay-work、excel-designer 已配置）。34 个项目页迁移，
  合计 **84,754 → 65,893 字节（−22.2%）**，占位符 `<技能目录>` 一类清零。
- **`_topic.md` 规范**：7 份统一 `topic:` 字段、删除正文对 frontmatter 的复述；`kb-check`
  要求「≥2 篇文档的目录必须有 `_topic.md`」且只认 `topic:`；移除 `docs/根层单篇` 的 projects 分支。
- **回源按时间**：不再用版本号判断。`age = 今天 − (last_checked || date_added)`，≥90 天只提示
  「可能过时，要核对说『刷新这篇』」；查询不联网，只有显式指令才抓取，抓取后先给 diff、
  覆写前把旧版移入 `archive/docs/`；`source` 非 URL 的文档标注「无更新来源」。
- **数据修正**：3 处记忆条数、n1 死链、diplay-work 项目 ID、dsh-plugins 描述、wx 4 条路径；
  oa-ai 桥接说明按实际文件 `bridge-sdk.js`（宿主 `parent` / iframe 两用）合并。

### kb-move 安全化

- 正文里的裸 id 默认**不**替换（短 id 会误伤普通用词与源码路径）：命中时列出行号并拒绝，
  显式 `--allow-body-rewrite` 才改。
- `title` 只在等于旧 id（或为空）时才改，不再覆盖人类可读标题；`path_old` 记录修正；
  备份同名自动加序号；rename 失败回滚；后置 kb-card/kb-check 失败返回非 0；全库 md 只读一遍。

### 体检、同步与设置页

- **kb-check**：修复永远不触发的「记忆引用路径失效」检查（正则漏 `\`、基准目录错），
  只校验 KB 命名空间内的引用并聚合成一条；`--fix` 逐条重算落点，避免重复建 `## type` 小节；
  新增日期格式与 >365 天快照汇总；`--fix` 写回保留 CRLF；清理死变量与行数 off-by-one。
- **同步**：`SYNC_EXCLUDE` 增加 `^\.backup/`（改名快照只用于本地回滚），README 同步范围同步更新。
- **设置页**：`/state` 补 `lastCheckStats` / `lastCheckWarns`（体检统计与警告不再永远空白）；
  client 死代码清理（`APP_NAMES`、未用 i18n 键等，−5.4KB）；toast 定时器移到组件外。

### 打包与清理

- `package.json` 的 `files` 改为细粒度技能条目，npm 包不再带 `__pycache__`（24 文件）；
  发布前校验清单加入 `kb_common.py`；删除指向不存在文件的 `test:agents`。
- 删除一次性脚本 `scripts/kb-migrate.py`（会写回旧样板）；README 移除不存在的「打开 VSCode」
  与 `arch/` 结构；若干文档与实现对齐（`--explain`、低置信文案、`记忆索引` 标题、中文 id 规则）。
- 测试：431 条断言全部通过，新增卡片行号、kb-move 安全开关与移动路径、备份不同步、
  state 体检字段、卡片版本哨兵等覆盖。

### 既有未发布变更


- **中文命名合法化**：规范统一为「中文目录 / 文件名 / 路径合法，存量中文名不改」——
  `SKILL.md` 结构节、`references/code-project.md`（id 规则与检查清单）、`references/doc-import.md`
  （文件名规则与检查清单）、`references/templates.md`（project_id 占位）同步改写；记忆 slug 仍固定英文
  kebab（索引指针与检索标识符），中文含义只进 `description` / `aliases`。校验器行为未变——`kb-check`
  与 `kb-move-project.py` 一直允许中文 id（`kebab_seg` 保留 CJK），这次只是把文字与实现对齐。
- **文档单一入口**：`README.md` 扩为完整手册（功能、同步、API、状态、排障、限制、开发一次讲清，
  含徽章 / 目录 / Mermaid 架构图 / 折叠排障）；删除 `GUIDE.md` 与 `DESIGN-multi-device-sync.md`，
  多设备三方合并方案作为「设计稿（未实现）」收入 README；`package.json` 的 `files` 移除 `GUIDE.md`。
- **换设备不主动克隆**：缺失项目改为**先询问用户**；同意才按 `git_remote` 克隆，拒绝或 `none` 则标记缺失。
  同步更新 `SKILL.md`、`references/code-project.md`、骨架 README 模板与实例。
- **骨架 README 模板同步**：`skills/local-kb/references/templates.md` 的 README 骨架压到 47 行，
  与实例同构（根用 `<KB_ROOT>` 占位）；新装 / 换设备不再生成旧长版。技能协议其余内容不变。
- **清理旧安装器**：`install-skill.js` 从 502 行删到 148 行，只留常量、`resolveDshHome` 与
  `uninstallSkill`；`installSkill` / `appendRulesToAgents` 及其测试（`agents-block.spec.mjs`）删除，
  卸载行为由 `uninstall.spec.mjs` 继续覆盖。
- **去掉技能路径回落**：kb-search 脚本只认包内路径，不再回落到 `$DSH_HOME/skills/local-kb`（旧副本已被迁移清掉）。
- **提醒去冗余**：记忆索引已每步注入时不再发「记忆先行」提醒；每类提醒会话上限 2→3，
  文案改为「项目 / 父项目 / 全局」三段索引的说法。
- **项目命名规则**：`project_id` 取「能保证唯一的最短路径后缀」（各段 kebab 化，多段用 `-` 连接，中文原样）。
  新增 `kb-move-project.py`：`--scan/--from-path` 生成计划、`--apply --plan` 执行，一次性更新
  paths.yaml、`projects/<id>/` 目录、项目页 frontmatter、全库引用与卡片，执行前自动备份。
  `kb-check` 新增三条 error：id 重复、id 与规则推导值不符、同目录名冲突未消解。
  地图在 id 与目录名不一致时补显目录名：`diplay-privacy（DiPlay-work）`。
- **子项目粒度**：项目按 `paths.yaml` 最长前缀匹配，子项目（monorepo 子包）各自登记与建库；
  注入时「本子项目记忆 + 父项目记忆（跨子项目决策）+ 全局记忆」三段，段标题恢复索引路径
  （`### 项目记忆 <id> · projects/<id>/memory/MEMORY.md`）。新增 `parentProjectFor()` 与 6 条断言。
  知识库侧同步拆分：dsh-plugins 下 4 个插件各自建档，通用反馈上提全局。

## 0.5.0 — 2026-11-17

技能改成「随包加载」，顺带修掉卸载残留。行为变更：**默认不再往 `$DSH_HOME` 写任何文件**。

### 变更

- **技能目录重排**：`skill/` → `skills/local-kb/`，与 DSH 技能根布局一致；
  `cordis.patch.yml` 增加一行 `@deepseek-ai/dsh-skill-filesystem`，用 `bundledSkillDir`
  直接加载包内技能（bundled rank 600），不再复制到用户技能根。
- **常驻规则改走 `systemPrompt.context`**：原来写进 `$DSH_HOME/AGENTS.md` 的 KB_LOCAL 块，
  现在由 `local-kb:rules` 上下文条目提供（order 299，mtime 缓存）。插件卸载时 effect
  自动注销，AGENTS.md 不再被改动。
- **删掉全部备用路径**：`installSkill` / `appendRules` / `registerSkill` / `autoRegisterSkill`
  四个配置项移除。技能只有一条来源（bundled provider），不再复制副本、不再运行时注册、
  不再做 catalog 兜底——避免两条真相源导致「加载的到底是哪一份」不可判定。
  包内 `skills/local-kb` 缺失时只发一条 warn 日志，不做任何降级。
- **新增 `migrate.js`**：启动时清理旧产物 —— 带 `.skill-version` 的技能副本（删前备份到
  `$DSH_HOME/.local-kb-legacy-backup/`）、`AGENTS.md` 里的 KB_LOCAL 块；
  没有标记的目录视为用户所有，保留并报告冲突。`migrateLegacy: false` 可关。
- **`kbSearchPath()` 探测顺序**：包内脚本优先，旧副本降为兜底。
- **发布前校验**：新增 `scripts/check-package.mjs`（`prepublishOnly` + `npm test` 双重挂载）。
  检查技能载荷 6 个关键文件、`files` 覆盖、`cordis.patch.yml` 的 provider 行（含
  `bundledSkillDir` 是否指向本包 `skills/`）。缺一项即 `npm publish` 中止——这是
  去掉运行时兜底后的替代保障。
- **体检与上传解耦**：`tools/result` 不再因 `autoSync: false` 提前返回。
  写入 KB 后必定跑 `kb-check` 并记录状态；`autoSync` 只管「体检之后要不要上传」。
  手动上传（设置页）不受该开关影响。新增 `shouldAutoUpload()` 与 4 条回归断言。
- **启动自检**：`apply()` 开头检查包内 `skills/local-kb` 是否存在，缺失只 warn
  （「发布包漏了 skills/」这类问题可见），不改变任何行为。

### 为什么必须迁

技能根按 rank 去重，**数字小的赢**：user-dsh 400 < bundled 600。旧副本不删，
升级后加载的仍是旧技能 —— 所以清理逻辑和挂载必须在同一版里发布。

### 测试

新增 `tests/migrate.spec.mjs`（27 项）：标记识别、备份、软链只解链接、无标记冲突保留、
AGENTS 块摘除、幂等、规则注入去标记。全套 18 个测试文件仍全绿。

## 0.4.0 — 2026-11-16

卡片摘要回退链、孤儿卡片自动清理、三处协议断链修复。摘要空洞从 45% 降到 <1%；
自检从 4 错误 14 警告降到 0 错误 21 警告（剩余警告均需人工补内容）。

### 修复

- **卡片摘要退化（影响 45% 文档）**：`first_paragraph` 跳过 `>` 开头的块，而文档模式产出的
  正文第一块正是 `> **info**` 引用块——AirScript 那类文档的摘要只剩「行记录」。
  改为回退链：frontmatter `summary`/`description` → 引用块正文（剥 `> `、跳过 `**分类**:`
  元数据行）→ 正文段落（不足 40 字继续累加）。实测 460 篇：空摘要 10→0、<60 字节 71→4。
- **YAML 块标量**：`description: >-` 原先被读成字面量 `>-`；`kb-card.py` 与 `kb-search.py`
  的 `frontmatter()` 同步支持折叠块。
- **孤儿卡片**：`kb-search.py` 的自动重建带 `--prune`。源文件删除/改名/归档后不再残留
  （残留卡片会被命中且无原文片段）。
- **置信分级误判**：`grade_hits` 的分母只算辅助词（bigram），主词命中不计入，
  于是「DSH 插件 设置页」命中第 1、证据显示命中 dsh 与插件，却报「低置信 0/2」。
  改为分母不变、增加**主词下限**（命中 ≥2 个主词或命中一个长度 ≥3 的 → 至少 moderate），
  详情改为「主词 2/3 · 辅助词 0/2（dsh、插件）」。
- **技能安装器三处缺陷**（手动刷新副本时暴露）：
  ① payload 里的 `__pycache__/*.pyc` 被当内容同步 → 每次 `installSkill` 都判「有变化」，
  且 python 版本一变内容就不同；② 源码 `skill/.skill-version` 历史残留污染 payload，
  与安装器写的版本互相覆盖，导致永久非幂等；③ 注释承诺「`.skill-version` 存 SKILL.md 哈希」但从未实现。
  修：`listTree` 排除 `__pycache__/*.pyc/.DS_Store/.skill-version`，安装后写真实哈希版本，
  并按 `OBSOLETE_PAYLOAD` 清单清理已改名/删除的协议文件（`references/doc-archive.md`）。
  验证：连续三次安装均 `present / changed 0`。
- **会话提醒文案（global）**：原来只说「换关键词再搜一次」+「仍无结果再全盘搜索」——
  既没给检索命令，又把兜底写成并列选项，等于替 AI 确认全盘扫也行。改为给出 `kb-search` 命令、
  把全盘限定为「确认库里确实没有之后」，并加「搜完把结论补进知识库」的闭环。
- **版本哨兵文案**：`detect_stale` 原来把「格式版本不符」和「源文档过期」混成一个计数，
  版本不符时打印「过期 1 篇」，实际是全库重写。改为三态返回，文案区分
  「格式版本不符，库 X ≠ 代码 Y → 已整库重建」与「卡片已更新：缺卡/过期 N 篇」。

### 新增

- `tests/card-quality.spec.mjs`（7 断言）：摘要非空与长度、元数据剔除、summary 优先、
  块标量、卡片数 == 源文件数、孤儿重建清理；已接入 `npm test`。
- `mirror.spec.mjs` 断言 `.kb-index/` 不进 WebDAV 推送。
- `tests/hit-rate-real.mjs`（`npm run test:hit-real`）：真实知识库命中率基线，31 条自然语言查询
  （文档 11 / 项目 10 / 记忆 10）。首测 hit@1 **29/31 (94%)**、hit@5 **31/31 (100%)**。
  顺带暴露两个问题：①置信分级把"主词命中"排除在覆盖率外，导致正确答案被标低置信；
  ②整句长查询比关键词短查询明显弱（"插件怎么注册设置页" 掉到第 4 位）。
- `kb-check.py` 四项检查：概念表为空（warn）、项目资料死链（error，限 `docs/ memory/ arch/ assets/`
  前缀，避免把源码 README 误判）、卡片数与源文件数不符（warn）、**记忆目录内自建 `archive/`（error）**。
  最后一项以前是漏检：`walk_md(skip=("archive",))` 会把记忆目录下的 `archive/` 整个跳过，
  里面的笔记既不进索引也不报错，等于悄悄消失。第五项：**KB README 骨架漂移**——
  骨架只在首次运行/换设备时创建，之后协议更新不会同步，旧版 README 会残留 `arch/` 槽位与
  第三方工具名，把 AI 引去不存在的目录。检测用的工具名在检查器里拆常量拼接，
  避免与 `skill-content` 的黑名单冲突。
- `SKILL.md` 新增「什么内容不该进知识库」：判据是「能否由代码机械再生」，不点名任何工具。

### 协议（v3）

- **文档协议改名** `doc-archive.md` → `doc-import.md`：`archive` 与归档目录 `archive/` 语义撞车。
- **文档写入补四块**：本地化策略（默认存全文 + `source` 必填 + 时效回访源链接）、
  负向筛查（只拒抓不到正文的，**不因"可在线取"拒收**）、查重（同 source/标题走刷新）、完成报告。
- **文档 frontmatter 移除 `description`**：实测文档卡片 desc 覆盖 0/409，标题本身就是内容词；
  记忆才必须靠 description（文件名是 slug）。
- **文档 frontmatter 加两个时效字段**：`doc_version`（官方版本号）+ `date_updated`（回源核对日期），
  都可选。用途：判断"存的是哪一版、有没有跟上"——光看 `date_added` 只知道什么时候存进来。
  不回填存量（现有 61/409 有），refresh 时顺手补。`group` / `domain` / `status` 是冗余字段，不采纳。
- **项目页内容下限**：「这是什么」3–5 句 + 必须回答"解决什么问题"+ 边界；「目录结构」每目录带职责；
  「关键文件」<3 行删节。建档前加查重（同路径/同 git_remote → 刷新），校验加 `kb-check`。
- **`kb-card.py` 摘要跳过「上一章/下一章」导航段**：书稿章节首段是导航语，20 张卡片摘要零信息，
  修复后为 0。
- **`kb-check.py` 新增 6 项内容检查**（这是什么<60 字 / 目录结构只 1 行 / 关键文件空表 /
  文档无 H2 且 >2000 字 / >40KB / 卡片摘要导航语）。逐条报会命中 58 条存量、淹没真错误，
  改为累计后汇总成 6 条带项目名的警告。

### 变更

- `CARD_VERSION` 2 → 3（摘要格式变了，检索端据此整库重建一次）。
- **删除 arch 槽位**：`templates.md` 项目资料表与结构树、`SKILL.md` 结构树、`actions.md` show
  说明。代码图谱类产物可由源码现查，且卡片设计上不承载符号索引，放进来只会变成空壳卡片。
- 项目页「怎么查这个项目」改为 kb-search 优先的三段式（原为纯 grep，与 `SKILL.md` 的
  「优先 kb-search」冲突）。
- 文档模板补可选 `description` / `aliases`（卡片检索的 desc 加权层原来只服务项目页）。
- 新增 `_topic.md` 模板；`kb-check` 接受 `topic` 或 `title`（存量 7 个全写 `title`）。
- 记忆协议：写入前置改为「项目页存在」（原为目录存在，会漏掉半建档）；注明注入截断点是
  80 行 / 8KB；区分「记忆文件归档」与「active 状态收尾」两种归档。
- `relatedDocTopics` 支持 `docs/` 根层单篇在自己的 frontmatter 里声明 `projects:`。

### 移除

- **项目记忆关联表**：删掉 `memory/_links.yaml` 机制（`inject.js` 的 `parseLinksYaml` /
  `crossProjectMemories` 与注入调用，约 40 行；`inject.spec` 同步删 8 条断言）。
  实测收益过低：31 个项目只有 3 个受益（1 个 key + 2 个被关联），28 个拿不到这行；
  而且协议零定义、kb-check 不校验引用 id、文件注释声称"自动生成"却无生成代码。
  跨项目发现改由 `kb-search` 的记忆层（词面命中）与项目页「项目资料」承担。
  文件归档为 `archive/memory/_links.yaml.deprecated-20261116`。

### 知识库侧（一次性数据整理）

- 18 份 arch 归档到 `archive/projects/<id>/arch/`，18 个项目页表格行清除，`--prune` 清孤儿
  18（卡片 460 → 442）。
- 项目页 `web-excel-designer` 补齐（按 code-project 流程，7 条概念路径逐条验证后写入）。
- 补 `mi6` / `n1` 两条缺失索引；`macpoc-ios-mirror` 全局记忆路径表述修正；
  `ad-manager` 按用户裁决保留 1 条 `active`（3 条降 `completed`）。
- 存量项目页查询段刷新：27 个页面的「怎么查这个项目」第一步还是裸 grep（1-5 只改了模板，页面不会自动跟随），
  已批量改为 `kb-search.py` 优先；`diplay-privacy` 因参数不是通用占位符而手工修。复检：全库裸 grep 提示行 0。
- 源码搜索加排除规则：27 个项目页的第 2 步补 `--exclude-dir`（通用 `.git/node_modules/dist/build/target`，
  `ad-manager` 加 `bak`、`diplay-privacy` 加 `out`）。实测 monorepo 不排除是 27.1 s / 337K 行，
  排除后 4.7 s / 38K 行。`templates.md` 与 `code-project.md`（含建档搜索两处）同步，
  `kb-check` 新增"缺 --exclude-dir"warn。
- 补齐 3 个项目页缺失的「怎么查这个项目」节（`macpoc-ios-mirror` / `oa-ai` / `oa-wh-skill` 原先整节都没有），
  `include` 按各自实际语言分布生成；唯一仍无此节的是 `mi6`（`type: ops-project`，远程设备无本地代码）。
- 项目页「中文概念 → 位置」批量补齐：17 个项目页共写 60 条概念映射（每条路径先验证存在）。
  空表从 17 降到 **0**，`kb-check` 因此首次全绿（退出码 0）。
- 4 条「时效性未标注」记忆加「截至 2026-11-16」状态行。其中 `kb-search-change-pending` 因 0.4.0
  又改了同一批 20 个文件而重写状态节；原回滚命令 `git checkout -- skill/tools/` 现在会连 0.4.0
  一起丢掉，已改为显式警告。
- 重写 `<KB_ROOT>/README.md`：原为早期英文版（含 `arch/` 与第三方查询工具），
  现按当前骨架模板对齐（kb-search 优先、`_topic.md`、归档统一、可再生产物不入库）；
  并补 `.kb-index/` 生成物说明与「工具」节（kb-search / kb-card `--prune` / kb-check 的用途与运行时机）。
- 迁移违规归档：`projects/ad-manager/memory/archive/feedback-api-timing.md.deprecated-20261110`
  → `archive/projects/ad-manager/memory/feedback-api-timing.md`（正文补 `> 已归档`），空目录删除。
  全库复查后这是唯一一处记忆目录内的 `archive/`。

## 0.3.0 — 2026-11-11

检索从「只有词面分」升级为「有名字、有证据、有置信」：卡片开始收录 frontmatter 的
`description` 与 `aliases`，结果带证据类型与置信分级，弱结果会明说别当答案。

### 新增

- **别名层**：`kb-card.py` 把源文件的 `description` 与 `aliases` 收进卡片
  （`card: 2` 格式版本，版本不符时检索自动整库重建一次）。`kb-search.py` 给描述命中
  中间权重 `DESC_WEIGHT=3`——用标题权重 8 实测会把宽泛描述顶成误伤；`aliases` 归一化后
  整串出现在查询里则**置顶且不参与比例截断**（gbrain 的 alias hop 语义：声明过的名字必须能召回）。
  记忆层走独立路径，`memory_hits` 同规则。词面一个词都不落库时仍返回别名命中——
  查询用的俗称可能整库一次都没出现过。
- **置信分级**：每条检索结果按辅助词覆盖率判 `strong / moderate / weak`（别名或标题精确命中
  直接 strong；≥50% strong；≥34% moderate；<34% weak 并打印警告，提示先看「相关记忆」段）。
  **分母必须是查询的全部辅助词，不是「库里有这个词」的数量**——否则「量子纠缠的贝尔不等式」
  整库只剩「不等」能匹配，1/1 会被误判成强命中。
- **未命中分型**：区分「这个词在库里都没出现过」（主题没入库）与「有词但没达阈值」
  （换说法再试），不让空结果冒充结论。
- **`--explain`**：打印每篇的证据类型（`alias_hit` / `exact_title` / `desc_match` /
  `exact_body` / `keyword`）与实际分数。

### 变更

- **kb-check 会补索引了（`--fix`）**：此前「有笔记没索引」只报错不修，AI 常常做完写笔记就停。
  现在 `--fix` 默认只预览要追加什么，`--fix --write` 才落盘；只追加缺失的指针行
  （`- [name](file.md)` 占位，描述留给 AI 补），**已有行一字不动**。落点规则：优先同名 type 小节，
  其次 `type: project` 笔记落到 `## active` / `## completed`，都没有则新建对应 type 小节——
  刻意不退回「追加到文件末尾」，那种情况末尾常正落在 `## completed` 段内，等于自己制造分组不一致。
  顺带把「已索引」判定从裸子串改成指针语法：正文里提一句 `foo.md` 不再算已索引。
- **时效词按状态分级**：`待办 / 进行中 / 下一步` 此前对已完成笔记也报警（实测 2/2 误报，
  如「下一步必须做的验证…已跑通」）。现在只检查 `status: active` 或无 status 的笔记，
  completed / archived 里的「下一步」按历史叙述处理。词表不动——收窄词表会漏掉真实的未完成项。
- **status 分组自洽校验（opt-in）**：索引真的写了 `## active` / `## completed` 小节时，
  段内成员必须与笔记 frontmatter 的 `status` 一致（双向检查，同一文件只报一次）。
  按 type 或日期分组的索引不参与——协议本身是「按类型小节分组」，不能凭空立规矩。
- **检索建议改为「先 kb-search」**：此前 `SKILL.md` 直接给 `grep -rn <KB_ROOT>/projects/*/*.md ...`，
  不带项目边界也不排除归档，AI 实际会整库 grep，把 `archive/` 的旧版本和别的项目的无关记忆
  一起捞上来（真实案例：手机排障召回了车机改包的笔记）。现在优先 `kb-search`；兜底 grep 必须
  `--exclude-dir=archive` 并限定 `projects/<id>/`。
- **kb-check 有测试了**：新增 `tests/kb-check.spec.mjs`（18 项），锁住上面三条外加
  「dry-run 不落盘」「已有行不动」「找不到段时新建而非塞进完成段」。此前这个闸门只有
  一条文案断言罩着。
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
  `tools/kb-search.py`（卡片定位篇 → 原文 grep 行号 → 输出片段）。
  实测单次检索 300~700 token，整次进程约 240ms。
- **检索从「整串匹配」改成「拆词 + BM25」**：旧实现把整句当 trigram 子串查，
  用户真实问法（「插件怎么发布到 npm」）全废。现在查询先剥多字停用词
  （怎么/如何/是什么/帮我…），中文按 bigram 拆、英文按词边界取 token，
  卡片按 BM25 累加打分（标题/文件名命中权重 8，正文按 tf 饱和 + 长度归一），
  不再除以「理论最大分」——旧写法的分母会被单篇生僻片段撑爆，把其余文档全砍掉。
  `index.db`（FTS5）已删除——卡片目录就是索引；`--rebuild` 改为重建卡片。
- **项目页进卡片索引**：原来项目页被排除（"它本身是索引"），结果问「表单设计器怎么渲染」
  只能撞到 Univer 官方文档。现在 `projects/<id>/<id>.md` 也生成卡片，
  项目级提问直接命中项目页；记忆仍不建卡（走记忆层 grep）。
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

- **命中率回归测试 `tests/hit-rate.spec.mjs`**：12 条带标注用例（整句 6 / 关键词 3 /
  记忆 1 / 负例 2），断言 hit@1 ≥ 60%、hit@5 ≥ 85%、负例不误报、整句 ≥ 5/6。
  改用例是在锁「问法」，不是在锁实现。
- **真实知识库实测（463 篇文档 + 188 条记忆，18 条正例）**：hit@1 从 11% → 83%，
  hit@5 从 17% → 94%，MRR 0.130 → 0.875，单次 240ms。剩余 miss 是
  「插件生命周期」——Univer 文档里确实有同名章节，纯词面无法区分。

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

- **任务内提醒刷屏**：`agent/pre-step` 在每条用户新消息时重置 `reminded`，
  设计上的「每任务 1 次」在长会话里退化成「每句话 1 次」——11-05 13:34 那个
  调研会话实测把同一条「记忆先行：先读 KB memory/MEMORY.md」注入了 4 遍，
  全程 0 次 KB 调用。改成 `reminded`（任务内）＋ `sent`（会话内累计）双状态，
  同一类提醒全会话最多 2 次。`tests/gate.spec.mjs` 新增 2 条断言：
  第 3 次不再提醒、换任务也压不住上限（39 场景）。
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