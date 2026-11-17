# local-kb 优化清单

> 生成：2026-11-16 · 依据：源码全量阅读 + 知识库实测 · 状态：仅分析，未改动任何文件
> 范围：插件 host（index.js / inject.js / client.js / install-skill.js）、工具（kb-card.py / kb-search.py / kb-check.py）、协议（skill/ 全部 md）、测试（tests/）、知识库实际数据
> **修订记录见第 9 节。**
> **执行进度（2026-11-16）**：**33 条全部落地**（4-4 的 2 个检索发现已登记，未修） · 自检 4 错误 14 警告 → **0 错误 0 警告（退出码 0）** · `npm test` 17 spec 全绿 · 卡片 443/443
> **补录两批**：2-7/5-6 记忆目录内自建 `archive/`；2-8/5-7 骨架 README 漂移（含旧版工具名）。两批均来自执行中暴露的协议违规，已修并加检查。

## 0. 核查方法与证据基线

读过的文件：

- `index.js`(79KB) `inject.js`(19KB) `client.js`(37KB) `install-skill.js`(17KB) `scripts/kb-migrate.py`
- `skill/SKILL.md` + `references/{actions,agents-snippet,code-project,doc-archive,memory,templates}.md`（939 行全读）
- `skill/tools/{kb-card,kb-search,kb-check}.py`
- `tests/` 16 个 spec
- 知识库：`paths.yaml`、38 个项目目录、460 张卡片、18 个 `MEMORY.md`、7 个 `_topic.md`、18 份 arch、207 篇引用块开头的文档

实测基线：

| 指标 | 值 |
|---|---|
| 卡片数 / 源文件数 | 460 / 460（缺失 0、过期 0，按 `slug_of` 规则核对） |
| 卡片含 `desc:` | 31 / 460（6.7%） |
| 以引用块开头的文档 | 207 / 460（45%） |
| 摘要 < 60 字节的文档卡片 | 71 |
| 项目页总数 / 概念表有内容 | 30 / 7（23%） |
| arch 文件 | 18 份，全部 2026-10-08 生成 |
| `_topic.md` 数 / 缺 `topic:` 字段 | 7 / 7 |
| 项目页提到 kb-search | 0 / 30 |
| kb-check 结果 | 4 错误 / 14 警告，退出码 1 |
| 最大记忆索引 | 63 行（ezplatform-complaint-web），未触发注入截断 |
| 技能内容测试 | 13 passed / 0 failed |

**能力边界基线（易被误解，单列）**：

- `kb-search` 的搜索域 = **知识库内的 md 文件**：卡片源只遍历 `docs/` 与 `projects/`（`kb-card.py:77`），片段定位路径是 `os.path.join(kb_root, card["doc"])`（`kb-search.py:530`），**不读 `paths.yaml`**（grep 零命中）。
- 实测：搜只存在于源码的符号 `SnapshotStore` → 0 条文档命中。源码定位只能 `grep` + `read`。
- 因此"找东西"是两段式：**kb-search 找知识 → grep/read 定位源码**，两者不可互相替代。

---

## 1. P0 — 契约断链（会导致静默降级）

### 1-1 卡片摘要提取器与文档产出格式互斥

- **现状**：`kb-card.py:52` 的 `first_paragraph` 跳过 `#` `>` `|` 开头的块。
- **证据**：`doc-archive.md` 产出的文档正文以 `> **info** 文档信息` 开头（AirScript 53 篇全是）；实测 207/460 篇以引用块开头，71 篇摘要 < 60 字节。退化实例：`docs/AirScript/API/API-数据表-Record.md` 卡片摘要只有"行记录"三字。
- **影响**：摘要权重 1 是文档间唯一的内容区分信号；45% 文档失去它。
- **建议**：`first_paragraph` 扩展回退链：frontmatter `summary` → `description` → 首个引用块正文（剥 `> `）→ 首个非空段落 → 首个二级标题前文本。
- **成本**：~15 行 Python。**不改任何文档。**
- **状态**：✅ 已完成 2026-11-16 · 验证：真实库 460 卡重建，空摘要 10→**0**、短摘要(<60B) 71→**4**；AirScript 卡摘要由"行记录"变为完整正文；`npm test` 全绿
- **顺带修复**：frontmatter 的 YAML 块标量（`description: >-`）原先被读成字面量 `>-`，导致 2 张卡片摘要只剩这个符号。`kb-card.py` 与 `kb-search.py` 的 `frontmatter()` 同步支持折叠块。

### 1-2 `description` 加权层对 93% 卡片失效

- **现状**：`kb-search.py:25` `DESC_WEIGHT = 3`，读卡片 `desc:`（`:172`）。
- **证据**：460 张卡片只有 31 张有 `desc:`（全是项目页）；文档 frontmatter 模板（`templates.md:86`）只有 `title/type/source/date_added`，**没有 description**。
- **影响**：中间权重层只服务项目页。
- **建议**：文档模板补可选 `description`（两个工具已支持，无需改代码）。
- **成本**：2 行模板。
- **状态**：✅ 已完成 2026-11-16 · 验证：`templates.md` 与 `doc-archive.md` 的文档 frontmatter 已含 `description`/`aliases`，写入自检同步；skill-content 13 passed

### 1-3 `_topic.md` 是隐式契约：无模板、无生成流程，却有两个消费方

- **现状**：`kb-check.py:434` 校验 `^topic:`；`inject.js:379` `relatedDocTopics` 读 `projects:`。
- **证据**：`grep _topic templates.md` **零命中**（协议里没有该文件模板）；实测 7 个存量文件 **全部无 `topic:` 字段**（都写 `title:`），kb-check 因此报 7 条警告。
- **建议**：`templates.md` 补模板；`kb-check.py` 校验改为接受 `topic` 或 `title`。
- **成本**：1 段模板 + 3 行校验。
- **状态**：✅ 已完成 2026-11-16 · 验证：`templates.md` 新增「文档主题声明」节；kb-check 接受 `topic|title`，实测警告 14→7（7 条 `_topic` 告警消失）

### 1-4 arch 槽位残留 4 处，产出源已移除

- **证据**：`templates.md:45`（项目资料表"架构"行）、`templates.md:150`（结构树 `arch/`）、`SKILL.md:52`（结构树 `arch/<id>-arch.md`）、`actions.md:17`（show 命令"指向的 arch/docs/memory"）。
- **对照**：`code-project.md` 全文无 arch；`SKILL.md:32` 明写"不提供调用关系与影响面分析"。
- **影响**：留槽位的唯一现实填充手段是外部代码分析工具，与"不依赖第三方工具"冲突。
- **为什么没被测试拦住**：`skill-content.spec.mjs:34` 黑名单只匹配 `/codegraph|graphify/gi`，不含 arch。
- **建议**：删 4 处。**不加 arch 路径黑名单**（理由见 6 节）。
- **成本**：4 处文本。
- **状态**：✅ 已完成 2026-11-16 · 验证：`grep -rn 'arch/' skill/` 无残留；skill-content 13 passed

### 1-5 项目页查询模板教裸 grep，与技能主文件相反

- **现状**：`templates.md`「怎么查这个项目」三步全是 `grep -rn`；`SKILL.md:81` 说知识库内部检索**优先 `kb-search.py`**。
- **证据**：实测 30 个项目页 **0 个**提到 kb-search；`skill-content.spec.mjs` 有一条断言"templates 查询段是纯 grep"，把偏差固化成契约。
- **建议**：模板改为「kb-search 找知识 → grep 源码 → read 确认行号」三段；同步改该断言。
- **成本**：1 段模板 + 1 条断言。
- **状态**：✅ 已完成 2026-11-16 · 验证：`templates.md` 与 `code-project.md` 两处查询段已改 kb-search 优先；断言改为"先 kb-search 再 grep"；skill-content 13 passed
- **存量补齐（用户发现的漏项）**：模板改了但 30 个存量项目页不会自动跟随——实际 27 页仍是旧版裸 grep。
  已批量刷新 **26 页**（正则匹配 `# 1. 先查知识库` + `grep -rn` 两行），另手工修 `diplay-privacy`（它的命令参数不是通用占位符）。
  复检：全库 `grep -rn "<中文关键词>" <KB_ROOT>/projects` 提示行 = **0**；备份在 `/tmp/kb-querysec-backup-*`

---

## 2. P1 — 工具缺陷与护栏缺口

### 2-1 孤儿卡片无法自动清理（通用缺陷，建议第一个做）

- **现状**：`kb-card.py` 默认只写不删，仅 `--prune` 清孤儿（`:161` 解析、`:188` 执行）。
- **证据**：`kb-search.py:449` `rebuild_cards` 调 `subprocess.run([..., card_py, kb_root])`，**不带 `--prune`**；`load_cards`（`:160-180`）不校验 `doc:` 指向的文件存在；`snippets`（`:353`）读不到文件时 `except OSError: return hits`（空）。
- **影响**：源文件删除/改名/归档后，孤儿卡片继续参与打分，命中结果只有标题、无原文片段、无行号——假命中。触发场景不限于 arch：归档文档集、改名文件、删文档都留孤儿。
- **建议**：`rebuild_cards` 增加 `--prune`。安全性：`--prune` 只删不在 `expected` 的卡片，`SKIP_DIRS` 已含 `archive`，不会误删归档内容。
- **成本**：1 行。
- **状态**：✅ 已完成 2026-11-16 · 验证：临时库造孤儿 `docs-gone.md` → `kb-search --rebuild` 后已清除；全量测试 13 passed

### 2-2 kb-check 缺 3 类已存在的坏数据检查

- **证据**（实测存在但未报）：
  1. 概念表为空——30 个项目页中 23 个空；
  2. 「项目资料」表格死链——删 arch 后表格行指向不存在的文件；
  3. 卡片缺失/过期——只有 `kb-search` 的 `detect_stale`（`:92`）自检，kb-check 不管。
- **建议**：各加一条（概念表空 → warn；表格相对链接不存在 → error；卡片数与源文件数不等 → warn）。
- **成本**：~30 行。
- **状态**：✅ 已完成 2026-11-16 · 验证：新增 3 项检查生效——概念表空 **17** 条 warn、项目资料死链 **2** 条 error（`diplay-privacy → README.md`、`macpoc-ios-mirror → memory/ios-usb-mirror-macos.md`）、卡片数一致不报；npm test 17 spec 全绿

### 2-3 记忆写入前置只查目录，不查项目页（已发生）

- **现状**：`memory.md` 写"写项目记忆前检查 `projects/<id>/` 是否存在"。
- **证据**：`projects/web-excel-designer/` 只有 `memory/`，**项目页缺失**，`paths.yaml` 有条目；kb-check 报"项目页缺失"。
- **影响**：可绕过项目页写入记忆，得到一个模型无法通过项目页发现的项目。
- **建议**：前置条件改为"项目页 `<id>.md` 存在"。
- **成本**：协议 1 句。
- **状态**：✅ 已完成 2026-11-16 · `memory.md` 前置条件改为项目页存在，并写明半建档后果

### 2-4 概念表为空时静默

- **现状**：`inject.js:490-493`：`concepts` 非空才输出「已收录」。
- **证据**：`conceptKeywords`（`:353`）读「中文概念 → 位置」表；30 个项目页仅 7 个有内容。
- **建议**：空表时输出"概念表未填，定位请现读源码"。
- **成本**：1 行。
- **状态**：✅ 已完成 2026-11-16 · 实测 `knowledgeMapText` 对 dsh-plugins 输出"概念表未填：项目页「中文概念 → 位置」为空，定位请现读源码"（仅 code-project 类型）

### 2-5 `docs/` 根层单篇文档无法声明归属项目

- **现状**：`relatedDocTopics`（`inject.js:379`）只遍历 `docs/` 下的**目录**。
- **证据**：根层有 2 篇单文件：`OmniRoute配置手册.md`、`n1-service-commands.md`。
- **建议**：允许文档 frontmatter 写 `projects: []`；`relatedDocTopics` 同时扫根层文件。
- **成本**：~20 行 JS + 1 行模板。
- **状态**：✅ 已完成 2026-11-16 · `inject.js` 抽出 `projectListOf()` 并同时扫根层 `.md`；`inject.spec` 新增 2 断言（57 passed）

### 2-6 协议缺"什么内容不该进知识库"的判据（根因护栏，新增）

- **现状**：协议只写"存什么"（模板、字段、归属），没写"什么不该存"。arch 存量就是缺这条的直接后果。
- **为什么不加路径黑名单**：见 6 节——路径黑名单是替身防御，且会误伤手写内容。
- **建议条文**（零第三方工具名，替代路径为纯文件系统）：

  ```md
  ### 什么内容不该进知识库

  不是"报告"，而是"可由代码机械再生的产物"：调用关系图、符号/依赖清单、
  覆盖率、构建产物摘要——同一份代码重跑一次就能原样得到的东西。

  判据：代码变了，这份文档还剩多少有效？
    全失效 → 快照，不存；结论还在 → 知识，可存。

  反例：逆向破解结论含实验与试错，不可再生 → 要存。
        代码图谱类产物不存；需要时现查：先 kb-search 看库里有没有现成结论，
        再 grep 源码、读文件确认行号。
  ```

- **局限（必须明说）**：kb-check 无法自动判定一份 md 是快照还是结论，这条只能约束 AI + 用户 review，**没有自动强制**。
- **成本**：1 段协议 + 测试注释补理由。
- **状态**：✅ 已完成 2026-11-16 · 已写入 `SKILL.md:35` 新增节「什么内容不该进知识库」，零工具名；skill-content 13 passed

### 2-7 记忆目录内自建 `archive/` 不被拦截（协议明令禁止，检查器却不管）

- **现状**：`memory.md` 第 21 行明写"归档不放在记忆目录里，统一进 `<KB_ROOT>/archive/`"；但 `kb-check` 的记忆遍历用 `walk_md(skip=("archive",))`，把记忆目录下的 `archive/` 直接跳过。
- **实测**：真实库存在 `projects/ad-manager/memory/archive/feedback-api-timing.md.deprecated-20261110`（2026-11-10 创建，948 B）。里面的笔记**既不进索引也不报错**——召回永远看不到，也没人知道它还在。
- **建议**：kb-check 增加结构检查，记忆目录出现 `archive/` 即报 error。
- **成本**：6 行。
- **状态**：✅ 已完成 2026-11-16 · 真实库 0 错误；临时库反向验证能报出"记忆目录内不得建 archive/"；违规文件已迁到 `archive/projects/ad-manager/memory/feedback-api-timing.md`（正文加归档标记），空目录已删

### 2-8 骨架文件漂移：KB README 与模板脱节，还残留旧工具名

- **现状**：`templates.md` 的「骨架文件模板」只在**首次运行/换设备**时创建；之后协议改了，已存在的 `<KB_ROOT>/README.md` 没人同步。
- **实测**：真实库 README 是更早的英文版，含 `arch/ ← architecture summary`、`codegraph query/explore`（检索与验证两处）、没有任何 kb-search 提示。它会直接把 AI 引去不存在的目录、并暗示要用第三方工具查代码。
- **为什么测试没拦住**：`skill-content.spec` 只扫 `skill/`，KB 根目录的 README 在扫描范围外。
- **建议**：kb-check 检查 README 是否含旧骨架标记（`arch/`、旧工具名）；工具名在检查器里拆常量拼接，避免和 skill-content 的黑名单冲突。
- **成本**：10 行。
- **状态**：✅ 已完成 2026-11-16 · 真实库 README 按当前模板重写（含 kb-search 优先、`_topic.md`、归档统一、可再生产物规则）；kb-check 新增漂移检查，临时库反向验证能报错；skill-content 13 passed

### 2-9 卡片版本哨兵：文案谎报「过期 1 篇」+ 两处常量无测试

- **现状**：`detect_stale` 把「格式版本不符」和「源文档 mtime 过期」混成一个计数。版本不符时返回 `(0, 1)`，
  `main` 打印「卡片已自动更新（过期 1 篇）」——实际 `kb-card.py` 把 443 篇**全部重写**。
- **第二个缺口**：`kb-card.py:20` 与 `kb-search.py:21` 的 `CARD_VERSION` 靠人工同步，全仓无断言。
  只改一处的后果是：每次检索都判版本不符 → 每次整库重建 443 个文件，不报错、只是变慢。
- **建议**：`detect_stale` 返回三元组区分两种情况；文案改为「格式版本不符，库 X ≠ 代码 Y → 已整库重建」；
  测试断言两处常量一致、且版本不符时不出现「过期 N 篇」。
- **状态**：✅ 已完成 2026-11-16 · 三种场景实测文案正确——版本不符 →「已整库重建」、
  源更新 →「卡片已更新：过期 1 篇（源文档更新）」、`--no-auto` → 只提示；
  `card-quality.spec` 10 passed（含两条新断言），`npm test` 17 spec 全绿

### 2-10 项目页源码搜索缺 `--exclude-dir`（会扫进 node_modules）

- **现状**：`templates.md` 与 27 个存量项目页的第 2 步都是
  `grep -rn "<中文关键词>" "<本机路径>" --include="*.js" ...`，没有任何排除规则。
- **实测代价**（deepseek-harness，`node_modules` 86,436 个文件）：
  不排除 → **27.1 s / 337,534 行**；排除后 → **4.7 s / 38,560 行**（5.7× 时间、8.8× 噪音）。
  另一例 `ezplatform-base-web`：命中 125 行全在 `dist/`，源码里其实没有该词。
- **处理**：按项目定制排除规则——通用 `.git node_modules dist build target`，
  `ad-manager` 另加 `bak`、`diplay-privacy` 另加 `out`；批量刷新 **27 页**。
  同步改 `templates.md`、`code-project.md`（含建档时的概念搜索与中文线索搜索两处）。
- **护栏**：`kb-check` 新增检查——「怎么查」节的 `grep -rn` 缺 `--exclude-dir` 报 warn。
  反向验证：临时库造缺规则页面能报出；真实库 0 警告。
- **状态**：✅ 已完成 2026-11-16 · 27 页 + 模板 2 处 + 检查 1 条；备份 `/tmp/kb-grep-exclude-backup-*`；
  卡片重建 443；`npm test` 17 spec 全绿

---

## 3. P2 — 协议细化

### 3-1 `projects/<id>/docs/` 声明了但基本没人用
- **证据**：19 个项目里只有 `ad-manager/docs` 有 3 篇。
- **判断**：不是 bug（卡片索引覆盖该目录），是边界未被执行。建议在 `doc-archive.md` 写清"项目内产出进这里、跨项目进 `docs/`"。
- **成本**：协议 2 句。
- **状态**：✅ 已完成 2026-11-16 · `doc-archive.md` 归属判定加判据："换一个项目还用得上吗？用得上 → `docs/`；只对这个项目成立 → 项目 `docs/`"

### 3-2 文档 callout 规范与存量 45% 冲突
- **证据**：`doc-archive.md` 写"正文开头不加装饰 callout"；实测 207 篇以 `> **info**` 开头。
- **判断**：存量来自旧版流程。**不要批量改 207 个文件**；由 1-1 让提取器兼容。
- **成本**：0。
- **状态**：✅ 已完成 2026-11-16 · 未改任何文档；提取器已能剥离 `> ` 并跳过 `**分类**:` 元数据行，引用块开头的文档摘要恢复正常

### 3-3 归档口径在同一文件里两处范围不同
- **证据**：`memory.md`「归档仅发生在索引超过上限时」vs 同文件检查点「`active → completed` 时瞬时状态移出到 `archive/`」。
- **判断**：对象不同（记忆文件 vs 状态内容），但同文件两口径易误读。
- **成本**：1 句。

### 3-4 注入上限（80 行/8KB）与协议上限（150 警告/200 硬拦）口径不同
- **证据**：`inject.js:20`；`memory.md`。实测最大 63 行**未触发**；触发时有"已截断"提示，不静默。
- **判断**：不是 bug，是阈值冗余。建议协议注明"80 行是注入硬截断点"。
- **成本**：1 句。
- **状态**：✅ 已完成 2026-11-16 · `memory.md` 已注明"注入截断点是 80 行 / 8KB，150/200 是文件策展上限"

### 3-5 文档侧无 `aliases` 支持
- **证据**：`kb-search.py:246` `alias_hit` 只读卡片 `alias:`；只有项目页模板有 `aliases`。
- **建议**：与 1-2 同一处改。
- **成本**：1 行。
- **状态**：✅ 已完成 2026-11-16 · 已随 1-2 在文档模板中补 `aliases`

---

## 4. P2 — 测试护栏

### 4-1 无卡片质量测试
- **证据**：16 个 spec **没有一个断言摘要非空率或长度**；71 篇空壳摘要因此长期无人发现。
- **建议**：新增 `tests/card-quality.spec.mjs`：构造"引用块开头"的文档，断言摘要 ≥ 40 字节；并断言卡片数 == 源文件数（覆盖孤儿）。
- **成本**：1 spec。
- **状态**：✅ 已完成 2026-11-16 · 验证：`card-quality.spec.mjs` **7 passed**（引用块摘要、元数据剔除、summary 优先、块标量、卡片数==源、孤儿清理），已接入 `npm test`

### 4-2 技能内容黑名单保持只防工具名，**不加 arch**
- **证据**：`skill-content.spec.mjs:9` 扫 `skill/` 全目录；`:34` 黑名单 `/codegraph|graphify/gi`。实测当前 13 passed / 0 failed。
- **为什么不加 arch**：见 6 节。加了会在你手写 `arch/` 时误伤。
- **建议**：只在测试注释里补一句理由——"工具名出现 = 能力暗示 = 诱导安装"，不改匹配规则。
- **成本**：1 行注释。
- **状态**：✅ 已完成 2026-11-16 · `skill-content.spec.mjs` 黑名单段补了理由注释；顺带清理 `inject.spec` 里残留的工具名测试数据；13 passed

### 4-3 同步排除项无断言
- **证据**：`index.js:808-817` `SYNC_EXCLUDE` 含 `^\.kb-index/`，测试未断言"卡片不进同步"。
- **建议**：`mirror.spec` 补一条。
- **成本**：1 条断言。
- **状态**：✅ 已完成 2026-11-16 · `mirror.spec` 造 `.kb-index/cards/*` 并断言"卡片索引不进推送""远端不含卡片"；21 passed

### 4-4 真实知识库命中率基线（`tests/hit-rate-real.mjs`）
- **现状**：原有 `hit-rate.spec.mjs` 只在**临时库**上测 10 条构造查询，从未测过真实 443 篇 / 236 条记忆。
- **做法**：31 条"用户会怎么问"的自然语言查询（不用卡片原词，避免循环论证），分文档 11 / 项目 10 / 记忆 10；
  `npm run test:hit-real` 手动跑（依赖真实库路径，不进 `npm test`）。
- **实测（2026-11-16）**：

  | 类别 | hit@1 | hit@3 | hit@5 |
  |---|---|---|---|
  | 文档 | 9/11 | 10/11 | **11/11** |
  | 项目 | 10/10 | 10/10 | 10/10 |
  | 记忆 | 10/10 | 10/10 | 10/10 |
  | **合计** | **29/31 (94%)** | **30/31 (97%)** | **31/31 (100%)** |

- **发现 1（真 bug，已修）**：置信分级误判。`grade_hits` 的覆盖率分母只算辅助词（bigram），
  主词命中不算——"DSH 插件 设置页" 命中第 1、`--explain` 显示命中 dsh 与插件，却报"低置信 0/2"。
  修法：**分母仍只用辅助词**（把 prim 混进分母会让原本可信的查询集体降级，实测低置信 4→6），
  只加一条**主词下限**：命中 ≥2 个主词、或命中一个长度 ≥3 的主词 → 至少 moderate。
  效果：`置信：moderate（主词 2/3 · 辅助词 0/2（dsh、插件））`。
  修复中踩两个坑：①把 prim 加进分母 → 集体降级；②改掉 `if not sec` 短查询分支 → "F2 是什么框架"被误判 weak（分母 0）。均已回退。
- **发现 2（长句退化）**："插件怎么注册设置页" 掉到第 4 位（被 GitHub Actions 的"设置"类文档挤占），
  而短句 "DSH 插件 设置页" 是第 1 位。整句提问比关键词查询明显弱。
- **状态**：✅ 已完成 2026-11-16 · 脚本落地 + npm script 接入。
  发现 1（置信误判）已修，真误判 1 → 0；发现 2（长句退化）按用户要求**未动**。
  改完命中率不变：hit@1 29/31、hit@5 31/31；`hit-rate.spec` 13 passed、`npm test` 17 spec 全绿。
  **测试统计口径也修了**：低置信原先按整份输出判断，导致记忆类查询因文档段没命中被误记成误判，现按期望类别只看对应段落。

---

## 5. 数据层现状（后续重构，需要整理）

### 5-1 arch 存量 18 份 —— **保留为独立任务**
- **证据**：全部 `2026-10-08` 生成（38 天未更新）；9 份为压缩符号/三方库噪音（`b()`/`d()`/`jquery`/`compilerOptions`）；18 张卡片摘要 4–20 字节。
- **执行顺序（不能反）**：
  1. 归档 18 份到 `archive/projects/<id>/arch/`
  2. 改 18 个项目页「项目资料」表格行（去掉架构行）
  3. `python3 skill/tools/kb-card.py <KB> --prune`
- **为什么顺序不能反**：先删文件不 prune，18 张孤儿卡片会继续被检索命中且无原文片段（见 2-1）。
- **状态**：✅ 已完成 2026-11-16 · 验证：18 份移入 `archive/projects/<id>/arch/`；18 个项目页表格行清零；`--prune` 清孤儿 **18**，卡片 **460→442**；搜"架构"已返回真实内容（deepseek-harness 描述、Univer Facade），不再是空壳；回滚备份在 `/tmp/kb-arch-backup-*`

### 5-2 kb-check 报的 4 个错误
1. `projects/ad-manager/memory` 有 4 条 `status: active`（协议：每目录最多 1 条）
2. `projects/mi6/memory/mi6-usb-ethernet.md` 未被索引
3. `projects/n1/memory/n1-dsh-slow-rootcause.md` 未被索引
4. `projects/web-excel-designer/web-excel-designer.md` 项目页缺失

**当前进度**：错误 6 → **2**（已补 mi6/n1 两条索引；已把 macpoc 的全局记忆表述改为 `<KB_ROOT>/memory/...`；kb-check 死链检查收窄到 `docs/ memory/ arch/ assets/` 前缀，避免把源码 README 误判）。
剩余 2 条需用户裁决：ad-manager 的 4 条 `active`（接管协议要求用户裁决）+ web-excel-designer 建档与否。

**状态**：✅ 已完成 2026-11-16 · 错误 **6 → 0**、警告 **24 → 21**。做法：补 mi6/n1 两条缺失索引；macpoc 表格改为 `<KB_ROOT>/memory/...`；死链检查收窄到 `docs/ memory/ arch/ assets/` 前缀（避免把源码 README 误判）；按用户裁决把 ad-manager 3 条 active 降 completed（顺带消 3 条时效性警告）；web-excel-designer 按 code-project 流程建档。
**剩余 21 条警告均需人工**：17 条概念表为空（要人工写中文概念）+ 4 条时效性内容（要判断是否历史化）。

### 5-3 kb-check 报的 14 个警告
- 7 条记忆含未标注时效性内容（ad-manager 4、dsh-plugins 1、scripts 1、web 1）— 待人工判断是否历史化
- ~~7 个 `_topic.md` 缺 `topic` 字段~~ → **已消除**（kb-check 接受 `title`）
- 新增 17 条「项目页概念表为空」warn（由 2-2 检查产出，属内容待补项）
- **状态**：✅ 已完成 2026-11-16 · `_topic` 7 条已消除；时效性 7 → 4 → **0**。四条都加了「截至 2026-11-16」状态行：
  - `request-optimization-identity-axis`（ad-manager）→ 进行中，指向「下一步（卡点）」节
  - `glados-turnstile-blocks-airscript`（scripts）→ 已实测，遗留见「待办」节
  - `excel-designer-worktree`（web）→ 布局已落地，改动进行中
  - `kb-search-change-pending`（dsh-plugins）→ **内容过时，已重写**：0.4.0 又改了同一批 20 个文件，
    `CARD_VERSION` 已 2→3；原回滚命令 `git checkout -- skill/tools/` 现在会连 0.4.0 一起丢掉，已改为警告

### 5-4 概念表填充率 23%
- 30 个项目页，7 个有数据行。
- **状态**：✅ 已完成 2026-11-16 · 17 个空表全部补齐，共写入 **60 条**概念映射（3–6 条/项目），
  每条路径都先用 `ls`/`[ -e ]` 验证存在才写，标注「验证：读文件/读目录」。
  覆盖：dsh-plugins、scripts、wx、ad-manager、adverse-events、ai、contract、designer、devportal4-0、
  deepseek-harness、web-lite、ezplatform-dj、mobile、web、ezplatform-gh、localminidrama、mediflexsdd

### 5-5 卡片索引本身是健康的
- 原 460 卡片 = 460 源文件，缺失 0、过期 0。
- **状态**：✅ 已完成 2026-11-16 · arch 归档后经 `--prune` 重建为 **443 卡片 = 443 源文件**（清 18 孤儿 + 新增 web-excel-designer 卡片）

### 5-6 记忆目录内的违规归档（1 处）
- **证据**：`projects/ad-manager/memory/archive/feedback-api-timing.md.deprecated-20261110`（2026-11-10，948 B，`type: feedback`，已从索引移除指针）。
- **处理**：迁到 `archive/projects/ad-manager/memory/feedback-api-timing.md`，正文补 `> 已归档 2026-11-16`；空目录删除。全库复查：这是唯一一处。
- **状态**：✅ 已完成 2026-11-16 · `find projects -type d -name archive -path '*/memory/*'` 现返回空

### 5-7 `<KB_ROOT>/README.md` 是旧版骨架
- **证据**：原 README 为早期英文版——结构树含 `arch/`、检索与规则两处点名第三方查询工具、无 kb-search 提示。
- **处理**：按 `templates.md` 当前骨架重写（中文；kb-search 优先；`_topic.md`；归档统一放根层；可机械再生的产物不入库）。
- **状态**：✅ 已完成 2026-11-16 · 重写完成并与模板逐项对齐（kb-search.py / _topic.md / 自建归档 / 机械再生 四项抽查一致）
- **追加（用户选定只补 1、3）**：结构树补 `.kb-index/`（生成物：不进同步、删了自动重建），新增「工具」节说明三个脚本用途与运行时机（kb-search / kb-card `--prune` / kb-check）

### 5-8 删除项目记忆关联表机制（`memory/_links.yaml`）
- **原机制**：显式声明 A → [B, C]，注入时在 A 的上下文里列 B 的记忆指针（最多 3 条，双向生效）。`inject.js` 的 `parseLinksYaml` + `crossProjectMemories` 约 40 行。
- **价值评估**：机制本身有真实场景（兄弟仓库互相发现——查 base-web 时不知道还有 worktree 工作区），但**实测收益极低**：31 个项目里只有 3 个受益（1 个 key + 2 个被关联），28 个完全拿不到这行；当前项目 dsh-plugins 也没有。
- **额外问题**：协议零定义（`grep _links skill/` 零命中）、kb-check 不校验引用 id、文件注释说"路径上的父子关系自动生成"但全仓无生成代码、内容还不全（oa-ai 该关联 5 个子项目只写了 2 个）。
- **决策（用户选 B：删掉）**：删除 `parseLinksYaml` / `crossProjectMemories` 与注入调用；`inject.spec` 删 8 条相关断言；`memory/_links.yaml` 归档为 `archive/memory/_links.yaml.deprecated-20261116`（遵守"只归档不删除"）。
- **状态**：✅ 已完成 2026-11-16 · 代码引用清零（`grep parseLinksYaml|crossProjectMemories|_links` 无源码命中）；`inject.spec` 49 passed；`npm test` 17 spec 全绿；跨项目发现改由 kb-search 记忆层 + 项目页承担

### 5-9 存量项目页查询段仍是裸 grep（用户发现）
- **证据**：30 个项目页里 **27 个**的「怎么查这个项目」第一步还是 `grep -rn "<中文关键词>" <KB_ROOT>/projects/<id>/`。
  原因：1-5 只改了**模板**（新建项目页用），存量页面没有 `refresh` 就不会重算。
- **处理**：正则批量替换 26 页（`# 1. 先查知识库` + 紧随的 `grep -rn` 两行），另手工修 `diplay-privacy`
  （它的参数是具体词而非通用占位符）。备份 `/tmp/kb-querysec-backup-*`。
- **复检**：全库 `grep -rn "<中文关键词>" <KB_ROOT>/projects` 提示行 = **0**；卡片重建 443；
  kb-check 0 错误 0 警告。
- **状态**：✅ 已完成 2026-11-16 · 27 → 0

---

## 6. 已排除的"优化项"（避免误改）

| 项目 | 结论 | 理由 |
|---|---|---|
| 卡片排除 `arch/`（原 2-2） | **撤销** | 路径黑名单是替身防御。graphify 生成物移除后 `arch/` 只是普通目录名；用户手写的模块划分结论是知识，排除会让它在 kb-search 里隐形。已有 `SKIP_DIRS`（archive/node_modules/.git/.kb-index）都有明确语义，arch 没有 |
| 测试黑名单加 arch | **不加** | 同上，会在用户手写 arch 时误伤 |
| 批量改 207 篇 callout | **不做** | 改动面过大；由 1-1 提取器兼容 |
| 引入代码图谱类工具补 arch | **不做** | 违反"不依赖第三方工具"；KB 卡片设计上就不是符号索引（卡片只存摘要+二级标题，不存正文符号） |

## 7. 已排查但**不是**问题

| 怀疑 | 核对结果 |
|---|---|
| `inject.js` `readCached` catch 返回 `[]` 致类型错 | **不是**。函数体为 `value = undefined`，逐行核对 |
| 注入截断静默丢记忆 | **不是**。有"已截断"提示；当前最大 63 行未触发 |
| `kb-card` 会索引 `archive/` | **不是**。`SKIP_DIRS` 含 archive（`kb-card.py:18`、`kb-search.py:34`） |
| 卡片过期 | **不是**。460/460 同步 |
| 门禁误伤 | **不是**。`gate.spec` 覆盖；只拦根/home 一级目录的 grep/rg，`find/locate/mdfind` 明确不拦 |
| 索引硬上限无拦截 | **不是**。`kbGuard` + `indexCapGuard` 拦 200 行/25KB |
| 技能安装覆盖用户手改 | **不是**。SHA-256 `.skill-version` + 标记块，只刷新 payload |
| 注入无预算上限 | **不是**。`MAP_MAX_PROJECTS=60`、`RECHECK_MS=10s`、`INDEX_READ_LIMIT=1MB`、记忆段 80 行/8KB |
| kb-search 应该能搜源码 | **不能**。搜索域 = KB 内 md，不读 paths.yaml；实测 `SnapshotStore` 0 命中 |

---

## 8. 执行顺序

| 序 | 条目 | 收益 | 成本 |
|---|---|---|---|
| 1 | 2-1 `rebuild_cards` 带 `--prune` | 孤儿卡片自动清理，5-1 的前置 | 1 行 |
| 2 | 1-1 摘要提取链 | 修复 45% 文档检索质量 | 15 行 |
| 3 | 4-1 卡片质量测试 | 锁住 1-1 收益 | 1 spec |
| 4 | 1-4 删 arch 槽位 + 2-6 生成物判据 | 切断回流 + 根因护栏 | 4 文本 + 1 段 |
| 5 | 1-5 查询模板改 kb-search 两段式 | 存量可 refresh + 未来默认 | 1 段 + 1 断言 |
| 6 | 1-2 + 3-5 文档模板补 description/aliases | 让 93% 卡片用上加权层 | 2 行 |
| 7 | 1-3 `_topic` 模板 + 校验兼容 | 消除 7/7 违规 | 1 段 + 3 行 |
| 8 | 2-2 kb-check 三项检查 | 概念表/死链/卡片可见 | ~30 行 |
| 9 | 2-3 记忆前置改项目页 | 堵半建档 | 1 句 |
| 10 | 2-4 + 2-5 注入优化 | 23 项目 + 2 篇单篇可见 | ~20 行 |
| 11 | 3-x 协议细化 | 消除口径歧义 | 4 句 |
| 12 | 4-2 注释 + 4-3 同步断言 | 防误改 | 2 行 |
| 13 | **5-1 arch 数据整理** | 清 18 份过期 + 18 张空壳卡 | 独立任务 |
| 14 | 5-2/5-3 数据修复 | 消除 4 错误 14 警告 | 独立任务 |

## 9. 变更文件清单

- 代码：`skill/tools/kb-search.py`、`skill/tools/kb-card.py`、`skill/tools/kb-check.py`、`inject.js`
- 协议：`skill/references/templates.md`、`skill/references/doc-archive.md`、`skill/references/actions.md`、`skill/references/code-project.md`、`skill/SKILL.md`、`skill/references/memory.md`
- 测试：`tests/skill-content.spec.mjs`、`tests/mirror.spec.mjs`、新增 `tests/card-quality.spec.mjs`
- 数据（后续）：18 份 arch、18 个项目页表格、`_topic.md` × 7、4 条错误记忆、卡片 prune

---

## 10. 修订记录

**v2（2026-11-16，本轮）**

1. **撤销**原 2-2「kb-card 排除 `/arch/`」——路径黑名单是替身防御，会误伤用户手写的 arch 内容。
2. **撤销** 4-2 里"黑名单加 arch"，只保留补注释。
3. **新增 2-6**「什么内容不该进知识库」判据：防御粒度为"可机械再生"，零第三方工具名，替代路径为 kb-search + grep/read 两段式。
4. **新增 0 节能力边界基线**：kb-search 不搜源码（实测证据），避免"遗漏 kb-search"的误读。
5. **保留并强化 5-1**：arch 数据整理仍是必需任务，明确"归档 → 改表格 → prune"的强制顺序。
6. **新增 6 节**：把已排除的 4 个"优化项"连同理由固化，防止后续反复。

**v1**：初次成稿，24 条。

---

> 所有断言均可复核：代码行号对应当前 HEAD；数据指标来自 2026-11-16 的实测命令。
> 本清单中出现的历史工具名仅作事实记录，**不得复制进 `skill/` 目录**（`tests/skill-content.spec.mjs` 会拦截）。
