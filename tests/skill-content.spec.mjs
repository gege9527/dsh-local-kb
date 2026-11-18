import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 技能内容守卫：防止第三方工具名与结构回潮 ----
// 技能是纯 markdown + 一个 python 校验器，没有运行时；这些断言就是它的测试。

const here = path.dirname(fileURLToPath(import.meta.url))
const skillDir = path.join(here, '..', 'skills', 'local-kb')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md') || entry.name.endsWith('.py')) out.push(full)
  }
  return out
}

const files = walk(skillDir)
const read = (p) => fs.readFileSync(p, 'utf8')
const rel = (p) => path.relative(skillDir, p)

// 1. 黑名单：技能不点名任何第三方工具。
//    理由不是洁癖——协议里出现工具名 = 能力暗示 = 诱导 AI 去装那个工具，
//    而本技能的两条铁律是「不提供调用关系分析」和「工具是加速器不是前置依赖」。
const banned = []
for (const file of files) {
  const hits = read(file).match(/codegraph|graphify/gi)
  if (hits !== null) banned.push(rel(file) + ' x' + hits.length)
}
check('技能不含第三方工具名', banned.length === 0, banned.join(', '))

// 2. SKILL.md 结构完整
const skill = read(path.join(skillDir, 'SKILL.md'))
for (const section of ['## 操作边界', '## 能力边界', '## 检索方式', '## 动作清单', '## 铁律']) {
  check('SKILL.md 含 ' + section, skill.includes(section))
}

// 3. 项目页模板不再要求引擎字段
const tpl = read(path.join(skillDir, 'references', 'templates.md'))
check('templates 无 engines 字段', !/^engines:/m.test(tpl), '仍含 engines:')
// 查询命令收进常驻规则（每轮注入）：模板不再要求项目页内嵌命令。
const snippetText = read(path.join(skillDir, 'references', 'agents-snippet.md'))
check('常驻规则含两段检索命令', snippetText.includes('kb-search.py') && snippetText.includes('grep -rn'), '规则缺 kb-search 或源码 grep')
check('项目页模板不再内嵌查询命令', !tpl.includes('## 怎么查这个项目'))

// 4. 常驻块只保留起止标记（版本标记已移除：比较逻辑早就换成内容相等）
const snippet = read(path.join(skillDir, 'references', 'agents-snippet.md'))
check('常驻块有起止标记', snippet.includes('<!-- KB_LOCAL_START -->') && snippet.includes('<!-- KB_LOCAL_END -->'))
check('不再带版本标记', !snippet.includes('KB_LOCAL_VERSION'))
// K 条的裸 grep 必须按目录限定并排除 archive：projects/*/*.md 会漏掉 projects/<id>/docs/**
check('K 条检索范围按目录写', snippet.includes('限定 `projects/` 与 `docs/`') && snippet.includes('排除 `archive/`'))
check('K 条不再用会漏层级的 glob', !snippet.includes('projects/*/*.md'))

// 5. 建档步骤编号连续（删步骤后不留空洞）
const cp = read(path.join(skillDir, 'references', 'code-project.md'))
const steps = [...cp.matchAll(/^## 步骤 (\d+)/gm)].map((m) => Number(m[1]))
const expected = steps.map((_, i) => i + 1)
check('code-project 步骤从 1 连续', steps.join(',') === expected.join(','), steps.join(','))

// 6. 全库不用 Obsidian 专有语法（技能自己声明的约束）
//    说明性文字 `[[wikilink]]` 是规则本身，不算违规。
const wiki = files.filter((f) => read(f).replaceAll('[[wikilink]]', '').includes('[['))
check('技能不用 wikilink', wiki.length === 0, wiki.map(rel).join(', '))

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
if (failed > 0) process.exitCode = 1
