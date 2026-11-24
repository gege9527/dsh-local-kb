import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离 $DSH_HOME：apply() 会跑旧安装迁移，绝不能落到用户真实 ~/.dsh
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cap-home-'))

import { apply, judgeIndexWrite } from '../index.js'

// ---- 记忆索引硬上限：只拦「越界且变大」，压缩写入放行 ----

// 库根固定为 <parent>/.local-kb：位置由插件设置里的父目录决定。
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cap-'))
const root = path.join(parent, '.local-kb')
fs.mkdirSync(path.join(process.env.DSH_HOME, 'local-kb'), { recursive: true })
fs.writeFileSync(path.join(process.env.DSH_HOME, 'local-kb', 'settings.json'), JSON.stringify({ parent }))
const idx = path.join(root, 'memory', 'MEMORY.md')
fs.mkdirSync(path.dirname(idx), { recursive: true })

const line = (n, text = 'x') => Array.from({ length: n }, () => text).join('\n')
const write = (text) => ({ file_path: idx, content: text })
const results = []
const check = (name, got, want) => {
  const ok = got === want
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`))
}
const rejected = (tool, args) => judgeIndexWrite(root, tool, args) !== undefined

check('201 行写入被拒', rejected('write', write(line(201))), true)
check('200 行写入放行', rejected('write', write(line(200))), false)
check('索引不存在时 201 行被拒', rejected('write', write(line(201))), true)

fs.writeFileSync(idx, line(210))
check('210 行时写 211 行被拒', rejected('write', write(line(211))), true)
check('210 行时写 205 行放行（压缩）', rejected('write', write(line(205))), false)
check('210 行时写 198 行放行', rejected('write', write(line(198))), false)

fs.writeFileSync(idx, line(199))
check('edit 从 199 行加到 201 行被拒', rejected('edit', {
  file_path: idx,
  old_string: 'x',
  new_string: 'x\nx\nx',
  replace_all: true,
}), true)

fs.writeFileSync(idx, line(210))
check('edit 让 210 行变短放行', rejected('edit', {
  file_path: idx,
  old_string: 'x\nx\nx',
  new_string: 'x',
  replace_all: true,
}), false)

fs.writeFileSync(idx, line(199))
check('edit 匹配不到时放行', rejected('edit', { file_path: idx, old_string: '不存在', new_string: 'x' }), false)

// 字节维度：130 行 × 200 字符 ≈ 26 KB > 25 KB
fs.writeFileSync(idx, line(100))
check('字节超限被拒（行数未超）', rejected('write', write(line(130, 'y'.repeat(200)))), true)
check('字节在限内放行', rejected('write', write(line(120, 'y'.repeat(200)))), false)

check('写非索引文件放行', rejected('write', { file_path: path.join(root, 'docs', 'a.md'), content: line(500) }), false)
check('写项目页放行', rejected('write', { file_path: path.join(root, 'projects', 'p', 'p.md'), content: line(500) }), false)
check('写项目记忆索引也守', rejected('write', {
  file_path: path.join(root, 'projects', 'p', 'memory', 'MEMORY.md'),
  content: line(201),
}), true)
check('read 不判', rejected('read', { file_path: idx }), false)
check('未知工具不判', rejected('some_other_tool', write(line(500))), false)
check('str_replace_editor create 超限被拒', rejected('str_replace_editor', {
  command: 'create', path: idx, file_text: line(201),
}), true)

// 集成：apply 注册的 guard 与 judge 一致，且能被关闭
let captured
const mkCtx = () => ({
  on() {},
  get() { return undefined },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  inject(names, cb) {
    if (names[0] === 'connection') {
      cb({ connection: { fetch: { register: () => () => {} } }, effect: (fn) => fn() })
    }
  },
  tools: { guard: (fn) => { captured = fn } },
})
apply(mkCtx())
check('apply 注册了 guard', typeof captured, 'function')
check('注册的 guard 拒绝超限写入', typeof captured({ name: 'write', arguments: write(line(201)) }), 'string')

// 索引上限不再可配置：apply 后恒为启用（上面已断言拒绝超限写入）。

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(parent, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
