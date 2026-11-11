import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-search 命中率回归：整句提问、关键词、项目页、记忆层、负例 ----
//
// 这套用例锁的是「问法」而不是「实现」：用户真实提问是整句中文，
// 旧实现（整串 trigram 匹配）在这套用例上 hit@5 只有 17%。

const here = path.dirname(fileURLToPath(import.meta.url))
const toolsDir = path.join(here, '..', 'skill', 'tools')
const py = process.env.PYTHON ?? 'python3'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-hit-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const doc = (title, body) => ['---', 'title: "' + title + '"', 'type: doc', '---', '', body].join('\n')

// docs
write('docs/DSH/publish.md', doc('DSH 第 7 章 发布插件', '把插件发布到 npm 的完整流程：改版本号、npm publish、校验 dist-tag。'))
write('docs/ai/memory-chapter.md', doc('AI Agent 第 3 章 用户记忆和知识库', '用户记忆与知识库的建法与召回顺序，projects 与 memory 目录如何分工。'))
write('docs/ci/caching.md', doc('依赖缓存', '工作流里缓存依赖可以缩短构建时间，key 按 lockfile 哈希。'))
write('docs/sheets/conditional-formatting.md', doc('条件格式', '按规则给单元格上色，支持公式与色阶。'))
write('docs/omniroute.md', doc('OmniRoute 配置手册', '本地实例的 combo 与回退配置，改完要重启。'))
write('docs/f2/timer.md', doc('动画与计时器', 'F2 的计时器控制动画推进，适合逐帧渲染。'))
write('docs/unrelated.md', doc('社区准则', '讨论区发帖规范与举报流程。'))

// 项目页与项目资料
write('projects/designer/designer.md', doc('designer', '表单设计器：基于 Univer 画布做渲染，支持组件拖拽。'))
write('projects/designer/docs/render.md', doc('渲染细节', '表单设计器的渲染链路：schema → 画布 → 组件。'))
write('projects/mirror/mirror.md', doc('mirror', 'iOS USB 投屏与控制，QuickTime 协议加 CoreDevice HID。'))
write('projects/ad-manager/ad-manager.md', doc('ad-manager', '广告投放管理与统计报表。'))

// 记忆（含一条干扰样本：正文里有「纠缠」，但和「量子纠缠」无关）
write('projects/designer/memory/scheme-note.md', ['---', 'name: scheme-note', 'description: 方案选型记录', 'type: project', '---', '', '两个方案的依赖互相纠缠，切换成本高。'].join('\n'))
write('memory/zebra-note.md', ['---', 'name: zebra-note', 'description: 斑马线配色约定', 'type: reference', '---', '', '全局记忆：zebra 指斑马线配色。'].join('\n'))
write('projects/designer/memory/designer-active.md', ['---', 'name: designer-active', 'description: 表单设计器当前进度', 'type: project', '---', '', 'status: active，下一步做渲染对齐。'].join('\n'))

const search = (q) => execFileSync(py, [path.join(toolsDir, 'kb-search.py'), q, kb], { encoding: 'utf8' })

const CASES = [
  ['整句', '插件怎么发布到 npm', ['DSH/publish.md']],
  ['整句', '知识库和用户记忆怎么做', ['memory-chapter.md']],
  ['整句', '缓存依赖怎么配', ['ci/caching.md']],
  ['整句', '表单设计器怎么渲染', ['designer/designer.md']],
  ['整句', '投屏协议是什么', ['mirror/mirror.md']],
  ['整句', 'F2 计时器怎么用', ['f2/timer.md']],
  ['关键词', '发布插件', ['DSH/publish.md']],
  ['关键词', '条件格式', ['sheets/conditional-formatting.md']],
  ['关键词', 'OmniRoute 配置', ['omniroute.md']],
  ['记忆', 'zebra 配色', ['zebra-note.md']],
  ['负例', '量子纠缠是什么', []],
  ['负例', '巴黎地铁票价', []],
]

const rows = []
let h1 = 0
let h5 = 0
let positives = 0
for (const [kind, q, expect] of CASES) {
  const out = search(q)
  const docs = [...out.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1])
  const mems = [...out.matchAll(/^- (.+\.md)/gm)].map((m) => m[1])
  const pool = docs.concat(mems)
  if (expect.length === 0) {
    rows.push({ kind, q, pos: pool.length ? 'FALSE-HIT' : 'ok', top: pool[0] || '-' })
    continue
  }
  positives++
  const hit = pool.findIndex((d) => expect.some((e) => d.includes(e)))
  if (hit >= 0) {
    h5++
    if (hit === 0) h1++
  }
  rows.push({ kind, q, pos: hit >= 0 ? hit + 1 : 'MISS', top: pool[0] || '-' })
}

for (const r of rows) console.log('      ' + [r.kind, r.q, 'pos=' + r.pos, 'top=' + r.top].join(' | '))

const hit1 = h1 / positives
const hit5 = h5 / positives
check('hit@1 ≥ 60%', hit1 >= 0.6, hit1.toFixed(2))
check('hit@5 ≥ 85%', hit5 >= 0.85, hit5.toFixed(2))
check('负例不误报', rows.filter((r) => r.pos === 'FALSE-HIT').length === 0, JSON.stringify(rows.filter((r) => r.pos === 'FALSE-HIT')))
// 别名层：声明过的名字必须能召回到；description 只给中间权重，别把宽泛描述顶成误伤
write('projects/kit/kit.md', ['---', 'title: "kit 组件库"', 'type: doc', 'description: 内部 UI 组件库，含按钮、表格、弹窗', 'aliases: 组件仓库, 内部组件库', '---', '', '基础组件集合，供各业务线复用。'].join('\n'))
write('docs/ui/buttons.md', doc('按钮样式规范', '按钮的尺寸、颜色与圆角规范。'))

const aliasOut = search('组件仓库里都有什么')
const aliasFirst = (/^1\. (.+)$/m.exec(aliasOut) || [])[1] || ''
check('别名命中置顶', aliasFirst === 'projects/kit/kit.md', aliasOut)

const descOut = search('内部 UI 组件库怎么用')
check('描述命中', descOut.includes('projects/kit/kit.md'), descOut)

write('memory/algo-note.md', ['---', 'name: algo-note', 'description: 算法选型记录', 'aliases: 选型笔记, 算法台账', 'type: reference', '---', '', '比较过几种方案。'].join('\n'))
const memAlias = search('翻一下算法台账')
check('记忆别名命中', memAlias.includes('algo-note.md'), memAlias)

check('别名查询不误伤邻近文档', !aliasFirst.includes('buttons.md'), aliasOut)

const decoy = search('量子纠缠是什么')
check('bigram 巧合不触发记忆', !decoy.includes('scheme-note.md'), decoy)
// 结果可信度：低覆盖要给警告，未命中要说清是哪一种
const weakOut = search('缓存的量子纠缠贝尔不等式')
check('低覆盖给低置信警告', weakOut.includes('低置信'), weakOut)
const strongOut = search('条件格式')
check('正常命中不误报低置信', !strongOut.includes('低置信'), strongOut)
const noTopic = search('巴黎地铁票价')
check('未命中区分"库内没有"', noTopic.includes('都没出现过') || noTopic.includes('相关阈值'), noTopic)

// grade_hits 纯函数：分母必须是查询全部辅助词，不能被"有 df 的词"缩小
const gradeCode = [
  'import importlib.util, sys',
  'spec = importlib.util.spec_from_file_location("s", sys.argv[1])',
  'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
  'card = {"aliases": [], "head": "x", "desc": "", "body": "x", "doc": "x"}',
  'print(m.grade_hits([(1.0, card, ["不等"])], ["量子", "纠缠", "不等", "贝尔"], "量子纠缠的贝尔不等式")[0])',
].join('\n')
const gradeOut = spawnSync(py, ['-c', gradeCode, path.join(toolsDir, 'kb-search.py')], { encoding: 'utf8' })
check('整句只剩一个巧合词判 weak', (gradeOut.stdout || '').trim() === 'weak', gradeOut.stdout + (gradeOut.stderr || ''))

const sentence = rows.filter((r) => r.kind === '整句' && r.pos !== 'MISS' && r.pos !== 'FALSE-HIT').length
check('整句提问 ≥ 5/6', sentence >= 5, sentence + '/6')

console.log('\n     命中率：hit@1 ' + h1 + '/' + positives + ' (' + Math.round(hit1 * 100) + '%)，hit@5 ' + h5 + '/' + positives + ' (' + Math.round(hit5 * 100) + '%)')
const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
