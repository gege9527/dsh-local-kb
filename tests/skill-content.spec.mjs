import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 技能内容守卫：防止第三方工具名与结构回潮 ----
// 技能是纯 markdown + 一个 python 校验器，没有运行时；这些断言就是它的测试。

const here = path.dirname(fileURLToPath(import.meta.url))
const skillDir = path.join(here, '..', 'skill')

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

// 1. 黑名单：技能不点名任何第三方工具
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
check('templates 查询段是纯 grep', tpl.includes('grep -rn') && !/sync <本机路径>/.test(tpl))

// 4. 常驻块版本号
const snippet = read(path.join(skillDir, 'references', 'agents-snippet.md'))
const ver = snippet.match(/<!--\s*KB_LOCAL_VERSION:\s*(\d+)\s*-->/)
check('常驻块带版本号', ver !== null)
check('版本号 ≥ 6', ver !== null && Number(ver[1]) >= 6, ver === null ? '' : ver[1])
check('常驻块有起止标记', snippet.includes('<!-- KB_LOCAL_START -->') && snippet.includes('<!-- KB_LOCAL_END -->'))

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
