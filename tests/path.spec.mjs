import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyPath, isInside } from '../index.js'

// ---- 路径分类测试：统一 classifyPath 覆盖软链、未创建文件、KB 各层语义 ----

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-path-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-out-'))
const write = (rel, text = 'x') => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}

// 骨架
write('memory/MEMORY.md')
write('memory/user-a.md')
write('projects/demo/memory/MEMORY.md')
write('projects/demo/memory/note.md')
write('projects/demo/demo.md')
write('projects/demo/docs/api.md')
write('docs/guide.md')
write('.kb-sync-state.json')
fs.writeFileSync(path.join(root, 'README.md'), 'x')

// 软链：KB 内指向外部、外部指向 KB 内
fs.writeFileSync(path.join(outside, 'secret.md'), 's')
fs.symlinkSync(path.join(outside, 'secret.md'), path.join(root, 'memory', 'out-link.md'))
fs.writeFileSync(path.join(outside, 'real.md'), 'y')
fs.symlinkSync(path.join(root, 'memory', 'user-a.md'), path.join(outside, 'in-link.md'))

const results = []
const check = (name, got, want) => {
  const ok = got === want
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  got=${got} want=${want}`))
}
const kind = (rel) => classifyPath(root, path.join(root, rel)).kind

check('KB 根', classifyPath(root, root).kind, 'root')
check('全局记忆索引', kind('memory/MEMORY.md'), 'memory-index')
check('全局记忆笔记', kind('memory/user-a.md'), 'memory-note')
check('项目记忆索引', kind('projects/demo/memory/MEMORY.md'), 'memory-index')
check('项目记忆笔记', kind('projects/demo/memory/note.md'), 'memory-note')
check('项目页', kind('projects/demo/demo.md'), 'project-page')
check('项目文档', kind('projects/demo/docs/api.md'), 'project-doc')
check('跨项目文档', kind('docs/guide.md'), 'doc')
check('同步状态文件', kind('.kb-sync-state.json'), 'state')
check('KB 根其他文件', kind('README.md'), 'other')

check('KB 外', classifyPath(root, path.join(outside, 'real.md')).kind, 'outside')
check('相对路径 .. 出界', classifyPath(root, path.join(root, '..', 'x.md')).kind, 'outside')
check('空路径', classifyPath(root, '').kind, 'unknown')

// 未创建的文件（AI 新写一条记忆）也要判对
check('未创建的记忆笔记', kind('projects/demo/memory/2026-11-02-new.md'), 'memory-note')
check('未创建的索引', kind('projects/new/memory/MEMORY.md'), 'memory-index')
check('未创建的项目页', kind('projects/new/new.md'), 'project-page')

// 软链：解析后仍以真实位置为准
check('KB 内软链指向外部 = outside', kind('memory/out-link.md'), 'outside')
check('外部软链指向 KB 内 = memory-note', classifyPath(root, path.join(outside, 'in-link.md')).kind, 'memory-note')

check('isInside 软链出界为 false', isInside(root, path.join(root, 'memory', 'out-link.md')), false)
check('isInside 普通文件为 true', isInside(root, path.join(root, 'memory', 'user-a.md')), true)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
