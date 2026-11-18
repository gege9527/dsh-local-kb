import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-card / kb-search：卡片生成与两段式检索 ----

const here = path.dirname(fileURLToPath(import.meta.url))
const toolsDir = path.join(here, '..', 'skills', 'local-kb', 'tools')
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
write('projects/demo/demo.md', ['---', 'title: demo', '---', '', '项目页', '', '## 中文概念 → 位置', '', '| 想找什么 | 去哪 | 查询关键词 |', '|---|---|---|', '| 示例功能 | `src/demo.ts:1` | DemoKey |', '', '## 关键文件', '', '| 文件 | 说明 |', '|---|---|', '| `scripts/run.sh` | 启动 |', ''].join('\n'))
write('projects/demo/docs/note.md', '---\ntitle: 笔记\n---\n\n笔记正文，提到插件加载\n')
write('projects/demo/memory/MEMORY.md', '# idx\n')

const run = (args) => execFileSync(py, [path.join(toolsDir, 'kb-card.py'), ...args], { encoding: 'utf8' })
const search = (args) => execFileSync(py, [path.join(toolsDir, 'kb-search.py'), ...args], { encoding: 'utf8' })

// 1. 卡片生成：记忆不生成卡片；文档、项目 docs、项目页都生成
const cardOut = run([kb])
check('kb-card 报告文档数', cardOut.includes('文档 3'), cardOut)
const cards = fs.readdirSync(path.join(kb, '.kb-index', 'cards'))
check('生成 3 张卡片', cards.length === 3, cards.join(','))
check('项目页也生成卡片', cards.some((n) => n.startsWith('projects-demo-demo')), cards.join(','))
check('记忆不生成卡片', !cards.some((n) => n.includes('MEMORY')), cards.join(','))

// 2. 卡片内容：标题、摘要、小节行号
const card = fs.readFileSync(path.join(kb, '.kb-index', 'cards', cards.find((n) => n.includes('plugin'))), 'utf8')
check('卡片带标题', card.includes('DSH 插件实战'))
check('卡片带摘要', card.includes('第一章讲插件加载'))
check('卡片带小节行号', /- 生命周期 \(L8\)/.test(card), card)
const pageCard = fs.readFileSync(path.join(kb, '.kb-index', 'cards', 'projects-demo-demo.md'), 'utf8')
check('项目页卡片不输出固定小节', !pageCard.includes('## 小节'), pageCard)
check('项目页卡片收录概念关键词', pageCard.includes('## 收录') && pageCard.includes('示例功能'), pageCard)
check('项目页卡片收录额外关键词', pageCard.includes('DemoKey'), pageCard)
check('项目页卡片收录文件路径', pageCard.includes('## 路径') && pageCard.includes('demo.ts') && pageCard.includes('run.sh'), pageCard)
check('文档卡片保留小节', card.includes('## 小节'), card)

// 3. 检索：文档命中走卡片层
const hit = search(['插件加载', kb, '--rebuild'])
check('三字检索命中', hit.includes('命中') && hit.includes('docs/DSH/plugin.md'), hit)
check('检索给出行号', /L\d+:/.test(hit), hit)

// 4. 短查询（两字）也要能命中
const short = search(['注册', kb])
check('两字检索命中', short.includes('命中'), short)

// 4b. 整句提问也能命中：拆词后不该被整串匹配拖死
const sentence = search(['插件加载是怎么实现的', kb])
check('整句提问命中文档', sentence.includes('docs/DSH/plugin.md'), sentence)
const sentenceProject = search(['demo 项目是干嘛的', kb])
check('整句提问命中项目页', sentenceProject.includes('projects/demo/demo.md'), sentenceProject)

// 5. 未命中给明确提示
const miss = search(['绝对不存在的词', kb])
check('未命中提示', miss.includes('未命中'), miss)

// 6. --check 模式报告缺卡
const checkOut = execFileSync(py, [path.join(toolsDir, 'kb-card.py'), kb, '--check'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).toString()
check('--check 报告缺卡', checkOut.includes('缺卡 0'), checkOut)

// 7. 卡片自检：缺卡时自动补齐；--no-auto 只提示
write('docs/DSH/new-doc.md', '---\ntitle: 新文档\n---\n\n新内容插件加载\n')
const noAuto = spawnSync(py, [path.join(toolsDir, 'kb-search.py'), '插件加载', kb, '--no-auto'], { encoding: 'utf8' })
check('--no-auto 只提示不写', noAuto.stderr.includes('缺卡 1') && !noAuto.stderr.includes('已自动更新'), noAuto.stderr)

const autoNew = spawnSync(py, [path.join(toolsDir, 'kb-search.py'), '插件加载', kb], { encoding: 'utf8' })
check('默认自动更新卡片', autoNew.stderr.includes('卡片已更新'), autoNew.stderr)
check('自动更新后能搜到新文档', autoNew.stdout.includes('new-doc.md'), autoNew.stdout)

const target = path.join(kb, 'docs/DSH/plugin.md')
const future = new Date(Date.now() + 60_000)
fs.utimesSync(target, future, future)
const staleOld = spawnSync(py, [path.join(toolsDir, 'kb-search.py'), '插件加载', kb], { encoding: 'utf8' })
check('文档更新后自动刷新', staleOld.stderr.includes('过期') || staleOld.stderr.includes('已自动更新'), staleOld.stderr)

// 8. 记忆层：文档没命中也要能搜到记忆正文
write('memory/global-note.md', '---\nname: global-note\ndescription: 全局记忆示例\ntype: reference\n---\n\n提到独有的记忆词条 zebra\n')
const memOnly = search(['zebra', kb])
check('记忆层命中', memOnly.includes('相关记忆 1 条') && memOnly.includes('memory/global-note.md'), memOnly)
check('记忆层带描述', memOnly.includes('全局记忆示例'), memOnly)

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
