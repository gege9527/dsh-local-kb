/**
 * inject.js — 每轮放进 dsh runtime context 的「记忆索引 + 知识地图」。
 *
 * 两条不同的数据，两种不同的注入理由：
 *
 *  - 记忆（memory/MEMORY.md、projects/<id>/memory/MEMORY.md）是**召回型**：模型必须
 *    每轮知道「记过什么」，靠自己去 read 会被跳过，所以整份注入，按上限截断。
 *  - 知识（所有项目页与文档）是**检索型**：正文永远不注入，只注入「地图」——
 *    有哪些项目、当前项目是谁、它的文档目录叫什么。让模型知道去哪 grep，而不是替它读。
 *
 * dsh 每个 step 同步调用 context.text()，所以这里只用同步 IO，并按 mtime/size 缓存：
 * 一次 step 的代价是几次 stat，不是几次 readFile。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 同一份文件在这个窗口内不重复 stat（dsh 每步都会问一次）。 */
const RECHECK_MS = 10_000
/**
 * 单个索引注入上限：超过就截断并提示压缩。
 * 描述规范化成「一行钩子」（≤24 字）后，单行约 55–70 字符，行数是主约束；
 * 120 行给当前最大索引（74 行）留出增长空间，避免静默截断。
 */
export const DEFAULT_INDEX_MAX_LINES = 120
export const DEFAULT_INDEX_MAX_BYTES = 12 * 1024
/** 索引文件大到这个程度就不读（不是记忆索引该有的体量）。 */
const INDEX_READ_LIMIT = 1024 * 1024
/** 地图里最多列几个项目 id / 文档目录名。 */
const MAP_MAX_PROJECTS = 60
/** 一个父项目下的子项目超过这个数才折叠（当前 OA-AI 有 5 个，不折叠）。 */
const MAP_FOLD_THRESHOLD = 10
const MAP_MAX_DOCS = 8

/**
 * 技能自带的检索脚本绝对路径。每轮注入里给 grep 之外的更优选项：
 * kb-search 会带置信分级，弱结果直接告警，裸 grep 没有这层判断。
 * 脚本缺失（裁剪安装）时返回 null，注入回落成纯 grep 提示。
 */
export function kbSearchPath(moduleUrl = import.meta.url) {
  // 只认包内这一份（技能随包加载）。旧安装留下的同名脚本可能停在旧版本，
  // 回落到它只会跑出过期结果 —— 宁可返回 null，让注入回落成纯 grep 提示。
  try {
    const p = join(skillDir(moduleUrl), 'tools', 'kb-search.py')
    if (statSync(p).isFile()) return p
  } catch {}
  return null
}

/** 技能目录：0.4.0 起跟 DSH 技能根布局一致（skills/<name>/），由 bundledSkillDir 直接加载。 */
export function skillDir(moduleUrl = import.meta.url) {
  return join(dirname(fileURLToPath(moduleUrl)), 'skills', 'local-kb')
}

/** 常驻规则文件：技能自带的 references/agents-snippet.md（与 AGENTS.md 里那块同源）。 */
export function rulesPath(moduleUrl = import.meta.url) {
  return join(skillDir(moduleUrl), 'references', 'agents-snippet.md')
}

/** 常驻规则注入上限：正常 3.6 KB，超了截断（宁可少注入，不撑爆系统提示）。 */
export const RULES_MAX_CHARS = 8 * 1024
/** 规则文件按 mtime/size 缓存，dsh 每个 step 都同步问一次。 */
const RULES_CACHE = new Map()

const MARKER_START = /^<!--\s*KB_LOCAL_START\s*-->$/
const MARKER_END = /^<!--\s*KB_LOCAL_END\s*-->$/

/** 摘掉 KB_LOCAL 的 HTML 标记行：那是旧 AGENTS.md 用来定位块的，注入时不该出现。 */
export function stripRuleMarkers(text) {
  return String(text ?? '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !MARKER_START.test(trimmed) && !MARKER_END.test(trimmed)
    })
    .join('\n')
    .trim()
}

/**
 * 每轮注入的常驻规则正文（替代旧方案写进 AGENTS.md 的 KB_LOCAL 块）。
 * 读不到就返回空串：规则缺失不能拖垮请求。
 */
export function rulesText(cache = RULES_CACHE, moduleUrl = import.meta.url) {
  const file = rulesPath(moduleUrl)
  const cached = readCached(file, cache)
  if (cached === undefined) return ''
  const body = stripRuleMarkers(cached.text)
  // 注入正文只放与机器无关的内容：技能里的路径一律相对技能目录，由 harness 加载技能时
  // 补 base directory；绝不把本机绝对路径写进提示词 —— 换机器 / 换安装位置就成了错的答案。
  return body.length <= RULES_MAX_CHARS ? body : body.slice(0, RULES_MAX_CHARS) + '\n…（规则过长已截断）'
}


/**
 * 解析 paths.yaml —— 只认本插件自己写的那两种缩进（id: / path: / git_remote:），
 * 不引入 YAML 依赖，也不猜锚点、多行标量这些用不到的语法。
 */
export function parsePathsYaml(text) {
  const out = []
  let current
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line === '' || line.startsWith('#')) continue
    // id 允许中文（目录名原样保留），所以不能只认 ASCII
    const head = line.match(/^([A-Za-z0-9_.\u4e00-\u9fff-]+):\s*$/)
    if (head) {
      current = { id: head[1], path: undefined }
      out.push(current)
      continue
    }
    const field = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/)
    if (!field || current === undefined) continue
    const value = field[2].trim().replace(/^["']|["']$/g, '')
    if (field[1] === 'path' && value !== '') current.path = value
  }
  return out.filter((entry) => entry.path !== undefined)
}

/** cwd 落在哪个项目（最长前缀），没有就 undefined。 */
export function projectForPath(cwd, entries) {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const target = resolve(cwd)
  let best
  for (const entry of entries) {
    const root = resolve(entry.path)
    if (target === root || target.startsWith(root + sep)) {
      if (best === undefined || root.length > best.root.length) best = { ...entry, root }
    }
  }
  return best
}

/** 项目页 frontmatter 的 type（code-project / ops-project / doc …），读不到返回 undefined。 */
export function projectKind(kbRoot, id, cache) {
  const file = readCached(join(kbRoot, 'projects', id, id + '.md'), cache)
  if (file === undefined) return undefined
  const match = file.text.slice(0, 2048).match(/^type:\s*(\S+)/m)
  return match ? match[1] : undefined
}

/** 目录是否存在（缓存 10 秒，避免每步 stat 一遍所有项目路径）。 */
function pathExists(dir, cache) {
  const key = 'exists:' + dir
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && now - hit.at < RECHECK_MS) return hit.value
  let value = false
  try {
    value = statSync(dir).isDirectory()
  } catch {
    value = false
  }
  cache.set(key, { at: now, value })
  return value
}

/** 带 mtime/size 缓存的同步读；读不到返回 undefined。 */
function readCached(path, cache) {
  const now = Date.now()
  const hit = cache.get(path)
  if (hit !== undefined && now - hit.at < RECHECK_MS) return hit.value
  let value
  try {
    const st = statSync(path)
    if (!st.isFile() || st.size > INDEX_READ_LIMIT) {
      value = undefined
    } else {
      value = { text: readFileSync(path, 'utf8'), mtimeMs: st.mtimeMs, size: st.size }
    }
  } catch {
    value = undefined
  }
  cache.set(path, { at: now, value })
  return value
}

/** 只保留前面的整行，直到行数或字节任一上限。 */
export function truncateIndex(text, maxLines = DEFAULT_INDEX_MAX_LINES, maxBytes = DEFAULT_INDEX_MAX_BYTES) {
  const lines = String(text).split('\n')
  const kept = []
  let bytes = 0
  for (const line of lines) {
    if (kept.length >= maxLines) return { text: kept.join('\n'), cut: true }
    const size = Buffer.byteLength(line, 'utf8') + (kept.length === 0 ? 0 : 1)
    if (bytes + size > maxBytes) return { text: kept.join('\n'), cut: true }
    kept.push(line)
    bytes += size
  }
  return { text: kept.join('\n'), cut: false }
}

const rel = (kbRoot, path) => path.startsWith(kbRoot + sep) ? path.slice(kbRoot.length + 1) : path

/** frontmatter 里 description 的取法：折叠标量（>- / |）没有单行值，就不带描述。 */
function frontmatterDescription(head) {
  const match = head.match(/^description:\s*(.*)$/m)
  if (match === undefined) return ''
  const value = match[1].trim()
  return value === '' || value === '>-' || value === '>' || value === '|' || value === '|-' ? '' : value
}

/**
 * 找记忆目录里的活跃任务笔记（`status: active`）。
 * 只读文件前 512 字节：frontmatter 一定在前部，笔记正文可能有 12KB。
 * 目录不存在 / 没有 active 一律返回空数组，绝不抛错。
 */
export function findActiveNotes(dir, cache = new Map()) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const actives = []
  for (const name of names) {
    if (!name.endsWith('.md') || name === 'MEMORY.md') continue
    const file = readCached(join(dir, name), cache)
    if (file === undefined) continue
    const head = file.text.slice(0, 512)
    if (!/^status:\s*active\s*$/m.test(head)) continue
    actives.push({ slug: name.slice(0, -3), description: frontmatterDescription(head) })
  }
  return actives
}

/**
 * 抽掉指针行里的 ` — 描述`：描述是笔记内容，不是索引。
 * 索引每步都注入，带上描述等于把内容每步付一遍（实测描述占索引体积 48%）。
 * 只动指针行，标题、链接、⚡ 与非指针行（小节标题、说明）原样保留。
 */
export function stripDescriptions(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      if (!/^\s*-\s/.test(line)) return line
      const cut = line.indexOf(' — ')
      return cut < 0 ? line : line.slice(0, cut)
    })
    .join('\n')
}

/** 把索引里指向活跃笔记的行加 `⚡`（幂等：已带标记的不重复加）。 */
export function markActiveLines(text, actives) {
  if (actives.length === 0) return text
  const slugs = new Set(actives.map((item) => item.slug))
  return String(text).split('\n').map((line) => {
    const match = line.match(/^(\s*-\s*\[)([^\]]*)(\]\(([^)]+)\))/)
    if (match === null) return line
    const slug = match[4].replace(/^.*\//, '').replace(/\.md$/, '')
    if (!slugs.has(slug) || match[2].startsWith('⚡')) return line
    return match[1] + '⚡ ' + line.slice(match[1].length)
  }).join('\n')
}

/**
 * 记忆索引段：全局 + 当前项目。返回空串表示没有任何索引（不注入空标题）。
 */
export function memoryIndexText({
  kbRoot,
  cwd,
  cache = new Map(),
  maxLines = DEFAULT_INDEX_MAX_LINES,
  maxBytes = DEFAULT_INDEX_MAX_BYTES,
  withDescriptions = true,
}) {
  const parts = []
  let actives = []
  const read = (path, label, activeNotes = [], note = '') => {
    const file = readCached(path, cache)
    if (file === undefined || file.text.trim() === '') return
    // 索引文件顶部的 `>` 段落是给人看的协议说明（「Pointers only…」「跨项目记忆指引…」），
    // 规则块里已有等价约束，每步重复注入纯属浪费 → 注入前剥掉。
    const body = stripIndexPreamble(file.text)
    // 先去描述、再标 ⚡、最后截断：描述不占行，能多带几行指针。
    const lean = withDescriptions ? body : stripDescriptions(body)
    const cut = truncateIndex(markActiveLines(lean, activeNotes), maxLines, maxBytes)
    parts.push(
      `### ${label} · ${rel(kbRoot, path)}\n` +
      (note === '' ? '' : note + '\n') +
      cut.text +
      (cut.cut ? '\n（索引超过注入上限，已截断；先压缩索引再追加）' : ''),
    )
  }

  // 项目记忆在前、全局记忆在后：项目段给当前任务的语境，全局段是兜底。
  // 反过来（全局在前）时，模型扫完项目段就开始干活，全局段等于没注入。
  const entries = pathsEntries(kbRoot, cache)
  const project = projectForPath(cwd, entries)
  if (project !== undefined) {
    const memoryDir = join(kbRoot, 'projects', project.id, 'memory')
    actives = findActiveNotes(memoryDir, cache)
    read(join(memoryDir, 'MEMORY.md'), `项目记忆 ${project.id}`, actives)
    // 父项目（monorepo 外壳）只放跨子项目决策，对当前子项目仍然生效，所以也注入正文。
    // 子项目拆分后父库条目很少（本项目 7 条），成本可接受；不注入等于让跨插件约束永久失效。
    const parent = parentProjectFor(project, entries)
    if (parent !== undefined) {
      read(join(kbRoot, 'projects', parent.id, 'memory', 'MEMORY.md'), `父项目记忆 ${parent.id}`)
    }
  }
  read(
    join(kbRoot, 'memory', 'MEMORY.md'),
    '全局记忆',
    [],
    '> 跨项目默认生效层：工具链、网络、环境、偏好、方法论。**项目记忆没覆盖的操作（push / 代理 / 启动命令 / 安装）先在这里找，别默认无关。**',
  )

  if (parts.length === 0) return ''
  // 头部原则：索引只替代「读索引文件」，不替代「读笔记」。
  // 使用指引（只开相关笔记 / 两级都扫 / 可能过时）已在常驻规则的「记忆召回」段，
  // 这里只留标题和一句最小提示，避免每步把同一句话付两遍钱。
  const header = ['## 记忆索引', '', '（索引 ≠ 笔记）']
  if (actives.length > 0) {
    // 只列 slug：描述在笔记里，索引行每步都重复注入，带上描述纯属浪费。
    const list = actives.map((item) => item.slug).join('；')
    header.push(
      '',
      `**活跃任务（⚡）**：${list}`,
      '⚡ = 接续恢复锚点；其余照常取舍。',
    )
  }
  header.push('')
  return header.join('\n') + parts.join('\n\n')
}

/**
 * 去掉索引文件开头的 `>` 说明段（含空行），只留标题与条目。
 * 只处理文件开头连续出现的部分，正文中间的引用块原样保留。
 */
export function stripIndexPreamble(text) {
  const lines = String(text ?? '').split('\n')
  let i = 0
  // 允许开头是标题（# / ##），说明段通常紧随其后
  if (lines[i]?.startsWith('#')) i += 1
  while (i < lines.length) {
    const line = lines[i].trim()
    if (line === '') { i += 1; continue }
    if (line.startsWith('>')) { i += 1; continue }
    break
  }
  return lines.slice(i).join('\n')
}

/**
 * 当前项目的父项目：paths.yaml 里路径是当前项目根的严格前缀，取最长的那个。
 * 用于 monorepo：子项目命中时，父库的「跨子项目决策」也要注入。
 */
export function parentProjectFor(project, entries) {
  if (project === undefined || typeof project.root !== 'string') return undefined
  let best
  let bestLen = -1
  for (const entry of entries) {
    if (entry.id === project.id) continue
    const root = resolve(entry.path)
    if (root === project.root) continue
    if (!project.root.startsWith(root + sep)) continue
    if (root.length > bestLen) {
      best = entry
      bestLen = root.length
    }
  }
  return best
}

/** paths.yaml 的缓存读取（项目清单与当前项目都靠它）。 */
function pathsEntries(kbRoot, cache) {
  const file = readCached(join(kbRoot, 'paths.yaml'), cache)
  if (file === undefined) return []
  return parsePathsYaml(file.text)
}

/**
 * 项目页 frontmatter 的 description（只读开头一小段，不整份读）。
 * 同时支持单行值与 YAML 块标量（>- / | 等）：只认 `(.*)` 时，折叠写法的
 * 项目会把 `>-` 原样注入成「概览：>-」（oa-wh-skill / skills 实测）。
 */
export function projectDescription(pagePath, cache) {
  const file = readCached(pagePath, cache)
  if (file === undefined) return undefined
  const lines = file.text.slice(0, 4096).split('\n')
  const at = lines.findIndex((line) => /^description:/.test(line))
  if (at === -1) return undefined
  const inline = lines[at].slice('description:'.length).trim()
  if (!/^[>|][+-]?$/.test(inline)) {
    return inline === '' ? undefined : inline.replace(/^["']|["']$/g, '')
  }
  // 块标量：后续缩进行都属于它；遇到顶格行结束。
  const text = []
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      if (text.length > 0) text.push('')
      continue
    }
    if (!/^\s/.test(line)) break
    text.push(line.trim())
  }
  const folded = text.join(' ').replace(/\s+/g, ' ').trim()
  return folded === '' ? undefined : folded
}

/** 项目的 docs/ 目录名清单（只列名字，不读文档）。 */
function projectDocNames(kbRoot, id) {
  try {
    return readdirSync(join(kbRoot, 'projects', id, 'docs'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
      .map((entry) => entry.name.replace(/\.md$/i, ''))
      .slice(0, MAP_MAX_DOCS)
  } catch {
    return []
  }
}

/**
 * 项目页「中文概念 → 位置」表里的关键词，供注入地图显示「已收录」。
 * 只取短句（≤30 字符），自动生成的英文问句会被长度过滤掉。
 */
export function conceptKeywords(kbRoot, projectId, cache = new Map(), limit = 8) {
  const file = readCached(join(kbRoot, 'projects', projectId, projectId + '.md'), cache)
  if (file === undefined) return []
  const text = file.text
  const start = text.indexOf('## 中文概念 → 位置')
  if (start === -1) return []
  const rest = text.slice(start)
  const end = rest.indexOf('\n## ', 5)
  const block = end === -1 ? rest : rest.slice(0, end)
  const out = []
  for (const line of block.split('\n')) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map((cell) => cell.trim())
    const key = cells[1] ?? ''
    if (key === '' || key === '想找什么' || /^[-: ]+$/.test(key)) continue
    if (key.length > 30 || key.includes('Why ') || key.includes('What ')) continue
    out.push(key)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 与项目关联的文档主题：读 docs/<主题>/_topic.md 的 projects 列表。
 * 只返回明确绑定的主题，不列「通用」——每轮注入不该塞无差别提示。
 */
/** 解析页面 frontmatter 的内联列表字段：`key: [a, b]`；没有该字段返回 []。 */
function inlineList(head, key) {
  const match = head.match(new RegExp('^' + key + ':\\s*\\[([^\\]]*)\\]\\s*$', 'm'))
  if (match === null) return []
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item !== '')
}

/**
 * 项目页声明的查询例外：search_roots（项目内子目录）、search_exclude（额外排除目录）、
 * search_projects（要一起搜的其他项目 id）。默认命令在常驻规则里，这里只补差异。
 */
export function searchHints(kbRoot, projectId, cache = new Map()) {
  const file = readCached(join(kbRoot, 'projects', projectId, projectId + '.md'), cache)
  if (file === undefined) return undefined
  const head = file.text.slice(0, 4096)
  const roots = inlineList(head, 'search_roots')
  const excludes = inlineList(head, 'search_exclude')
  const projects = inlineList(head, 'search_projects')
  if (roots.length === 0 && excludes.length === 0 && projects.length === 0) return undefined
  return { roots, excludes, projects }
}

function projectListOf(text) {
  const head = text.slice(0, 1024)
  const list = []
  const block = head.match(/^projects:\s*\n((?:\s+-\s+.*\n?)*)/m)
  if (block !== null) {
    for (const line of block[1].split('\n')) {
      const item = line.match(/^\s+-\s+(\S+)/)
      if (item !== null) list.push(item[1].trim())
    }
    return list
  }
  const inline = head.match(/^projects:\s*\[([^\]]*)\]\s*$/m)
  if (inline !== null) {
    for (const part of inline[1].split(',')) {
      const id = part.trim()
      if (id !== '') list.push(id)
    }
  }
  return list
}

/**
 * 与项目关联的文档主题：读 docs/<主题>/_topic.md 的 projects 列表。
 * 只返回明确绑定的主题，不列「通用」——每轮注入不该塞无差别提示。
 */
export function relatedDocTopics(kbRoot, projectId, cache = new Map()) {
  const docsDir = join(kbRoot, 'docs')
  let entries
  try {
    entries = readdirSync(docsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = readCached(join(docsDir, entry.name, '_topic.md'), cache)
    if (file === undefined) continue
    if (projectListOf(file.text).includes(projectId)) out.push(entry.name)
  }
  return out
}

/** docs/ 的顶层分类目录与根层单篇文档（不递归、不报数量——数量会变）。 */
function globalDocs(kbRoot) {
  try {
    const entries = readdirSync(join(kbRoot, 'docs'), { withFileTypes: true })
    const dirs = []
    const files = []
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(entry.name)
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(entry.name.replace(/\.md$/, ''))
    }
    return { dirs, files }
  } catch {
    return { dirs: [], files: [] }
  }
}

/**
 * 知识地图：让模型知道 KB 里有什么、当前项目是哪个、去哪查。
 * 不注入任何文档正文。
 */
export function knowledgeMapText({ kbRoot, cwd, cache = new Map() }) {
  const entries = pathsEntries(kbRoot, cache)
  const projectsDir = join(kbRoot, 'projects')
  let dirs = []
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return ''
  }
  const mapped = new Set(entries.map((entry) => entry.id))
  // ops-project（远程设备/服务器）本来就没有本地代码，不算「未登记」。
  const missing = dirs.filter((id) => !mapped.has(id) && projectKind(kbRoot, id, cache) !== 'ops-project')
  // 路径失效：登记了但指向别的机器的目录（新设备下载 paths.yaml 后的常态）。
  const stale = entries.filter((entry) => !pathExists(entry.path, cache)).map((entry) => entry.id)

  // 父子关系按「路径的直接父目录」判定，不靠 id 前缀（oa-ai-web 这类会被误判）。
  const byPath = new Map(entries.map((entry) => [resolve(entry.path), entry]))
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  // id 与磁盘目录名不一致时补上目录名：移动过或历史命名的项目，光看 id 推不出目录。
  const withDir = (id) => {
    const base = byId.get(id)?.path === undefined ? undefined : basename(byId.get(id).path)
    return base !== undefined && base !== id ? `${id}（${base}）` : id
  }
  const childrenOf = new Map()
  const allChildren = new Set()
  for (const entry of entries) {
    const parent = byPath.get(dirname(resolve(entry.path)))
    if (parent === undefined) continue
    allChildren.add(entry.id)
    if (!childrenOf.has(parent.id)) childrenOf.set(parent.id, [])
    childrenOf.get(parent.id).push(entry.id)
  }
  // 子项目超过阈值才折叠；折叠时仍把名字全列出来，模型不失去线索。
  const folded = new Map()
  for (const [parentId, kids] of childrenOf) {
    if (kids.length > MAP_FOLD_THRESHOLD) folded.set(parentId, kids)
  }
  const hidden = new Set()
  for (const kids of folded.values()) for (const kid of kids) hidden.add(kid)

  const ids = []
  for (const id of dirs) {
    if (hidden.has(id)) continue
    ids.push(folded.has(id) ? `${id}（子：${folded.get(id).join('、')}）` : withDir(id))
  }
  const shown = ids.slice(0, MAP_MAX_PROJECTS)

  const lines = [`## 知识库地图 · ${kbRoot}`]
  lines.push(`项目（${dirs.length}）：` + shown.join('、') + (ids.length > shown.length ? ' …' : ''))
  if (stale.length > 0) {
    lines.push('路径失效（登记的是原设备路径，用 git_remote 重新登记）：' + stale.join('、'))
  }
  if (missing.length > 0) {
    lines.push('未登记（paths.yaml 没有条目）：' + missing.join('、') + ' —— 写记忆前先跑 kb-add-project.py')
  }

  const project = projectForPath(cwd, entries)
  if (project !== undefined) {
    lines.push(`当前项目：${project.id} → ${project.root}`)
    const description = projectDescription(join(kbRoot, 'projects', project.id, project.id + '.md'), cache)
    if (description !== undefined) lines.push('  概览：' + description)
    const docs = projectDocNames(kbRoot, project.id)
    if (docs.length > 0) lines.push('  文档：' + docs.join('、'))
    const topics = relatedDocTopics(kbRoot, project.id, cache)
    if (topics.length > 0) lines.push('  相关文档：' + topics.map((dir) => 'docs/' + dir).join('、'))
    const hints = searchHints(kbRoot, project.id, cache)
    if (hints !== undefined) {
      const parts = []
      if (hints.roots.length > 0) parts.push('根 ' + hints.roots.map((r) => r + '/').join('、'))
      if (hints.excludes.length > 0) parts.push('排除 ' + hints.excludes.map((r) => r + '/').join('、'))
      if (hints.projects.length > 0) parts.push('跨项目 ' + hints.projects.join('、'))
      lines.push('  查源码：' + parts.join('；') + '（其余用常驻规则的默认排除集）')
    }
    const concepts = conceptKeywords(kbRoot, project.id, cache)
    if (concepts.length > 0) {
      lines.push('  已收录：' + concepts.join('、') + '（先看项目页，别重复搜）')
    } else if (projectKind(kbRoot, project.id, cache) === 'code-project') {
      // 空表不该静默：模型会以为项目页没东西可查，然后重复搜一遍
      lines.push('  概念表未填：项目页「中文概念 → 位置」为空，定位请现读源码')
    }
  } else if (cwd !== undefined) {
    lines.push('当前目录未入库（不在 paths.yaml）。写任何项目知识前先跑 kb-add-project.py 建档；只检索则按关键词，别猜项目。')
  }

  const docs = globalDocs(kbRoot)
  if (docs.dirs.length > 0 || docs.files.length > 0) {
    const parts = []
    if (docs.dirs.length > 0) parts.push(docs.dirs.join('、'))
    if (docs.files.length > 0) parts.push('单篇：' + docs.files.join('、'))
    lines.push('文档 docs/：' + parts.join('；'))
  }
  // 不写本机路径：占位符由技能自己声明，换机器 / 换安装位置都成立。
  if (kbSearchPath() !== null) {
    lines.push('检索：用技能 local-kb 的 tools/kb-search.py "关键词"（带置信分级，弱结果会告警，别当答案）')
  }
  return lines.join('\n')
}
