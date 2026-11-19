import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-archive-project：移入 archive / 删登记 / 改引用 / 清卡片，不留标记 ----

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb-archive-project.py')
const py = process.env.PYTHON ?? 'python3'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-arch-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const exists = (rel) => fs.existsSync(path.join(kb, rel))
const read = (rel) => fs.readFileSync(path.join(kb, rel), 'utf8')

const page = (id) => '---\ntitle: ' + id + '\nproject_id: ' + id + '\n---\n\n## 项目资料\n'
const note = (slug, body) => ['---', 'name: ' + slug, 'description: d', 'type: project',
  'created: 2026-01-01', 'updated: 2026-01-01', '---', '', body, ''].join('\n')

write('paths.yaml', [
  'proj-a:',
  '  path: /tmp/does-not-matter/proj-a',
  '  git_remote: none',
  'proj-keep:',
  '  path: /tmp/does-not-matter/proj-keep',
  '  git_remote: none',
  '',
].join('\n'))
write('memory/MEMORY.md', '# Global Memory Index\n')
write('projects/proj-a/proj-a.md', page('proj-a'))
write('projects/proj-a/memory/MEMORY.md', '# Index\n\n## project\n- [一条笔记](note.md) — x\n')
write('projects/proj-a/memory/note.md', note('note', '内容'))
write('projects/proj-keep/proj-keep.md', page('proj-keep'))
write('projects/proj-keep/docs/ref.md', '---\ntitle: ref\n---\n\n见 projects/proj-a/proj-a.md\n')

const run = (args) => spawnSync(py, [tool, kb, ...args], { encoding: 'utf8' })

// 1. dry-run 不落盘
const dry = run(['--id', 'proj-a', '--dry-run'])
check('dry-run 成功', dry.status === 0, dry.stdout + dry.stderr)
check('dry-run 不动目录', exists('projects/proj-a') && !exists('archive/projects/proj-a'), dry.stdout)

// 2. 归档执行
const apply = run(['--id', 'proj-a', '--apply', '--no-check'])
check('归档成功', apply.status === 0, apply.stdout + apply.stderr)
check('目录移入 archive', !exists('projects/proj-a') && exists('archive/projects/proj-a/proj-a.md'), apply.stdout)
check('paths 条目已删', !read('paths.yaml').includes('proj-a:'), read('paths.yaml'))
check('保留其它条目', read('paths.yaml').includes('proj-keep:'), read('paths.yaml'))
check('全库引用改写', read('projects/proj-keep/docs/ref.md').includes('archive/projects/proj-a/proj-a.md'), read('projects/proj-keep/docs/ref.md'))
check('项目页不加标记', !read('archive/projects/proj-a/proj-a.md').includes('已归档'), read('archive/projects/proj-a/proj-a.md'))

// 3. 重复归档拒绝
const again = run(['--id', 'proj-a', '--apply'])
check('重复归档拒绝', again.status === 2, again.status + ' ' + again.stderr)

// 4. 不存在的 id 拒绝
const missing = run(['--id', 'nope'])
check('不存在的 id 拒绝', missing.status === 2 && missing.stderr.includes('不存在'), missing.status + ' ' + missing.stderr)

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
