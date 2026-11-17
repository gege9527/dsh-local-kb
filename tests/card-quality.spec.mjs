import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- 卡片质量守卫 ----
// 摘要提取曾跳过 ">" 开头的引用块，而文档模式产出的正文第一块正是 "> **info**" 引用块，
// 结果 207 篇文档的卡片摘要退化成残句。这些断言锁住回退链与孤儿清理。

const here = path.dirname(fileURLToPath(import.meta.url))
const tools = path.join(here, '..', 'skills', 'local-kb', 'tools')
const cardPy = path.join(tools, 'kb-card.py')
const searchPy = path.join(tools, 'kb-search.py')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-card-quality-'))
const write = (rel, text) => {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text)
}
const summaryOf = (rel) => {
  const text = fs.readFileSync(path.join(root, '.kb-index', 'cards', rel), 'utf8')
  const match = text.match(/^## 摘要\n([\s\S]*?)\n\n## /m)
  return match === null ? '' : match[1].trim()
}

// 1) 引用块 + 元数据开头的文档：摘要要拿到正文，不能只剩残句
write('docs/quote.md', [
  '---',
  'type: doc',
  'title: "Record"',
  'date_added: "2026-11-16"',
  '---',
  '> **info** 文档信息',
  '> **分类**: API-数据表',
  '> **来源**: [https://example.com](https://example.com)',
  '# Record',
  '',
  '## Record',
  '',
  '行记录。返回数据表中的一条记录，支持按主键查询与批量获取，字段类型自动转换。',
  '',
].join('\n'))

// 2) frontmatter summary 优先于正文
write('docs/summary.md', [
  '---',
  'title: 有摘要',
  'summary: 来自 frontmatter 的摘要，应该优先于正文被采用。',
  '---',
  '',
  '正文不该被选中。',
  '',
].join('\n'))

// 3) description 写 YAML 块标量（>-）：不能把 ">-" 当摘要
write('docs/folded.md', [
  '---',
  'title: 块标量',
  'description: >-',
  '  折叠成一行',
  '  的描述文本',
  '---',
  '',
  '正文。',
  '',
].join('\n'))

execFileSync('python3', [cardPy, root], { stdio: 'ignore' })

const quote = summaryOf('docs-quote.md')
const quoteBytes = Buffer.byteLength(quote, 'utf8')
check('引用块开头文档摘要 >= 40 字节', quoteBytes >= 40, `实际 ${quoteBytes} 字节: ${quote}`)
check('引用块开头的文档摘要不含引用块元数据', !quote.includes('**分类**') && !quote.includes('来源'), quote)
check('引用块开头的文档摘要不含标题行', !quote.startsWith('#'), quote)

const summ = summaryOf('docs-summary.md')
check('frontmatter summary 优先', summ === '来自 frontmatter 的摘要，应该优先于正文被采用。', summ)

const folded = summaryOf('docs-folded.md')
check('YAML 块标量不被读成字面量 >-', folded === '折叠成一行 的描述文本', folded)

// 4) 卡片数 == 源文件数；孤儿在重建时被清掉
const cardsDir = path.join(root, '.kb-index', 'cards')
const sources = fs.readdirSync(path.join(root, 'docs')).filter((n) => n.endsWith('.md'))
check('卡片数 == 源文件数', fs.readdirSync(cardsDir).filter((n) => n.endsWith('.md')).length === sources.length,
  `卡片 ${fs.readdirSync(cardsDir).length} / 源 ${sources.length}`)

fs.writeFileSync(path.join(cardsDir, 'docs-gone.md'), '---\ndoc: docs/gone.md\ntitle: GONE\ntype: card\ncard: 3\n---\n\n## 摘要\n已删除的文档\n\n## 小节\n- （无二级标题）\n')
execFileSync('python3', [searchPy, '行记录', root, '--rebuild'], { stdio: 'ignore' })
check('重建时清理孤儿卡片', !fs.existsSync(path.join(cardsDir, 'docs-gone.md')))

// 5) 版本哨兵：两处 CARD_VERSION 必须一致，否则每次检索都会整库重建
const readSrc = (name) => fs.readFileSync(path.join(tools, name), 'utf8')
const constOf = (name) => {
  const m = readSrc(name).match(/^CARD_VERSION = (\d+)/m)
  return m === null ? null : Number(m[1])
}
const cardVer = constOf('kb-card.py')
const searchVer = constOf('kb-search.py')
check('kb-card 与 kb-search 的 CARD_VERSION 一致', cardVer !== null && cardVer === searchVer, `${cardVer} vs ${searchVer}`)

// 6) 版本不符时的提示必须说清「整库重建」，不能谎称「过期 N 篇」
const verRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ver-'))
fs.mkdirSync(path.join(verRoot, 'docs'), { recursive: true })
fs.writeFileSync(path.join(verRoot, 'docs', 'a.md'), '---\ntitle: A\n---\n\n正文内容\n')
execFileSync('python3', [cardPy, verRoot], { stdio: 'ignore' })
fs.writeFileSync(path.join(verRoot, '.kb-index', '.card-version'), '0\n')
const run = spawnSync('python3', [searchPy, '正文', verRoot], { encoding: 'utf8' })
check('版本不符时提示整库重建', run.stderr.includes('已整库重建'), run.stderr.trim())
check('版本不符时不谎称「过期 N 篇」', !/过期 \d+ 篇/.test(run.stderr), run.stderr.trim())
fs.rmSync(verRoot, { recursive: true, force: true })

fs.rmSync(root, { recursive: true, force: true })

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
if (failed > 0) process.exitCode = 1
