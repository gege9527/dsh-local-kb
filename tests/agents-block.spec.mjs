import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS_MARKER_END, AGENTS_MARKER_START, appendRulesToAgents, blockVersion } from '../install-skill.js'

// ---- AGENTS.md 常驻块：只在版本更高时刷新标记之间的内容，块外不动 ----

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agents-'))
const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-payload-'))
fs.mkdirSync(path.join(payload, 'references'), { recursive: true })
fs.writeFileSync(path.join(payload, 'references', 'agents-snippet.md'), [
  AGENTS_MARKER_START,
  '<!-- KB_LOCAL_VERSION: 2 -->',
  '新块 v2',
  AGENTS_MARKER_END,
  '',
].join('\n'))

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

// 1. 已有 v1 块 → 升级
fs.writeFileSync(path.join(home, 'AGENTS.md'), [
  '# 我的规则',
  '',
  AGENTS_MARKER_START,
  '<!-- KB_LOCAL_VERSION: 1 -->',
  '旧块 v1',
  AGENTS_MARKER_END,
  '',
  '## 结尾',
].join('\n'))
let out = await appendRulesToAgents(home, payload)
let text = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
check('低版本被刷新', out.status === 'updated', out.status)
check('新块生效', text.includes('新块 v2') && !text.includes('旧块 v1'))
check('块前保留', text.includes('# 我的规则'))
check('块后保留', text.includes('## 结尾'))

// 2. 同版本 → 不动
out = await appendRulesToAgents(home, payload)
text = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
check('同版本不再改', out.status === 'present', out.status)
check('内容未变', text.includes('新块 v2'))

// 3. 用户手改成更高版本 → 不动
fs.writeFileSync(path.join(home, 'AGENTS.md'), [
  AGENTS_MARKER_START,
  '<!-- KB_LOCAL_VERSION: 9 -->',
  '用户手改 v9',
  AGENTS_MARKER_END,
].join('\n'))
out = await appendRulesToAgents(home, payload)
text = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
check('高版本不覆盖', out.status === 'present' && text.includes('用户手改 v9'), out.status)

// 4. 没有块 → 追加
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agents2-'))
fs.writeFileSync(path.join(home2, 'AGENTS.md'), '# 只有我的规则\n')
out = await appendRulesToAgents(home2, payload)
text = fs.readFileSync(path.join(home2, 'AGENTS.md'), 'utf8')
check('缺块时追加', out.status === 'appended', out.status)
check('追加保留原文', text.startsWith('# 只有我的规则') && text.includes('新块 v2'))

// 5. 只有开头标记 → 报错不猜
const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agents3-'))
fs.writeFileSync(path.join(home3, 'AGENTS.md'), AGENTS_MARKER_START + '\n半截\n')
out = await appendRulesToAgents(home3, payload)
check('半截块报错', out.status === 'error', out.status)

check('版本解析默认 1', blockVersion('没有版本标记') === 1)
check('版本解析 v2', blockVersion('<!-- KB_LOCAL_VERSION: 2 -->') === 2)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
for (const dir of [home, home2, home3, payload]) fs.rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
