import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 真实知识库命中率 ----
// 与 hit-rate.spec.mjs 的区别：那个用临时库（构造的文档/查询），这个跑真实 KB。
// 查询用「用户会怎么问」的自然语言，不用卡片里的原词，避免循环论证。
// 依赖真实库路径，因此不进 npm test；用 `npm run test:hit-real` 手动跑。

const here = path.dirname(fileURLToPath(import.meta.url))
const searchPy = path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb-search.py')
const KB = process.env.KB_ROOT || path.join(process.env.HOME, '.local-kb')

// kind: doc / project / memory；expect 用路径子串（项目页/文档）或 slug（记忆）
const CASES = [
  // 文档
  ['doc', '条件格式怎么设置', 'docs/Univer Sheets/'],
  ['doc', 'GitHub Actions 怎么配置部署', 'docs/GitHub Actions/'],
  ['doc', 'OmniRoute 两个实例配置 401', 'docs/OmniRoute配置手册.md'],
  ['doc', 'WPS 表格 Record 对象有哪些方法', 'docs/AirScript/'],
  ['doc', '上下文工程是什么', 'docs/AI-Agent/AI-Agent-第2章-上下文工程.md'],
  ['doc', 'F2 是什么框架', 'docs/F2 API文档/'],
  ['doc', 'N1 上 DSH 启动命令', 'docs/n1-service-commands.md'],
  ['doc', '插件怎么注册设置页', 'docs/DSH/'],
  ['doc', 'OKR 怎么写', 'docs/管理方法/OKR基础知识手册.md'],
  ['doc', 'Agent 的评估指标', 'docs/AI-Agent/AI-Agent-第7章-Agent 的评估.md'],
  ['doc', 'Record 方法', 'docs/AirScript/API/API-数据表-Record.md'],
  // 项目
  ['project', '不良事件管理前端', 'projects/adverse-events/'],
  ['project', '美柚优惠券脚本', 'projects/ad-manager/'],
  ['project', 'iOS 投屏到 Mac', 'projects/macpoc-ios-mirror/'],
  ['project', '万户 OA 日志怎么提交', 'projects/oa-wh-skill/'],
  ['project', 'DeepSeek Agent 框架', 'projects/deepseek-harness/'],
  ['project', '微信小程序菜谱', 'projects/wx/'],
  ['project', 'Excel 表单设计器工作区', 'projects/web-excel-designer/'],
  ['project', '活动管理后端 Java', 'projects/ezplatform-gh/'],
  ['project', '低代码流程设计器', 'projects/designer/'],
  ['project', '合同管理组件库', 'projects/contract/'],
  // 记忆
  ['memory', 'push 前要问用户', 'ask-before-push.md'],
  ['memory', 'commit message 用中文', 'commit-message-in-chinese.md'],
  ['memory', 'Node22 跑 Umi3 报错', 'node22-openssl-legacy-provider.md'],
  ['memory', 'GitHub push 要代理', 'github-push-needs-proxy.md'],
  ['memory', 'nvm 默认 Node 版本', 'nvm-node-versions.md'],
  ['memory', '快照 hardlink 污染', 'dsh-snapshot-hardlink-pollution.md'],
  ['memory', 'kb-search 命中率怎么测的', 'kb-search-hit-rate.md'],
  ['memory', '工作区迁移设计', 'workspace-migration-design.md'],
  ['memory', 'iOS USB 投屏协议细节', 'ios-usb-mirror-macos.md'],
  ['memory', '项目目录分层', 'source-dir-layout-2026-11.md'],
]

const rank = (list, expect) => {
  const i = list.findIndex((s) => s.includes(expect))
  return i === -1 ? Infinity : i + 1
}

const rows = []
for (const [kind, query, expect] of CASES) {
  const out = execFileSync('python3', [searchPy, query, KB, '--limit', '5'], { encoding: 'utf8' })
  // 注意：低置信提示里也含「相关记忆」四个字，必须匹配行首的标题行，否则文档列表会被截掉
  const memHead = out.match(/^相关记忆 \d+ 条$/m)
  const memAt = memHead === null ? -1 : out.indexOf(memHead[0])
  const docPart = memAt === -1 ? out : out.slice(0, memAt)
  const memPart = memAt === -1 ? '' : out.slice(memAt)
  const docs = [...docPart.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1].trim())
  const mems = [...memPart.matchAll(/^- (.+?) — /gm)].map((m) => m[1].trim())
  const list = kind === 'memory' ? mems : docs
  const r = rank(list, expect)
  // 低置信只针对「文档段」或「记忆段」，按期望类别取对应的那一段——
  // 否则记忆类查询会因文档段没命中而被记成「结果对却低置信」的误判
  const weak = kind === 'memory' ? memPart.includes('低置信') : docPart.includes('低置信')
  rows.push({ kind, query, expect, rank: r, weak, top: list.slice(0, 3) })
  const mark = r === 1 ? '①' : r === 2 ? '②' : r === 3 ? '③' : r <= 5 ? '⑤' : '✗'
  console.log(`${mark} [${kind}] ${query} → ${r === Infinity ? '未命中' : '第' + r + '位'}${weak ? ' (低置信)' : ''}`)
  if (r > 1) console.log('    top3: ' + (list.slice(0, 3).join(' | ') || '(空)'))
}

const kinds = ['doc', 'project', 'memory']
const rate = (list) => (n) => `${list.filter((r) => r.rank <= n).length}/${list.length}`
console.log('\n| 类别 | hit@1 | hit@3 | hit@5 | 低置信 |')
console.log('|---|---|---|---|---|')
for (const k of kinds) {
  const sub = rows.filter((r) => r.kind === k)
  const f = rate(sub)
  console.log(`| ${k} | ${f(1)} | ${f(3)} | ${f(5)} | ${sub.filter((r) => r.weak).length} |`)
}
const all = rate(rows)
console.log(`| **合计** | **${all(1)}** | **${all(3)}** | **${all(5)}** | ${rows.filter((r) => r.weak).length} |`)
const miss = rows.filter((r) => r.rank > 5)
if (miss.length) {
  console.log('\n未命中（前 5 无期望目标）:')
  for (const m of miss) console.log(`  - [${m.kind}] ${m.query} → 期望 ${m.expect}；实得 ${m.top.join(' | ') || '(空)'}`)
}
