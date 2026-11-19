import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-check：时效词分级 / --fix 补索引 / status 分组自洽 ----
// 技能是纯文件系统协议，这个 python 校验器就是它的闸门；这里锁住三个行为：
//   1. completed 笔记里的「下一步」是历史叙述，不再报时效警告
//   2. 有笔记没索引是一条 error，--fix 只追加缺失行（默认 dry-run）
//   3. 索引一旦用 ## active/## completed 分组，成员必须与 frontmatter status 一致

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb-check.py')
const py = process.env.PYTHON ?? 'python3'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-check-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const note = (fields, body) => ['---', ...fields, '---', '', body, ''].join('\n')
const projectPage = (id) => '---\ntitle: ' + id + '\nproject_id: ' + id + '\n---\n\n## 项目资料\n'

write('memory/MEMORY.md', '# 全局\n## feedback\n')
write('projects/p1/p1.md', projectPage('p1'))
write('projects/p1/memory/MEMORY.md', [
  '# Index',
  '',
  '## project',
  '- [进行中的事](a.md) — 主线',
  '- [已完成的事](done.md) — 完成',
  '',
  '## feedback',
  '- [技术记录](tech.md) — 记录',
  '',
].join('\n'))
write('projects/p1/memory/a.md', note([
  'name: a', 'description: 进行中', 'type: project', 'status: active',
  'created: 2026-01-01', 'updated: 2026-01-02',
], '下一步：验证回归。'))
write('projects/p1/memory/done.md', note([
  'name: done', 'description: 已完成', 'type: project', 'status: completed',
  'created: 2026-01-01', 'updated: 2026-01-02',
], '已完成。下一步必须做的验证是回归测试，已跑通。'))
write('projects/p1/memory/tech.md', note([
  'name: tech', 'description: 技术记录', 'type: feedback',
  'created: 2026-01-01', 'updated: 2026-01-02',
], '下一步：改用 read 超时。'))
write('projects/p1/memory/new.md', note([
  'name: new', 'description: 新笔记', 'type: project',
  'created: 2026-01-01', 'updated: 2026-01-02',
], '正文。'))

const run = (...args) => spawnSync(py, [tool, kb, ...args], { encoding: 'utf8' })
const memIndex = (id = 'p1') => fs.readFileSync(path.join(kb, 'projects', id, 'memory', 'MEMORY.md'), 'utf8')
const errorsOf = (id) => JSON.parse(run('--json').stdout).errors.filter((e) => e.includes('projects/' + id + '/memory'))

// 1. 时效词：active 报、completed 不报、无 status 的 feedback 报
const parsed = JSON.parse(run('--json').stdout)
check('未索引笔记算错误', parsed.errors.some((e) => e.includes('记忆未被索引') && e.includes('new.md')), parsed.errors.join(' | '))
const staleWarns = parsed.warns.filter((w) => w.includes('时效性'))
check('active 笔记仍报时效', staleWarns.some((w) => w.includes('a.md')), staleWarns.join(' | '))
check('无 status 的 feedback 仍报时效', staleWarns.some((w) => w.includes('tech.md')), staleWarns.join(' | '))
check('completed 笔记不报时效', !staleWarns.some((w) => w.includes('done.md')), staleWarns.join(' | '))

// 2. --fix 默认只预览，不落盘
const before = memIndex()
const dry = run('--fix')
check('dry-run 不改文件', memIndex() === before, '文件被修改了')
check('dry-run 列出待补条目', dry.stdout.includes('new.md') && dry.stdout.includes('预览'), dry.stdout)

// 3. --fix --write 只追加缺失行，落进 ## project 段
const applied = run('--fix', '--write')
check('--write 报告已追加', applied.stdout.includes('已追加'), applied.stdout)
const after = memIndex()
check('已有行一字不动', after.includes('- [进行中的事](a.md) — 主线') && after.includes('- [技术记录](tech.md) — 记录'))
const lines = after.split('\n')
const idxDone = lines.findIndex((l) => l.includes('done.md'))
const idxNew = lines.findIndex((l) => l.includes('new.md'))
const idxFeedback = lines.findIndex((l) => l.startsWith('## feedback'))
check('新指针插在 ## project 段尾', idxNew === idxDone + 1 && idxNew < idxFeedback, lines.join('\\n'))
check('写完不再报漏索引', !errorsOf('p1').some((e) => e.includes('未被索引')), errorsOf('p1').join(' | '))
check('没制造分组错误', !errorsOf('p1').some((e) => e.includes('索引 ##')), errorsOf('p1').join(' | '))

// 4. 找不到匹配段时新建 type 段，绝不塞进 ## completed 段
write('projects/p2/p2.md', projectPage('p2'))
write('projects/p2/memory/MEMORY.md', '# Index\n\n## completed\n- [老任务](old.md) — 完成\n')
write('projects/p2/memory/old.md', note(['name: old', 'description: 老', 'type: project', 'status: completed', 'created: 2026-01-01', 'updated: 2026-01-02'], '正文'))
write('projects/p2/memory/busy.md', note(['name: busy', 'description: 忙', 'type: project', 'status: active', 'created: 2026-01-01', 'updated: 2026-01-02'], '正文'))
run('--fix', '--write')
const p2 = memIndex('p2')
check('新建 ## project 小节省住 active 笔记', /## project\n- \[busy\]\(busy\.md\)/.test(p2), p2)
check('active 笔记没被塞进 ## completed 段', !/## completed\n- \[busy\]/.test(p2), p2)
check('p2 无分组错误', !errorsOf('p2').some((e) => e.includes('索引 ##')), errorsOf('p2').join(' | '))

// 5. 分组不一致要报错（opt-in：只有存在该小节才校验）
write('projects/p3/p3.md', projectPage('p3'))
write('projects/p3/memory/MEMORY.md', '# Index\n\n## active\n- [其实是完成品](done.md) — 完成\n\n## completed\n- [真完成](real.md) — 完成\n')
write('projects/p3/memory/done.md', note(['name: done', 'description: 完成', 'type: project', 'status: completed', 'created: 2026-01-01', 'updated: 2026-01-02'], '正文'))
write('projects/p3/memory/real.md', note(['name: real', 'description: 完成', 'type: project', 'status: completed', 'created: 2026-01-01', 'updated: 2026-01-02'], '正文'))
const p3 = errorsOf('p3')
check('## active 段里的 completed 报错', p3.some((e) => e.includes('## active 段下的 done.md')), p3.join(' | '))
check('同一文件只报一次', p3.filter((e) => e.includes('done.md')).length === 1, p3.join(' | '))
check('## completed 段里的 completed 不报', !p3.some((e) => e.includes('real.md')), p3.join(' | '))

// 6. type 分组的索引不触发 status 分组校验（opt-in）
check('type 分组索引不做 status 校验', !errorsOf('p1').some((e) => e.includes('索引 ##')), errorsOf('p1').join(' | '))

// 7. 命名规则：id 必须等于「最短唯一路径后缀」，且不得重复
const kb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-check-move-'))
const w2 = (rel, text) => {
  const abs = path.join(kb2, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const dirA = path.join(kb2, '..', 'kb-check-name-alpha')
const dirB = path.join(kb2, '..', 'kb-check-name-beta')
fs.mkdirSync(dirA, { recursive: true })
fs.mkdirSync(dirB, { recursive: true })
w2('paths.yaml', [
  'good:',
  '  path: ' + path.join(kb2, '..', 'good'),
  '  git_remote: none',
  'wrong-name:',
  '  path: ' + dirA,
  '  git_remote: none',
  'dup:',
  '  path: ' + dirB,
  '  git_remote: none',
  'dup:',
  '  path: ' + path.join(kb2, '..', 'dup2'),
  '  git_remote: none',
].join('\n'))
const parsed2 = JSON.parse(spawnSync(py, [tool, kb2, '--json'], { encoding: 'utf8' }).stdout)
check('id 与路径不符报错', parsed2.errors.some((e) => e.includes('项目 id 与路径不符') && e.includes('wrong-name')), parsed2.errors.join(' | '))
check('id 重复报错', parsed2.errors.some((e) => e.includes('项目 id 重复') && e.includes('dup')), parsed2.errors.join(' | '))
check('符合规则的条目不再报', !parsed2.errors.some((e) => e.includes('good→')), parsed2.errors.join(' | '))


// 默认根：KB_ROOT 环境变量优先于 ~/.local-kb（与插件侧一致）
const envRoot = path.join(os.tmpdir(), 'kb-env-root-' + process.pid)
const envOut = spawnSync(py, [tool, '--json'], { encoding: 'utf8', env: { ...process.env, KB_ROOT: envRoot } })
check('默认根读 KB_ROOT', envOut.stdout.includes(envRoot) || envOut.stderr.includes(envRoot), envOut.stdout + envOut.stderr)

// 项目 id 推导要认 Windows 反斜杠与盘符
const segCode = [
  'import importlib.util, sys',
  'spec = importlib.util.spec_from_file_location("c", sys.argv[1])',
  'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
  'print("|".join(m.path_segments("C:\\\\work\\\\api")))',
].join('\n')
const segOut = spawnSync(py, ['-c', segCode, path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb_common.py')], { encoding: 'utf8' })
check('Windows 路径分段', segOut.stdout.trim() === 'c|work|api', segOut.stdout + segOut.stderr)
const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb2, { recursive: true, force: true })
fs.rmSync(dirA, { recursive: true, force: true })
fs.rmSync(dirB, { recursive: true, force: true })
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
