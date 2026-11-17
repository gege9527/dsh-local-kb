import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AGENTS_MARKER_END, AGENTS_MARKER_START, appendRulesToAgents, installSkill } from '../install-skill.js'

// ---- 有就覆盖：块与技能副本都以 payload 为准；覆盖前备份一份，只留一份 ----

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}
const mk = (root, rel, text) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-payload-'))
mk(payload, 'references/agents-snippet.md', [
  AGENTS_MARKER_START,
  '<!-- KB_LOCAL_VERSION: 3 -->',
  '新块 v3',
  AGENTS_MARKER_END,
  '',
].join('\n'))
mk(payload, 'SKILL.md', '# skill v2')
// 隐藏文件也会同步（用中性名字；.skill-version 是安装器产物，见下一条断言）
mk(payload, '.payload-marker', 'marker')

// 1. 旧版本块 → 覆盖
const home1 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agents-'))
mk(home1, 'AGENTS.md', [
  '# 我的规则',
  '',
  AGENTS_MARKER_START,
  '<!-- KB_LOCAL_VERSION: 1 -->',
  '旧块 v1',
  AGENTS_MARKER_END,
  '',
  '## 结尾',
].join('\n'))
let out = await appendRulesToAgents(home1, payload)
let text = fs.readFileSync(path.join(home1, 'AGENTS.md'), 'utf8')
check('旧块被覆盖', out.status === 'updated', out.status)
check('内容换成 payload', text.includes('新块 v3') && !text.includes('旧块 v1'))
check('块前保留', text.includes('# 我的规则'))
check('块后保留', text.includes('## 结尾'))

// 2. 内容相同 → 不动
out = await appendRulesToAgents(home1, payload)
check('内容相同跳过', out.status === 'present', out.status)

// 3. 用户改过的高版本也被覆盖（保持最新）
mk(home1, 'AGENTS.md', [AGENTS_MARKER_START, '<!-- KB_LOCAL_VERSION: 9 -->', '用户手改 v9', AGENTS_MARKER_END].join('\n'))
out = await appendRulesToAgents(home1, payload)
text = fs.readFileSync(path.join(home1, 'AGENTS.md'), 'utf8')
check('高版本也覆盖', out.status === 'updated' && text.includes('新块 v3') && !text.includes('用户手改 v9'), out.status)

// 4. 没有块 → 追加
const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agents2-'))
mk(home2, 'AGENTS.md', '# 只有我的规则\n')
out = await appendRulesToAgents(home2, payload)
text = fs.readFileSync(path.join(home2, 'AGENTS.md'), 'utf8')
check('缺块时追加', out.status === 'appended', out.status)
check('追加保留原文', text.startsWith('# 只有我的规则') && text.includes('新块 v3'))

// 5. 半截块 → 报错不猜
const home3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agents3-'))
mk(home3, 'AGENTS.md', AGENTS_MARKER_START + '\n半截\n')
out = await appendRulesToAgents(home3, payload)
check('半截块报错', out.status === 'error', out.status)

check('不再导出 blockVersion（版本比较已删）', !('blockVersion' in (await import('../install-skill.js'))))

// 6. 覆盖前备份：只留一份
const backupDir = path.join(home1, 'local-kb', 'backups')
check('覆盖后留有备份', fs.existsSync(backupDir))
check('备份里有 AGENTS.md', fs.existsSync(path.join(backupDir, 'AGENTS.md')))
const backupEntries = fs.readdirSync(backupDir)
check('备份目录不散落多份', backupEntries.length <= 2, JSON.stringify(backupEntries))

// 7. 技能副本：有就覆盖
const home4 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-skill-'))
mk(home4, 'skills/local-kb/SKILL.md', '# skill v1')
mk(home4, 'skills/local-kb/extra.md', 'user file')
const first = await installSkill({ dshHome: home4, payloadDir: payload })
check('旧技能副本被覆盖', fs.readFileSync(path.join(home4, 'skills/local-kb/SKILL.md'), 'utf8') === '# skill v2')
check('报告 changed 数量', first.changed === 3, String(first.changed))
check('用户自己的文件不动', fs.existsSync(path.join(home4, 'skills/local-kb/extra.md')))
{
  const digest = createHash('sha256').update('# skill v2').digest('hex')
  const installed = fs.readFileSync(path.join(home4, 'skills/local-kb/.skill-version'), 'utf8').trim()
  check('.skill-version 由安装器写（SKILL.md 哈希），不是 payload 内容', installed === digest, installed)
}
check('技能也备份了', fs.existsSync(path.join(home4, 'local-kb/backups/skills/SKILL.md')))

const second = await installSkill({ dshHome: home4, payloadDir: payload })
check('第二次不再改动', second.status === 'present' && second.changed === 0, JSON.stringify(second))

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
for (const dir of [payload, home1, home2, home3, home4]) fs.rmSync(dir, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
