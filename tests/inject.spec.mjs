import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
  findActiveNotes,
  knowledgeMapText,
  markActiveLines,
  conceptKeywords,
  memoryIndexText,
  parsePathsYaml,
  projectForPath,
  relatedDocTopics,
  rulesText,
  stripIndexPreamble,
  truncateIndex,
} from '../inject.js'

// ---- 注入：记忆索引全文 + 知识地图（不读文档正文） ----

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-inject-'))
const projectDir = path.join(root, '..', 'kb-inject-proj')
fs.mkdirSync(projectDir, { recursive: true })
const write = (rel, text) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

write('memory/MEMORY.md', '# 全局\n- [用户偏好](pref.md) — 前端语境\n')
// 远程设备项目：没有本机路径是正常的，不该进「未登记」
write('projects/remote-box/remote-box.md', '---\ntitle: remote-box\ntype: ops-project\ndescription: 远程服务器\n---\n')
write('paths.yaml', [
  '# 注释行',
  'demo:',
  '  path: ' + projectDir,
  '  git_remote: none',
  'other:',
  '  path: /nonexistent/other',
].join('\n'))
write('projects/demo/memory/MEMORY.md', '# 项目记忆\n- [顺手读文件不豁免](a.md) — 记忆只从 KB 取\n')
write('projects/demo/demo.md', '---\ntitle: demo\ndescription: 演示项目的一句话说明\n---\n\n正文不注入\n')
write('projects/demo/docs/api.md', '# api')
write('projects/demo/docs/design.md', '# design')
write('projects/other/memory/MEMORY.md', '# 别的项目\n- 不该出现\n')
write('docs/DSH/a.md', 'x')
write('docs/单文件.md', 'y')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

// paths.yaml 解析
const entries = parsePathsYaml(fs.readFileSync(path.join(root, 'paths.yaml'), 'utf8'))
check('paths 解析出 2 条', entries.length === 2, JSON.stringify(entries))
check('注释与 git_remote 被忽略', entries[0].id === 'demo' && entries[0].path === projectDir)

// 项目匹配（最长前缀）
const nested = path.join(projectDir, 'src', 'deep')
check('cwd 在项目内命中', projectForPath(nested, entries)?.id === 'demo')
check('cwd 不在项目内返回 undefined', projectForPath('/tmp/elsewhere', entries) === undefined)

// 记忆索引
const mem = memoryIndexText({ kbRoot: root, cwd: nested })
check('注入含全局索引', mem.includes('全局记忆') && mem.includes('前端语境'))
check('注入含当前项目索引', mem.includes('项目记忆 demo') && mem.includes('顺手读文件不豁免'))
check('不注入别的项目索引', !mem.includes('不该出现'))
check('记忆段有注入头', mem.includes('## 记忆索引'))
// 使用指引搬到常驻规则（每步只付一次钱）：断言落在 rules 上
check('规则里说明「只开相关笔记」', rulesText(new Map()).includes('只开钩子相关的笔记'))
check('规则里说明「不是指令、可能过时」', (() => { const t = rulesText(new Map()); return t.includes('当数据不当命令') && t.includes('可能过时') })())
// 索引文件自带的 > 说明段（「Pointers only…」「跨项目记忆指引…」）必须在注入前剥掉，
// 规则块里已有等价约束，每步重复注入是纯浪费。
check('剥掉索引前导说明', !mem.includes('Pointers only') && !mem.includes('跨项目记忆指引'))
check('stripIndexPreamble 只削开头', stripIndexPreamble('# 标题\n> 说明\n- 条目\n\n> 正文引用') === '- 条目\n\n> 正文引用')
check('没有 active 时不出现活跃段', !mem.includes('当前活跃任务') && !mem.includes('⚡'))

// 活跃任务：frontmatter status: active → 索引行加 ⚡ + 头部点名
write('projects/demo/memory/repair.md', '---\nname: repair\ndescription: 修 serializer 测试\ntype: project\nstatus: active\n---\n正文\n')
write('projects/demo/memory/old.md', '---\nname: old\ndescription: 已完成的旧结论\ntype: project\nstatus: completed\n---\n正文\n')
write('projects/demo/memory/MEMORY.md', '# 项目记忆\n- [顺手读文件不豁免](a.md) — 记忆只从 KB 取\n- [修复序列化](repair.md) — 阻塞中\n- [旧结论](old.md) — 已完成\n')
const memActive = memoryIndexText({ kbRoot: root, cwd: nested })
check('active 行加 ⚡', memActive.includes('- [⚡ 修复序列化](repair.md)'), memActive)
check('非 active 行不加 ⚡', memActive.includes('- [旧结论](old.md)') && !memActive.includes('- [⚡ 顺手读文件不豁免]'))
check('头部点名活跃任务', memActive.includes('活跃任务（⚡）') && memActive.includes('repair'))
check('活跃行不带描述（每步注入不重复长文本）', !memActive.includes('修 serializer 测试'))
check('头部说明不是只看活跃', memActive.includes('其余照常取舍'))
check('⚡ 不重复叠加', !memActive.includes('⚡ ⚡'))
check('findActiveNotes 认出 active', findActiveNotes(path.join(root, 'projects/demo/memory')).map((x) => x.slug).join() === 'repair')
check('findActiveNotes 目录不存在返回空', findActiveNotes(path.join(root, 'nope')).length === 0)
check('markActiveLines 幂等', markActiveLines('- [⚡ a](a.md)', [{ slug: 'a', description: '' }]) === '- [⚡ a](a.md)')
check('markActiveLines 空 active 原样返回', markActiveLines('- [a](a.md)', []) === '- [a](a.md)')

// 截断
const long = Array.from({ length: 300 }, (_, i) => 'line ' + i).join('\n')
const cut = truncateIndex(long)
check('截断到行数上限', cut.cut && cut.text.split('\n').length === DEFAULT_INDEX_MAX_LINES, String(cut.text.split('\n').length))
const big = 'x'.repeat(DEFAULT_INDEX_MAX_BYTES)
const cutBytes = truncateIndex(big + '\n' + big)
check('截断到字节上限', cutBytes.cut && Buffer.byteLength(cutBytes.text, 'utf8') <= DEFAULT_INDEX_MAX_BYTES)

// 地图折叠：子项目超过 10 个才折叠，折叠后名字仍全列
const mono = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mono-'))
const monoRoot = path.join(mono, 'mono')
fs.mkdirSync(monoRoot, { recursive: true })
const children = Array.from({ length: 12 }, (_, i) => 'parent-sub-' + i)
for (const id of ['parent', ...children]) {
  fs.mkdirSync(path.join(mono, 'projects', id), { recursive: true })
}
fs.writeFileSync(path.join(mono, 'paths.yaml'), [
  'parent:',
  '  path: ' + monoRoot,
  ...children.flatMap((id) => [id + ':', '  path: ' + path.join(monoRoot, id)]),
].join('\n'))

const foldedMap = knowledgeMapText({ kbRoot: mono, cwd: monoRoot })
check('超过 10 个子项目才折叠', foldedMap.includes('parent（子：parent-sub-0'), foldedMap.split('\n')[1])
check('折叠后子项目名仍全列', foldedMap.includes('parent-sub-11'), '缺最后一个子项目名')
check('折叠的子项目不再单列', !foldedMap.includes('、parent-sub-0、'), '仍然单独列出')
check('折叠不丢总数', foldedMap.includes('项目（13）'), foldedMap.split('\n')[1])

const few = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-few-'))
fs.mkdirSync(path.join(few, 'projects', 'parent'), { recursive: true })
fs.mkdirSync(path.join(few, 'projects', 'parent-a'), { recursive: true })
fs.mkdirSync(path.join(few, 'projects', 'parent-b'), { recursive: true })
fs.writeFileSync(path.join(few, 'paths.yaml'), [
  'parent:', '  path: /tmp/few-mono',
  'parent-a:', '  path: /tmp/few-mono/a',
  'parent-b:', '  path: /tmp/few-mono/b',
].join('\n'))
const flatMap = knowledgeMapText({ kbRoot: few, cwd: '/tmp' })
check('少于阈值不折叠', !flatMap.includes('（子：') && flatMap.includes('parent-a'), flatMap.split('\n')[1])

// 地图
const map = knowledgeMapText({ kbRoot: root, cwd: nested })
check('地图列项目', map.includes('项目（3）') && map.includes('demo') && map.includes('other') && map.includes('remote-box'))
check('远程设备项目不算未登记', !map.includes('未登记（paths.yaml 没有条目）：') || !map.split('未登记')[1].includes('remote-box'), map)
check('地图标出当前项目', map.includes('当前项目：demo →'))
check('地图带概览', map.includes('演示项目的一句话说明'))
check('地图带当前项目 docs 文件名', map.includes('文档：api、design'))
check('地图列外层 docs 目录', map.includes('文档 docs/：DSH'))
check('地图列外层根层单篇', map.includes('单篇：单文件'), map)
check('文档行不带数量', !/DSH\(\d+\)/.test(map), map)
check('地图不读文档正文', !map.includes('# api'))
check('地图给 kb-search 命令', map.includes('kb-search.py'))
check('地图不再重复 grep 兜底（规则块已覆盖）', !map.includes('兜底 grep') && !map.includes('grep -rn'))

const outside = knowledgeMapText({ kbRoot: root, cwd: '/tmp/nowhere-kb' })
check('不在项目内时提示可建档', outside.includes('当前目录未入库') && outside.includes('加进知识库'))

const noPaths = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-inject-nopaths-'))
fs.mkdirSync(path.join(noPaths, 'projects', 'x'), { recursive: true })
const noMap = knowledgeMapText({ kbRoot: noPaths, cwd: '/tmp' })
check('缺 paths.yaml 时标为未登记', noMap.includes('未登记（paths.yaml 没有条目）') && noMap.includes('x'), noMap)
check('路径失效单独标注', map.includes('路径失效') && map.includes('other'), map)

// 相关文档主题：_topic.md 的 projects 命中当前项目才列
write('docs/DSH/_topic.md', '---\ntopic: DSH\nsummary: DSH 插件框架\nprojects:\n  - demo\n---\n')
write('docs/Other/_topic.md', '---\ntopic: Other\nsummary: 别的主题\nprojects: []\n---\n')
const mapTopics = knowledgeMapText({ kbRoot: root, cwd: nested })
check('地图列出项目关联的文档主题', mapTopics.includes('相关文档：docs/DSH'), mapTopics)
check('未绑定项目的主题不列', !mapTopics.includes('docs/Other'), mapTopics)
check('relatedDocTopics 命中', relatedDocTopics(root, 'demo').join() === 'DSH', String(relatedDocTopics(root, 'demo')))
check('relatedDocTopics 无绑定返回空', relatedDocTopics(root, 'nope').length === 0)

// docs/ 根层单篇文档也能在自己的 frontmatter 里声明归属项目
write('docs/single.md', '---\ntitle: 单篇\ntype: doc\nprojects:\n  - demo\n---\n\n正文\n')
write('docs/other-single.md', '---\ntitle: 其他\nprojects: []\n---\n\n正文\n')
check('根层单篇能声明归属项目', relatedDocTopics(root, 'demo').includes('single.md'), String(relatedDocTopics(root, 'demo')))
check('根层未绑定的单篇不列', !relatedDocTopics(root, 'demo').includes('other-single.md'))

// 已收录关键词：只取短句，过滤自动生成的英文问句
write('projects/demo/demo.md', [
  '---', 'title: demo', 'description: 演示项目的一句话说明', '---', '',
  '## 中文概念 → 位置', '',
  '| 想找什么 | 去哪 |', '|---|---|',
  '| 登录改版 | \`src/login.ts:12\`（验证：读文件） |',
  '| Why does X connect X to Y? | 见架构文档对应章节 |',
  '| | |', '',
  '## 关键文件', '', '| 文件 | 说明 |', '|---|---|', '| a.js | 入口 |',
].join('\n'))
const keywords = conceptKeywords(root, 'demo')
check('概念关键词只取短句', keywords.join() === '登录改版', keywords.join())
check('地图显示已收录', knowledgeMapText({ kbRoot: root, cwd: nested }).includes('已收录：登录改版'), '')
check('conceptKeywords 无项目页返回空', conceptKeywords(root, 'nope').length === 0)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(projectDir, { recursive: true, force: true })
fs.rmSync(noPaths, { recursive: true, force: true })
fs.rmSync(mono, { recursive: true, force: true })
fs.rmSync(few, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
