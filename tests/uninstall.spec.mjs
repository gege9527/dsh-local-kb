import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { uninstallSkill } from '../install-skill.js'

// ---- 卸载：只撤掉插件装的东西，凭据与用户内容不动 ----

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-uninstall-'))
fs.mkdirSync(path.join(home, 'skills', 'local-kb', 'references'), { recursive: true })
fs.writeFileSync(path.join(home, 'skills', 'local-kb', 'SKILL.md'), '# skill')
fs.mkdirSync(path.join(home, 'skills', 'other'), { recursive: true })
fs.writeFileSync(path.join(home, 'skills', 'other', 'SKILL.md'), '# keep')
fs.writeFileSync(path.join(home, 'AGENTS.md'), [
  '# 用户自己的规则',
  '',
  '<!-- KB_LOCAL_START -->',
  'old block',
  '<!-- KB_LOCAL_END -->',
  '',
  '## 后文',
  'keep me',
  '',
].join('\n'))

const out = await uninstallSkill({ env: { DSH_HOME: home } })
const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')

check('技能副本被移除', !fs.existsSync(path.join(home, 'skills', 'local-kb')))
check('别的技能不动', fs.existsSync(path.join(home, 'skills', 'other', 'SKILL.md')))
check('KB_LOCAL 块被移除', !agents.includes('KB_LOCAL_START') && !agents.includes('old block'))
check('块前内容保留', agents.includes('# 用户自己的规则'))
check('块后内容保留', agents.includes('## 后文') && agents.includes('keep me'))
check('removed 记录两项', out.removed.length === 2, JSON.stringify(out.removed))
check('提示凭据保留', out.notes.some((n) => n.includes('credentials')), JSON.stringify(out.notes))

// 没有块时：不编造删除
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-uninstall2-'))
fs.writeFileSync(path.join(home2, 'AGENTS.md'), '# only mine\n')
const out2 = await uninstallSkill({ env: { DSH_HOME: home2 } })
check('无块时提示', out2.notes.some((n) => n.includes('没有 KB_LOCAL')), JSON.stringify(out2.notes))
check('无块时不动 AGENTS.md', fs.readFileSync(path.join(home2, 'AGENTS.md'), 'utf8') === '# only mine\n')

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(home2, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
