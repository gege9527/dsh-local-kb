# 代码模式

把本地代码项目索引进知识库。**只存索引，不存源码**。路径不写进笔记，只存 paths.yaml。
工具（codegraph / graphify）是**加速器，不是依赖**：由 AI 直接调用，技能不检查安装。
缺工具 → 提示用户安装 → 不阻塞，按 AI 现有能力降级保存/查询，并加可信度标注。
完整流程见 SKILL.md「工具缺失流程」。

## 步骤 1 — 路径与 ID

- 确定本机绝对路径 `<path>`（必须存在）。
- 确定稳定 `project_id`：kebab-case（英文/拼音/ASCII），优先 `package.json` 的 `name`，否则目录名。
- 查 `<KB_ROOT>/paths.yaml`：ID 已存在 → 属 refresh；不存在 → 新增映射。
- 记录 git_remote：`git -C <path> remote get-url origin`，无则 `none`。

## 步骤 2 — 建本地索引（可选 · 有工具才做）

**先探测**：`command -v codegraph graphify`（本会话已探测过则跳过）。

```bash
codegraph init "<path>"                     # 无 .codegraph 时才建（位置参数）
codegraph sync "<path>"                     # 已有 .codegraph 时刷新
graphify extract "<path>" --code-only       # 无 graphify-out 时首建（AST，无需 LLM）
graphify update "<path>"                    # 已有 graphify-out 时增量
```

- **缺 codegraph** → 跳过本步，提示用户安装，本次标记为降级建档，继续步骤 3。
- **缺 graphify** → 跳过图谱步骤（架构页本就可选），不影响建档。
- 含文档/图片需要语义提取的项目：`graphify extract "<path>"`（去掉 --code-only，需 LLM，按 graphify 技能完整流程）。
- AI **不自行安装**这些工具。

## 步骤 3 — 提取元数据

**有 codegraph**：库先复制再读，避免写锁。

```bash
TMP=$(mktemp -d)
cp "<path>/.codegraph/codegraph.db" "$TMP/db.sqlite"
DB="$TMP/db.sqlite"

# 语言分布
sqlite3 -json "$DB" "select language, count(*) n from files group by language order by n desc"

# 一级目录分布
sqlite3 -json "$DB" "select substr(path,1,instr(path||'/','/')-1) top, count(*) n from files group by top order by n desc limit 12"

# 关键文件（排除生成物）
sqlite3 -json "$DB" "select path, node_count from files where generated=0 and path not like '%node_modules%' order by node_count desc limit 15"
```

graphify 报告（若存在）：读 `<path>/graphify-out/GRAPH_REPORT.md`，取 Summary / God Nodes / Communities / Hyperedges。

**无 codegraph（降级元数据）**：AI 直接提取，只写确证内容：
- 技术栈 / 依赖 → 读 `package.json` / `pom.xml` / `go.mod` / `requirements.txt` / `Cargo.toml`
- 描述 → 读 `README*` 首段
- 目录结构 → 列 1–2 层目录 + `git ls-files` 取样
- 语言分布 → 按扩展名统计：`git ls-files | sed "s/.*\.//" | sort | uniq -c | sort -rn | head`
- 关键文件 → 入口文件（`main.*` / `index.*` / `app.*`）+ README 点名文件
- 读不到的项留空，**不估算、不编造**。

## 步骤 4 — 确定名称、描述、别名

- **名称**：`package.json` 的 `name` → 否则目录名。
- **描述**（优先级从高到低，非空即用）：README 正文首段 → package.json description → 由代码结构推断。
- **别名**：用户提供的 + 目录名 + 描述关键词（供中文检索）。

### 代码结构推断描述

1. 各版本/子目录名 → 是否多版本并存
2. 关键文件的包名/模块名（Maven `groupId:artifactId`、顶层目录）
3. 依赖与技术栈（框架、UI 库、语言分布）
4. 业务关键词（实体类名、服务名、页面组件名）

输出一句话：`<它是什么> + 主要模块/用途`。禁止只写项目名本身。

## 步骤 5 — 更新 paths.yaml

```yaml
<project_id>:
  path: <本机绝对路径>       # 换设备 / 项目移动只改这里
  git_remote: <url | none>
```

## 步骤 6 — 写笔记

必须读 `templates.md` 全文，按模板写。

1. **项目主页**：`<KB_ROOT>/projects/<project_id>/<project_id>.md`
2. **架构页**（仅当 `graphify-out/GRAPH_REPORT.md` 存在）：`<KB_ROOT>/projects/<project_id>/arch/<project_id>-arch.md`
3. **「中文概念 → 位置」表**是核心。写前逐条验证，**命中才写，未命中不写**（避免假位置）。
   有 codegraph：
   ```bash
   codegraph query "<概念关键词>" -p "<path>"
   ```
   无 codegraph（降级验证）：
   ```bash
   grep -rn "<概念关键词>" "<path>" --include="*.py" --include="*.js" --include="*.ts" --include="*.java"
   ```
   命中后打开文件确认行号。**表内注明验证方式**（codegraph / grep），供后续判断可信度。

   **中文线索采集（写入时必须做）**：
   - 有 codegraph：从库提取含中文注释/docstring 的节点，取核心业务词：
     ```bash
     sqlite3 "$DB" "select name, file_path, docstring from nodes where docstring glob '*[一-龥]*' limit 30;"
     ```
   - 无 codegraph：直接搜中文注释/README 找线索：
     ```bash
     grep -rn "[一-龥]" "<path>" --include="*.py" --include="*.js" --include="*.ts" | head -50
     ```
   - 每个中文业务词先按上文方式验证命中 → 命中才入表。
   - 表应覆盖：注释高频词、页面/模块中文名、用户会说的功能说法。

### 写前 Checklist

- [ ] `title` 项目名 / `type`: `code-project`
- [ ] `description`：一句话，非空，不重复项目名
- [ ] `aliases`：中文别名数组
- [ ] `project_id`：kebab-case 稳定 ID（与 paths.yaml 一致）
- [ ] `git_remote`：remote 或 `none`
- [ ] `engines`: 记录**实际使用**的引擎（如 `["codegraph", "graphify"]`；无工具写 `["ai-direct"]`）——绝不写没装的
- [ ] 概念→位置表每条已验证命中，且已注明验证方式（codegraph / grep）
- [ ] 降级建档：已加可信度标注行（见 `templates.md`）

**内容边界**：不写全量符号表、不写快变字段（符号/文件数、commit、引擎版本）、不复制源码。

## 步骤 7 — 校验

1. `paths.yaml` 含该 `project_id`，指向路径存在。
2. 读回笔记，概念→位置表里每个相对路径在 `<path>` 下真实存在。
3. 笔记内普通链接指向的文件存在。

## 刷新（refresh <名>）

> 也是**降级产物升级**的入口：工具后装 → 用户确认 → refresh 重跑，去掉降级标注。

1. 有 codegraph/graphify → `codegraph sync "<path>"` / `graphify update "<path>"`；
   无 → 重新读源码（走步骤 3 降级路径）
2. 重跑步骤 3 提取，覆写项目页（保留用户手写的「中文概念 → 位置」表；
   **重算「项目资料」节**——重新扫描 `<KB_ROOT>/projects/<id>/arch/`、`docs/`、`memory/` 的实际文件，新增/移除同步更新）
3. 校验

## 定位时的现查命令（写入项目页「怎么查」）

```bash
codegraph sync "<本机路径>"
codegraph query "<中文关键词>" -p "<本机路径>"
codegraph explore "<问题>" -p "<本机路径>"
codegraph callers <符号> -p "<本机路径>"
codegraph impact <符号> -p "<本机路径>"

# 图谱语义查询（graphify，若 graphify-out 存在）
graphify query "<问题>" --graph "<本机路径>/graphify-out/graph.json"
graphify god-nodes --graph "<本机路径>/graphify-out/graph.json"
```

**查询路径（中文定位）**——有工具先工具，无工具 AI 直接处理：
1. 有 codegraph：`codegraph query "<中文词>" -p "<path>"` —— 命中即定位（docstring/注释中的中文可命中）
2. 无 codegraph 或未命中 → grep 源码中文注释/README：`grep -rn "<中文词>" <path> --include="*.py" --include="*.js" --include="*.ts" ...`；命中后读文件确认
3. 仍无 → 依据上下文猜英文符号名，有 codegraph 再 query，无则直接 grep
4. 最后 → 查「中文概念 → 位置」表（注意表末的验证方式标注）

任何定位结论必须经现查验证——项目页只是加速器。

> 注：元数据提取用 `sqlite3` CLI；环境无 sqlite3 时可用 `python3 -c`（标准库 sqlite3 模块）执行相同查询。

## 跨设备 / 路径缺失处理

查询流程：知识库命中项目页 → 读 paths.yaml 取本机路径 → 路径**存在**则
`codegraph sync` 后现查；路径**不存在**则：

- 有 `git_remote` → 输出克隆指引：`git clone <remote> <推荐落点>`，克隆后
  `/local-kb paths` 更新映射，再继续查询。
- `git_remote: none` → 明说"该项目不在本机，且无 git 远程，需手动拷贝源码"。

**知识库（含 paths.yaml）随同步走；代码永远不走知识库。**
