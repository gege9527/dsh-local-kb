import { codeWritesKb } from '../index.js'

// ---- run_code 写 KB 判定：先要求有 fs 写调用，再按 classifyPath 判路径 ----

const KB = '/tmp/kb-code-test'
const results = []
const check = (name, got, want) => {
  const ok = got === want
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  got=${got} want=${want}`))
}
const c = (code) => codeWritesKb(KB, { code })

// 命中：写调用 + KB 路径
check('fs.writeFileSync 写 KB', c(`const fs = await import('node:fs'); fs.writeFileSync('${KB}/memory/x.md', 'hi')`), true)
check('fs.appendFileSync 追加 KB', c(`fs.appendFileSync('${KB}/memory/MEMORY.md', '- [x](x.md)\n')`), true)
check('fs.promises.writeFile 写 KB', c(`await fs.promises.writeFile('${KB}/docs/a.md', body)`), true)
check('fs.rm 删 KB', c(`fs.rm('${KB}/memory/old.md')`), true)
check('fs.mkdirSync 建 KB 目录', c(`fs.mkdirSync('${KB}/projects/new')`), true)
check('createWriteStream 写 KB', c(`fs.createWriteStream('${KB}/docs/b.md')`), true)

// 不命中：只读 / 写别处 / 无写动作
check('fs.readFileSync 只读 KB', c(`const t = fs.readFileSync('${KB}/memory/MEMORY.md', 'utf8')`), false)
// 同一段代码里读 KB 又写别处：多触发一次体检（幂等），不漏跑
check('读 KB + 写 /tmp（宁多跑不漏跑）', c(`fs.readFileSync('${KB}/x.md'); fs.writeFileSync('/tmp/y.md', 'hi')`), true)
check('写 /tmp 无关', c(`fs.writeFileSync('/tmp/y.md', 'hi')`), false)
check('纯读取 KB', c(`inspect(fs.readdirSync('${KB}'))`), false)
check('tools.write 不算（由嵌套调用单独触发）', c(`await tools.write({ file_path: '${KB}/memory/x.md', content: 'hi' })`), false)
check('空 code', c(''), false)
check('非 run_code 参数', codeWritesKb(KB, { command: 'ls' }), false)
check('code 不是字符串', codeWritesKb(KB, { code: 123 }), false)

// 变量拼路径：退回文本包含
check('模板变量 + KB 字面量', c(`const p = \`${KB}/memory/\${name}.md\`; fs.writeFileSync(p, 'x')`), true)
check('~ 简写路径', codeWritesKb('/Users/x/.local-kb', { code: `fs.writeFileSync('/Users/x/.local-kb/memory/a.md', 'x')` }), true)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
if (failed > 0) process.exitCode = 1
