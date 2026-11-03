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

// 插件状态 + 凭据也要清掉
fs.mkdirSync(path.join(home, 'local-kb'), { recursive: true })
fs.writeFileSync(path.join(home, 'local-kb', 'settings.json'), '{}')
fs.writeFileSync(path.join(home, '.credentials.yaml'), [
  'version: 1',
  'refs:',
  '    DEEPSEEK_API_KEY: sk-keep',
  '    dsh_local_kb_webdav_url: http://dav.example/dav',
  '    dsh_local_kb_webdav_user: lyu',
  '    dsh_local_kb_webdav_password: secret',
].join('\n'), { mode: 0o600 })

const out = await uninstallSkill({ env: { DSH_HOME: home } })
const agents = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
const creds = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')

check('技能副本被移除', !fs.existsSync(path.join(home, 'skills', 'local-kb')))
check('别的技能不动', fs.existsSync(path.join(home, 'skills', 'other', 'SKILL.md')))
check('KB_LOCAL 块被移除', !agents.includes('KB_LOCAL_START') && !agents.includes('old block'))
check('块前内容保留', agents.includes('# 用户自己的规则'))
check('块后内容保留', agents.includes('## 后文') && agents.includes('keep me'))
check('WebDAV 凭据被移除', !creds.includes('dsh_local_kb_webdav_'), creds)
check('别的凭据保留', creds.includes('DEEPSEEK_API_KEY'), creds)
check('凭据有备份', fs.existsSync(path.join(home, '.credentials.yaml.local-kb-bak')))
check('插件状态目录被移除', !fs.existsSync(path.join(home, 'local-kb')))
check('知识库不动（不在这个 home 里）', out.notes.some((n) => n.includes('知识库目录')), JSON.stringify(out.notes))

// 没有块时：不编造删除
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-uninstall2-'))
fs.writeFileSync(path.join(home2, 'AGENTS.md'), '# only mine\n')
const out2 = await uninstallSkill({ env: { DSH_HOME: home2 } })
check('无块时提示', out2.notes.some((n) => n.includes('没有 KB_LOCAL')), JSON.stringify(out2.notes))
check('无块时不动 AGENTS.md', fs.readFileSync(path.join(home2, 'AGENTS.md'), 'utf8') === '# only mine\n')

// 技能副本是软链时：只解链接，目标必须保留
const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-uninstall3-'))
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-shared-'))
fs.writeFileSync(path.join(shared, 'SKILL.md'), '# shared skill')
fs.mkdirSync(path.join(home3, 'skills'), { recursive: true })
fs.symlinkSync(shared, path.join(home3, 'skills', 'local-kb'))
const out3 = await uninstallSkill({ env: { DSH_HOME: home3 } })
check('软链被解开', !fs.existsSync(path.join(home3, 'skills', 'local-kb')))
check('软链目标完好', fs.existsSync(path.join(shared, 'SKILL.md')))
check('结果里说明只解链接', out3.removed.some((r) => r.includes('软链')), JSON.stringify(out3.removed))

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(home2, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
