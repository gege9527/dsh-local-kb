# 动作流程（通用）

**首要原则：知识库内容只归档，不删除。** 本技能永不执行物理删除（`rm` / `rm -rf` / `unlink`）；
下线内容一律移入归档目录并标记。真正的删除由**用户手动**执行。

所有动作先定位对象：`projects/<id>/`（代码项目）或 `docs/<名>.md`（文档）。

## list

- 读 `<KB_ROOT>/README.md`（若含清单）+ 列 `projects/`、`docs/` 目录
- 统计：项目数、文档数、各项目记忆条数（读对应 `MEMORY.md`）
- 只读；不改任何文件

## show <名>

- 解析顺序：`aliases`（frontmatter）→ 文件名 → 目录名
- 项目 → 读 `projects/<id>/<id>.md`（其「项目资料」节指向的 arch/docs/memory 按需继续读）
- 文档 → `docs/<名>.md` 或 `projects/<id>/docs/<名>.md`
- 只读

## alias <名> <别名…>

- 定位 `projects/<id>/<id>.md`
- 在 frontmatter `aliases` 数组**追加**（去重，不覆盖已有、不动正文）
- 写后读回校验：`aliases` 含新值

## paths

- 查看：读 `<KB_ROOT>/paths.yaml`，输出 `项目ID → 本机路径 + git_remote` 表
- 更新：追加/修改条目，格式见 `code-project.md` 步骤 5
- 校验：写后读回；对每条 path 检测存在性（不存在标注，不删条目）

## refresh <名>

- 代码项目 → `code-project.md`「刷新」
- 文档 → `doc-archive.md`「刷新」
- **降级升级入口**：工具后装 → 经用户确认后 refresh 重跑，把降级产物升级为工具版（去掉"降级生成"标注）
- **不自动批量 refresh**；多处降级时只报告"有 N 个降级项目可升级"

## remove <名>（= 归档，不是删除）

**永不物理删除。** 步骤：

1. **项目**：`projects/<id>/` 整体移入 `projects/archive/<id>/`；
   paths.yaml 条目**保留**（源项目未动，映射仍有效）；项目页 frontmatter 加 `status: archived`
2. **文档**：移入同层 `archive/`（如 `docs/archive/` 或 `projects/<id>/docs/archive/`）；
   正文头部加一行 `> 已归档 YYYY-MM-DD`
3. **记忆**：`memory/<slug>.md` → `memory/archive/<slug>.md`；从 `MEMORY.md` 移除指针行
4. 校验：原位置无该文件；`archive/` 下存在；索引已更新
5. 报告时明确："已归档（未删除），如需物理删除请手动执行 `rm`"
