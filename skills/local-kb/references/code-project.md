# 代码模式

把本地代码项目索引进知识库。**只存索引，不存源码**。路径不写进笔记，只存 paths.yaml。

建档只读文件系统：`git ls-files`、`package.json`、README、目录树。不依赖任何代码分析工具。

## 步骤 1 — 路径与 ID

- 确定本机绝对路径 `<path>`（必须存在）。
- **首选一条命令建档**（推荐，别手写 id）：

  ```bash
  python3 <技能目录>/tools/kb-add-project.py <KB_ROOT> --path <path> \
    --title <项目名> --description "<一句话>" --alias <中文别名>
  ```

  工具会按全库唯一后缀推导 id、查重（同路径 / 同 git_remote 拒绝）、写 `paths.yaml`、
  建 `projects/<id>/` 与记忆索引、生成项目页骨架并跑 kb-check；`--dry-run` 只打印计划。
  手写 id 时仍按同一规则（下面），推导结果必须一致：
- 确定 `project_id`：**取能保证唯一的最短路径后缀**——各段 kebab 化（小写、空格与符号转 `-`、中文原样保留；
  目录名同理，中文目录不强制转拼音），
  多段用 `-` 连接。目录名唯一时就是目录名本身；同名目录时逐级加上父目录名，直到唯一。
  例：`/work/api` 与 `/apps/api` → `work-api`、`apps-api`；`/OA-AI/excel-form-designer` → `excel-form-designer`。
- 查 `<KB_ROOT>/paths.yaml`：ID 已存在 → 属 refresh；不存在 → 新增映射。
- 记录 git_remote：`git -C <path> remote get-url origin`，无则 `none`。
- **先查重，再新建**：`paths.yaml` 里已有同路径、或同 `git_remote` 的条目 → 是同一个项目，
  走「刷新」不新建。同一目录下的子项目（worktree / monorepo 子包）各自建档，
  但要在项目页写清父子关系与共享目录。

## 项目移动 / 改名

项目换位置或目录改名后，id 必须按新位置重算，并且一次性同步知识库里的一切：

```bash
python3 <技能目录>/tools/kb-move-project.py <KB_ROOT> --from-path <旧路径> --to-path <新路径> --plan /tmp/kb-move.json
python3 <技能目录>/tools/kb-move-project.py <KB_ROOT> --apply --plan /tmp/kb-move.json
```

`--apply` 默认只改路径引用与结构字段；若正文里还有裸 id（短 id 会误伤普通用词与源码路径），
它会列出行号并拒绝执行。确认要一起改时再加 `--allow-body-rewrite`。

工具会更新 `paths.yaml` 的 path 与 id、改 `projects/<id>/` 目录与项目页文件名、改项目页 frontmatter、
替换全库 `projects/<旧 id>/` 引用、prune 卡片并跑一次 kb-check；执行前自动备份到 `<KB_ROOT>/.backup/`。
**禁止只手改 `paths.yaml`**：那样 id 与目录名会漂移，kb-check 会报「项目 id 与路径不符」。

## 步骤 2 — 提取元数据

只写确证内容，读不到的项留空，**不估算、不编造**。

- 技术栈 / 依赖 → 读 `package.json` / `pom.xml` / `go.mod` / `requirements.txt` / `Cargo.toml`
- 描述 → 读 `README*` 首段
- 目录结构 → 列 1–2 层目录 + `git ls-files` 取样
- 语言分布 → 按扩展名统计：`git ls-files | sed "s/.*\.//" | sort | uniq -c | sort -rn | head`
- 规模 → `git ls-files | wc -l`
- 关键文件 → 入口文件（`main.*` / `index.*` / `app.*`）+ README 点名文件

## 步骤 3 — 确定名称、描述、别名

- **名称**：`package.json` 的 `name` → 否则目录名。
- **描述**（优先级从高到低，非空即用）：README 正文首段 → package.json description → 由代码结构推断。
- **别名**：用户提供的 + 目录名 + 描述关键词（供中文检索）。

### 代码结构推断描述

1. 各版本/子目录名 → 是否多版本并存
2. 关键文件的包名/模块名（Maven `groupId:artifactId`、顶层目录）
3. 依赖与技术栈（框架、UI 库、语言分布）
4. 业务关键词（实体类名、服务名、页面组件名）

输出一句话：`<它是什么> + 主要模块/用途`。禁止只写项目名本身。

## 步骤 4 — 更新 paths.yaml

```yaml
<project_id>:
  path: <本机绝对路径>       # 换设备 / 项目移动只改这里
  git_remote: <url | none>
```

## 步骤 5 — 写笔记

必须读 `templates.md` 全文，按模板写。

1. **项目主页**：`<KB_ROOT>/projects/<project_id>/<project_id>.md`
2. **「中文概念 → 位置」表**是核心。写前逐条验证，**命中才写，未命中不写**（避免假位置）。
   ```bash
   grep -rn "<概念关键词>" "<path>" --include="*.py" --include="*.js" --include="*.ts" --include="*.java" \
     --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=target
   ```
   命中后**打开文件确认行号**。表内注明「验证：读文件」，供后续判断可信度。

   **中文线索采集（写入时必须做）**：
   - 直接搜中文注释/README 找线索：
     ```bash
     grep -rn "[一-龥]" "<path>" --include="*.py" --include="*.js" --include="*.ts" \
       --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist | head -50
     ```
   - 补充线索来源：测试文件名（`*.test.*` 常含业务中文）、`git log --grep="中文词"`、`package.json` 依赖（用了什么框架 → 去对应文档目录找）
   - 每个中文业务词先按上文方式验证命中 → 命中才入表。
   - 表应覆盖：注释高频词、页面/模块中文名、用户会说的功能说法。

### 写前 Checklist

- [ ] `title` 项目名 / `type`: `code-project`
- [ ] `description`：一句话，非空，不重复项目名
- [ ] `aliases`：中文别名数组
- [ ] `project_id`：kebab-case（中文目录原样保留，不算违反规则）；与 paths.yaml 一致
- [ ] `git_remote`：remote 或 `none`
- [ ] 概念→位置表每条已验证命中，且注明了「验证：读文件」
- [ ] 关键文件表只列入口文件与 README 点名的文件，不列全量符号
- [ ] 「这是什么」满足 `templates.md` 的下限：3–5 句，说清"解决什么问题"+ 边界（用什么 / 不用什么）
- [ ] 「目录结构」每个一级目录带一句话职责，不是用 `·` 连名字
- [ ] 「关键文件」有 ≥3 行；不够就删掉整节

**内容边界**：不写全量符号表、不写快变字段（符号/文件数、commit、引擎版本）、不复制源码。

## 步骤 6 — 校验

1. `paths.yaml` 含该 `project_id`，指向路径存在。
2. 读回笔记，概念→位置表里每个相对路径在 `<path>` 下真实存在。
3. 笔记内普通链接指向的文件存在。
4. 跑 `python3 <技能目录>/tools/kb-check.py`，退出码非 0 → 修完再报成功。

## 刷新（refresh <名>）

1. 重新读源码（走步骤 2）
2. 重跑步骤 2 提取，覆写项目页（保留用户手写的「中文概念 → 位置」表；
   **重算「项目资料」节**——重新扫描 `<KB_ROOT>/projects/<id>/docs/`、`memory/` 的实际文件，新增/移除同步更新）
3. 校验

## 完成报告

汇报 **added / updated / skipped**（含理由）+ 项目页路径与概念表条数：

```
added   projects/acme/acme.md（概念表 5 条，路径已验证）
updated projects/web/web.md（重算「项目资料」：新增 2 篇产出文档）
skipped projects/oa-ai（同 git_remote 已登记，属刷新范围）
```

「什么都没写」也是合法结果——说明跳过原因即可。

## 查询命令写在哪（不要写进项目页）

默认查询命令在常驻规则 `references/agents-snippet.md`，每轮注入；`kb-search.py` 路径由知识地图给出。
**项目页只写例外**，放 frontmatter，inject 每轮带出：

```yaml
search_roots: [geely]                    # 只在这个子目录里搜（默认项目根）
search_exclude: [bak, apk, decoded]      # 追加到默认排除集
search_projects: [ezplatform-base-web]   # 要一起搜的其他项目 id
```

默认排除集：`.git node_modules dist build target out coverage`。没有例外就不写这三个字段。

**查询路径（中文定位）**：
1. 查项目页「中文概念 → 位置」表
2. grep 源码中文注释 / README / 测试文件名；命中后读文件确认
3. 仍无 → 依据上下文猜英文符号名（camelCase / snake_case）再 grep
4. 再仍无 → 用目录命名约定缩小范围：`views/` `components/` `pages/` `api/` `services/` `hooks/`

任何定位结论必须经现查验证——项目页只是加速器。

## 跨设备 / 路径缺失处理

查询流程：知识库命中项目页 → 读 paths.yaml 取本机路径 → 路径**存在**则直接 grep 现查；路径**不存在**则：

- 有 `git_remote` → **不主动克隆**。先列出缺失项目并给出建议命令
  `git clone <remote> <推荐落点>`，**询问用户是否执行**；同意才克隆，
  然后 `/local-kb paths` 更新映射，再继续查询。拒绝则标记缺失，本次不查源码。
- `git_remote: none` → 明说"该项目不在本机，且无 git 远程，需手动拷贝源码"，不克隆。

**知识库（含 paths.yaml）随同步走；代码永远不走知识库。**
