import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
  knowledgeMapText,
  memoryIndexText,
  parsePathsYaml,
  projectForPath,
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
check('记忆段有「已注入」提示', mem.includes('已注入'))

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
check('地图列项目', map.includes('项目（2）') && map.includes('demo') && map.includes('other'))
check('地图标出当前项目', map.includes('当前项目：demo →'))
check('地图带概览', map.includes('演示项目的一句话说明'))
check('地图带文档目录', map.includes('文档：api、design'))
check('地图不读文档正文', !map.includes('# api'))
check('地图给检索命令', map.includes('grep -rn'))

const outside = knowledgeMapText({ kbRoot: root, cwd: '/tmp/nowhere-kb' })
check('不在项目内时提示别猜', outside.includes('不在任何已登记项目内'))

const noPaths = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-inject-nopaths-'))
fs.mkdirSync(path.join(noPaths, 'projects', 'x'), { recursive: true })
const noMap = knowledgeMapText({ kbRoot: noPaths, cwd: '/tmp' })
check('缺 paths.yaml 时标为未登记', noMap.includes('未登记（paths.yaml 没有条目）') && noMap.includes('x'), noMap)
check('路径失效单独标注', map.includes('路径失效') && map.includes('other'), map)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(projectDir, { recursive: true, force: true })
fs.rmSync(noPaths, { recursive: true, force: true })
fs.rmSync(mono, { recursive: true, force: true })
fs.rmSync(few, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
