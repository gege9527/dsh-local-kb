import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-card / kb-search：卡片生成与两段式检索 ----

const here = path.dirname(fileURLToPath(import.meta.url))
const toolsDir = path.join(here, '..', 'skill', 'tools')
const py = process.env.PYTHON ?? 'python3'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tools-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

write('docs/DSH/plugin.md', [
  '---',
  'title: "DSH 插件实战"',
  'type: doc',
  '---',
  '',
  '第一章讲插件加载，这是摘要段落。',
  '',
  '## 生命周期',
  '',
  '正文',
  '',
  '## 注册',
  '',
  '正文',
].join('\n'))
write('projects/demo/demo.md', '---\ntitle: demo\n---\n项目页\n')
write('projects/demo/docs/note.md', '---\ntitle: 笔记\n---\n\n笔记正文，提到插件加载\n')
write('projects/demo/memory/MEMORY.md', '# idx\n')

const run = (args) => execFileSync(py, [path.join(toolsDir, 'kb-card.py'), ...args], { encoding: 'utf8' })
const search = (args) => execFileSync(py, [path.join(toolsDir, 'kb-search.py'), ...args], { encoding: 'utf8' })

// 1. 卡片生成：项目页与记忆不生成卡片，文档与项目 docs 生成
const cardOut = run([kb])
check('kb-card 报告文档数', cardOut.includes('文档 2'), cardOut)
const cards = fs.readdirSync(path.join(kb, '.kb-index', 'cards'))
check('生成 2 张卡片', cards.length === 2, cards.join(','))
check('项目页不生成卡片', !cards.some((n) => n.startsWith('projects-demo-demo')), cards.join(','))

// 2. 卡片内容：标题、摘要、小节行号
const card = fs.readFileSync(path.join(kb, '.kb-index', 'cards', cards.find((n) => n.includes('plugin'))), 'utf8')
check('卡片带标题', card.includes('DSH 插件实战'))
check('卡片带摘要', card.includes('第一章讲插件加载'))
check('卡片带小节行号', /- 生命周期 \(L\d+\)/.test(card), card)

// 3. 检索：>=3 字走 FTS5
const hit = search(['插件加载', kb, '--rebuild'])
check('三字检索命中', hit.includes('命中') && hit.includes('docs/DSH/plugin.md'), hit)
check('检索给出行号', /L\d+:/.test(hit), hit)

// 4. 两字走 LIKE 兜底
const short = search(['注册', kb])
check('两字检索命中', short.includes('命中'), short)

// 5. 未命中给明确提示
const miss = search(['绝对不存在的词', kb])
check('未命中提示', miss.includes('未命中'), miss)

// 6. --check 模式报告缺卡
const checkOut = execFileSync(py, [path.join(toolsDir, 'kb-card.py'), kb, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString()
check('--check 报告缺卡', checkOut.includes('缺卡 0'), checkOut)

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
