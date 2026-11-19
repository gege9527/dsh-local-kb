import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-archive-note：笔记移入 archive / 删索引行 / 不留在索引里 ----

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb-archive-note.py')
const py = process.env.PYTHON ?? 'python3'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-archnote-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const exists = (rel) => fs.existsSync(path.join(kb, rel))
const read = (rel) => fs.readFileSync(path.join(kb, rel), 'utf8')

const note = (slug, body) => ['---', 'name: ' + slug, 'description: d', 'type: project',
  'created: 2026-01-01', 'updated: 2026-01-01', '---', '', body, ''].join('\n')

write('paths.yaml', 'proj-x:\n  path: /tmp/x\n  git_remote: none\n')
write('memory/MEMORY.md', ['# Global', '', '## feedback', '- [旧笔记](old.md) — 会被归档', '- [保留](keep.md) — 不动', ''].join('\n'))
write('memory/old.md', note('old', '归档我'))
write('memory/keep.md', note('keep', '别动我'))
write('projects/proj-x/proj-x.md', '---\ntitle: proj-x\nproject_id: proj-x\n---\n')
write('projects/proj-x/memory/MEMORY.md', '# Index\n\n## project\n- [项目笔记](pnote.md) — 待归档\n')
write('projects/proj-x/memory/pnote.md', note('pnote', '项目笔记'))

const run = (args) => spawnSync(py, [tool, kb, ...args], { encoding: 'utf8' })

// 1. dry-run
const dry = run(['--path', 'memory/old.md', '--dry-run'])
check('dry-run 成功', dry.status === 0, dry.stdout + dry.stderr)
check('dry-run 不移动', exists('memory/old.md') && !exists('archive/memory/old.md'), dry.stdout)

// 2. 全局记忆归档
const a1 = run(['--path', 'memory/old.md', '--apply', '--no-check'])
check('全局笔记归档', a1.status === 0 && !exists('memory/old.md') && exists('archive/memory/old.md'), a1.stdout + a1.stderr)
const gidx = read('memory/MEMORY.md')
check('删掉全局索引行', !gidx.includes('old.md') && gidx.includes('keep.md'), gidx)

// 3. 项目记忆归档
const a2 = run(['--path', 'projects/proj-x/memory/pnote.md', '--apply', '--no-check'])
check('项目笔记归档', a2.status === 0 && exists('archive/projects/proj-x/memory/pnote.md'), a2.stdout + a2.stderr)
check('删掉项目索引行', !read('projects/proj-x/memory/MEMORY.md').includes('pnote.md'), read('projects/proj-x/memory/MEMORY.md'))

// 4. 非法路径拒绝
const bad = run(['--path', 'projects/proj-x/proj-x.md'])
check('非记忆笔记拒绝', bad.status === 2, bad.status + ' ' + bad.stderr)

// 5. 重复归档拒绝（目标已存在）
write('memory/old.md', note('old', '又来了'))
const dup = run(['--path', 'memory/old.md', '--apply'])
check('目标已存在拒绝', dup.status === 2 && dup.stderr.includes('已存在'), dup.status + ' ' + dup.stderr)

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
