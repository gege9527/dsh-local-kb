import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { migrateLegacyInstall, stripAgentsBlock, LEGACY_BACKUP_DIR } from '../migrate.js'
import { rulesPath, rulesText, stripRuleMarkers } from '../inject.js'

// ---- 旧安装方式迁移：只删插件自己装的东西，删前备份，块外内容不动 ----

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

// 1. 空 home：什么都不该发生
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-empty-'))
  const out = migrateLegacyInstall({ dshHome: home })
  check('无旧产物：技能副本 absent', out.skillCopy === 'absent', out.skillCopy)
  check('无旧产物：AGENTS 块 absent', out.agentsBlock === 'absent', out.agentsBlock)
  check('无旧产物：不写任何文件', fs.readdirSync(home).filter((n) => n !== '.local-kb-legacy-backup').length === 0)
}

// 2. 带 .skill-version 标记的旧副本：删除 + 备份
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-marked-'))
  mk(home, 'skills/local-kb/SKILL.md', '# skill')
  mk(home, 'skills/local-kb/.skill-version', 'abc123')
  mk(home, 'skills/local-kb/references/memory.md', 'body')
  mk(home, 'skills/other/SKILL.md', '# keep me')
  const out = migrateLegacyInstall({ dshHome: home, now: 'test-stamp' })
  check('标记副本被删除', !fs.existsSync(path.join(home, 'skills/local-kb')))
  check('迁移结果 removed', out.skillCopy === 'removed', out.skillCopy)
  check('备份存在', out.backup !== null && fs.existsSync(path.join(out.backup, 'SKILL.md')), String(out.backup))
  check('备份落在 ' + LEGACY_BACKUP_DIR, String(out.backup).includes(LEGACY_BACKUP_DIR))
  check('别人的技能目录不动', fs.existsSync(path.join(home, 'skills/other/SKILL.md')))
}

// 3. 没有标记的副本：保留并报告冲突
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-unmarked-'))
  mk(home, 'skills/local-kb/SKILL.md', '# user copy')
  const out = migrateLegacyInstall({ dshHome: home })
  check('无标记副本保留', fs.existsSync(path.join(home, 'skills/local-kb/SKILL.md')))
  check('冲突被报告', out.skillCopy === 'conflict' && out.conflict === 'unmarked-skill-copy', JSON.stringify(out))
}

// 4. 软链：只解链接，目标保留
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-symlink-'))
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-shared-'))
  fs.writeFileSync(path.join(shared, 'SKILL.md'), '# shared')
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
  fs.symlinkSync(shared, path.join(home, 'skills', 'local-kb'))
  const out = migrateLegacyInstall({ dshHome: home })
  check('软链被解开', !fs.existsSync(path.join(home, 'skills/local-kb')) && out.skillCopy === 'removed', out.skillCopy)
  check('软链目标保留', fs.existsSync(path.join(shared, 'SKILL.md')))
}

// 5. AGENTS.md：只摘块，块外一字不动；只剩块时删文件
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-agents-'))
  mk(home, 'AGENTS.md', [
    '# 我的规则',
    '',
    '<!-- KB_LOCAL_START -->',
    '<!-- KB_LOCAL_VERSION: 6 -->',
    '旧块',
    '<!-- KB_LOCAL_END -->',
    '',
    '## 后文',
    'keep me',
    '',
  ].join('\n'))
  const out = migrateLegacyInstall({ dshHome: home })
  const text = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
  check('AGENTS 块被摘除', out.agentsBlock === 'removed' && !text.includes('KB_LOCAL_START'), text)
  check('块外内容保留', text.includes('# 我的规则') && text.includes('keep me'), text)
  check('不残留空行堆', !text.includes('\n\n\n'), JSON.stringify(text))

  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-agents-only-'))
  mk(home2, 'AGENTS.md', '<!-- KB_LOCAL_START -->\nx\n<!-- KB_LOCAL_END -->\n')
  migrateLegacyInstall({ dshHome: home2 })
  check('只剩块时删掉 AGENTS.md', !fs.existsSync(path.join(home2, 'AGENTS.md')))
}

// 6. 幂等
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-idem-'))
  mk(home, 'skills/local-kb/SKILL.md', '# skill')
  mk(home, 'skills/local-kb/.skill-version', 'v1')
  mk(home, 'AGENTS.md', '<!-- KB_LOCAL_START -->\nx\n<!-- KB_LOCAL_END -->\n')
  const first = migrateLegacyInstall({ dshHome: home })
  const second = migrateLegacyInstall({ dshHome: home })
  check('第一次真的迁移', first.skillCopy === 'removed' && first.agentsBlock === 'removed')
  check('第二次无事可做', second.skillCopy === 'absent' && second.agentsBlock === 'absent', JSON.stringify(second))
}

// 7. stripAgentsBlock 的边界
{
  const half = '# a\n<!-- KB_LOCAL_START -->\nbody'
  check('半个标记不动', stripAgentsBlock(half).removed === false)
  check('无标记不动', stripAgentsBlock('# a\n').removed === false)
  check('空输入不炸', stripAgentsBlock('').removed === false)
}

// 10. 备份失败 => 一个字节都不删
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mig-nobackup-'))
  mk(home, 'skills/local-kb/SKILL.md', '# skill')
  mk(home, 'skills/local-kb/.skill-version', 'v1')
  const blocker = path.join(home, 'not-a-dir')
  fs.writeFileSync(blocker, 'x') // 备份根指向一个文件 → mkdir 必然失败
  const out = migrateLegacyInstall({ dshHome: home, backupRoot: blocker, now: 'stamp' })
  check('备份失败时副本保留', fs.existsSync(path.join(home, 'skills/local-kb/SKILL.md')))
  check('备份失败被标记', out.skillCopy === 'kept' && out.conflict === 'backup-failed', JSON.stringify(out))
}

// 8. 常驻规则：读插件自带那份，且不带 HTML 标记行
{
  const file = rulesPath()
  check('规则文件存在', fs.existsSync(file), file)
  const body = rulesText(new Map())
  check('规则非空', body.length > 100, String(body.length))
  check('不含 KB_LOCAL 标记', !body.includes('KB_LOCAL_START') && !body.includes('KB_LOCAL_END'), body.slice(0, 80))
  check('不含版本注释', !/KB_LOCAL_VERSION/.test(body))
  check('保留正文要点', body.includes('记忆') && body.includes('知识库'), body.slice(0, 120))
  check('stripRuleMarkers 去标记', stripRuleMarkers('<!-- KB_LOCAL_START -->\nA\n<!-- KB_LOCAL_END -->') === 'A')
}

// 9. cordis.patch.yml：技能行必须在，否则包内技能永远不会被加载
{
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'cordis.patch.yml')
  const text = fs.readFileSync(file, 'utf8')
  check('patch 里有技能 provider 行', text.includes("id: local-kb-skill"), text.slice(0, 60))
  check('providerName 独立', text.includes('providerName: local-kb-bundled'))
  check('includeDefaultRoots 关掉', text.includes('includeDefaultRoots: false'))
  check('bundledSkillDir 用 !!js', /bundledSkillDir: !!js/.test(text))
  check('bundledSkillDir 指向包内 skills/', text.includes("node_modules/dsh-local-kb/skills/"))
  check('插件本体行仍在', text.includes('name: dsh-local-kb'))
}

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
process.exit(failed === 0 ? 0 : 1)
