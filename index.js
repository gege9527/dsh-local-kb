/**
 * dsh-local-kb — 知识库插件 Host 半。
 *
 * 三件事（技能文件本身一字不改，全部旁路增强）：
 *   1. 安装 local-kb 技能副本到 $DSH_HOME/skills/local-kb/，并把 KB_LOCAL 常驻块写入
 *      $DSH_HOME/AGENTS.md（install-skill.js，幂等；源技能目录永不触碰）。
 *   2. hook 机制（技能做不到的部分）：tools/result 事件精确监听「模型对 KB_ROOT 的
 *      写入工具调用」，成功才触发一次异步 WebDAV 同步 —— 不是文件监听、不轮询，
 *      与技能的「写入才同步」语义一致；同步失败绝不返回给工具调用链（fire-and-forget），
 *      只把失败记录到同步状态里，设置页拉取后红色提示并显示失败时间。
 *   3. 为设置页提供 HTTP API：KB 状态 / 立即同步 / 测试链接。WebDAV 凭据存 DSH
 *      credentials 服务（$DSH_HOME/.credentials.yaml，0600），与官方 API Key 同一通道；
 *      打开文件夹 / VSCode 由 Client 复用 ctx.remote.session.openWorkspacePath。
 *
 * 零依赖、无构建：纯 ESM、node: builtins（node:https 发 WebDAV 请求）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants as FS, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import http from 'node:http'
import https from 'node:https'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installSkill, SKILL_NAME } from './install-skill.js'
import {
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
  knowledgeMapText,
  memoryIndexText,
  parsePathsYaml,
} from './inject.js'

// 任务内提醒的消息工厂：优先用 DSH 官方 createUserMessage；解析失败（测试/非 DSH 环境）
// 静默降级为手工构造同构对象（零硬依赖，防插件加载失败）。promise 模块级缓存，只发一次。
const reminderFactory = import('@deepseek-ai/dsh-llm').then((m) => m.createUserMessage, () => null)

export const name = 'local-kb'

// `tools` 是唯一硬依赖：写入钩子必须能确权。skills/credentials/connection 都是可选服务，
// 用 ctx.inject 懒取，缺了也不阻塞启动。
export const inject = ['tools']

export const CRED_URL_REF = 'dsh_local_kb_webdav_url'
export const CRED_USER_REF = 'dsh_local_kb_webdav_user'
export const CRED_PASSWORD_REF = 'dsh_local_kb_webdav_password'

export const API_BASE = '/api/local-kb'
export const SYNC_STATE_FILENAME = '.kb-sync-state.json'
/** 远端子目录：所有同步内容放在 WebDAV 根下的这一个文件夹，避免污染远端根。 */
export const REMOTE_SYNC_DIR = 'local-kb-sync'
export const SYNC_STATE_DEFAULT = {
  lastSyncAt: null,      // ISO 时间
  lastSyncStatus: null,  // 'ok' | 'failed' | null
  lastError: null,       // 可读错误
  lastTrigger: null,     // 'auto' | 'manual' | 'test' | null
  syncedFiles: 0,
  deletedFiles: 0,     // 本次远端镜像删掉的文件数
  failedDeletes: 0,    // 本次删除失败数（下次镜像自然重试）
  lastCheckAt: null,     // kb-check.py 最近一次运行时间（技能铁律：写入后必校验）
  lastCheckStatus: null, // 'ok' | 'warn' | 'failed' | null
  lastCheckError: null, // 首条错误（设置页横幅用）
  lastCheckErrors: [],  // 前 5 条错误
  lastCheckWarns: [],   // 前 5 条警告
  lastCheckStats: null, // { memoryDirs, memories, docs, errors, warns }
}

/** Sync 目录的写工具名（write 是整体替换；edit/str_replace/insert 是就地修改）。 */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace', 'insert'])

function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** KB 根：与 local-kb 技能同一规则 —— KB_ROOT 环境变量优先，否则 ~/.local-kb。 */
export function resolveKbRoot(env = process.env) {
  const fromEnv = env.KB_ROOT
  const root = typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.local-kb')
  return resolve(root)
}

/**
 * 路径的真实位置：自身存在就解析自身；不存在（写入新文件）就解析父目录再拼回文件名。
 * 解析失败保持原样 —— 调用方拿到的是「尽力而为」的绝对路径，不是猜测。
 */
function realpathLoose(p) {
  try {
    return realpathSync(p)
  } catch {
    // 目标还不存在：解析父目录，避免符号链接把写入指向别处
  }
  // 逐级向上找第一个存在的祖先，解析它，再把没有创建的尾巴拼回去。
  const tail = []
  let dir = p
  while (true) {
    tail.unshift(basename(dir))
    const parent = dirname(dir)
    if (parent === dir) return p
    try {
      return join(realpathSync(parent), ...tail)
    } catch {
      dir = parent
    }
  }
}

/**
 * 把路径归到知识库的语义分类。所有需要「这是不是 KB 内文件」「这是哪一种文件」的
 * 判定都走这里，避免三处各写一套字符串比较（软链、~、相对路径的坑各不相同）。
 *
 * kind: outside | unknown | root | state | memory-index | memory-note |
 *       project-page | project-doc | doc | other
 */
export function classifyPath(root, target) {
  if (typeof root !== 'string' || root === '' || typeof target !== 'string' || target.trim() === '') {
    return { kind: 'unknown', rel: null, path: null }
  }
  const base = realpathLoose(resolve(root))
  const real = realpathLoose(resolve(target))
  const rel = relative(base, real)
  if (rel === '') return { kind: 'root', rel: '', path: real }
  const parts = rel.split(sep)
  if (parts[0] === '..' || isAbsolute(rel)) return { kind: 'outside', rel: null, path: real }

  // Windows 上路径大小写不敏感：分类按折叠后的段名，rel 保留原样。
  const cmp = process.platform === 'win32' ? parts.map((p) => p.toLowerCase()) : parts
  const posix = parts.join('/')
  const isIndex = (i) => cmp.length === i + 1 && cmp[i].toLowerCase() === 'memory.md'

  if (posix === SYNC_STATE_FILENAME) return { kind: 'state', rel: posix, path: real }
  if (cmp[0] === 'memory' && cmp.length >= 2) {
    return { kind: isIndex(1) ? 'memory-index' : 'memory-note', rel: posix, path: real }
  }
  if (cmp[0] === 'projects' && cmp.length >= 3) {
    if (cmp[2] === 'memory') {
      return { kind: isIndex(3) ? 'memory-index' : 'memory-note', rel: posix, path: real }
    }
    if (cmp.length === 3 && cmp[2] === cmp[1] + '.md') {
      return { kind: 'project-page', rel: posix, path: real }
    }
    if (cmp[2] === 'docs' && cmp.length >= 4) return { kind: 'project-doc', rel: posix, path: real }
    return { kind: 'other', rel: posix, path: real }
  }
  if (cmp[0] === 'docs' && cmp.length >= 2) return { kind: 'doc', rel: posix, path: real }
  return { kind: 'other', rel: posix, path: real }
}

/** 判断 path 是否在 root 内（经 classifyPath：解析符号链接后的真实位置）。 */
export function isInside(root, path) {
  const { kind } = classifyPath(root, path)
  return kind !== 'outside' && kind !== 'unknown'
}

/** 展开命令里的 ~ 与 $HOME（只做这两种，别的变量不猜）。 */
export function expandHome(raw, home = homedir()) {
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return raw.replace(/^\$\{?HOME\}?(?=\/|$)/, home)
}

/** 命令里出现的绝对路径 / ~ 路径 / $HOME 路径。 */
export function commandPathTokens(command) {
  return command.match(/(?<![A-Za-z0-9_.\-])(?:~|\$\{?HOME\}?|\/)[^\s\x22'\x60|&;<>()]*/g) || []
}

/**
 * 写动作：重定向，或会改动文件的命令。
 * 只看命令名，不解析参数 —— 判不出具体目标时宁可多同步一次（幂等），不要漏。
 */
const BASH_WRITE_PATTERN =
  /(?<![<])>{1,2}(?![&|])|\b(?:tee|cp|mv|install|rsync|touch|mkdir|rmdir|rm|truncate|dd|ln|unlink|shred)\b|\bsed\s+-i|\bperl\s+-[a-z]*i/

/**
 * bash 命令是否会改动 KB 内文件。
 *
 * 旧实现用 command.includes(kbRoot)：~/.local-kb、$HOME/.local-kb、cd 后的相对路径
 * 全漏，而 ls ~/.local-kb 这类只读命令又白白触发一次同步。现在先要求有写动作，
 * 再按 classifyPath 判路径（软链按真实位置）。
 */
export function bashWritesKb(kbRoot, args) {
  const cmd = typeof args?.command === 'string' ? args.command : ''
  if (cmd === '' || cmd.length > 8192) return false
  if (!BASH_WRITE_PATTERN.test(cmd)) return false
  for (const raw of commandPathTokens(cmd)) {
    const { kind } = classifyPath(kbRoot, expandHome(raw))
    if (kind !== 'outside' && kind !== 'unknown') return true
  }
  const workdir = typeof args?.workdir === 'string' ? args.workdir.trim() : ''
  if (workdir !== '') {
    const { kind } = classifyPath(kbRoot, expandHome(workdir))
    if (kind !== 'outside' && kind !== 'unknown') return true
  }
  // 变量拼出来的路径判不出（如 $KB/memory）：退回到文本包含，保持旧行为的下限
  return cmd.includes(kbRoot)
}

/* =========================================================================
 * 记忆索引上限：确定性拒绝（不是提醒）
 * -------------------------------------------------------------------------
 * 与 skill/tools/kb-check.py 同一组数字：软 150 行/20KB 只警告，硬 200 行/25KB 拒绝。
 * 只拒绝「越界且比现在变大」的写入 —— 压缩（213 → 205 → 198）一路放行，
 * 否则索引一旦超限就再也改不动。
 * ======================================================================= */
export const INDEX_HARD_LINES = 200
export const INDEX_HARD_BYTES = 25 * 1024
/** guard 在主线程同步跑：索引再大也只读这么多，超过就只按字节比较。 */
const INDEX_READ_LIMIT = 1024 * 1024

const indexLines = (text) => text.split('\n').length
const indexBytes = (text) => Buffer.byteLength(text, 'utf8')

/** 读当前索引；不存在返回空，非常规文件或过大返回只带字节的占位。 */
function readIndexForGuard(file) {
  try {
    const st = statSync(file)
    if (!st.isFile()) return { unreadable: true, lines: undefined, bytes: 0, text: '' }
    if (st.size > INDEX_READ_LIMIT) return { tooBig: true, lines: undefined, bytes: st.size, text: '' }
    const text = readFileSync(file, 'utf8')
    return { lines: indexLines(text), bytes: indexBytes(text), text }
  } catch {
    return { lines: 0, bytes: 0, text: '' } // 还没创建
  }
}

/**
 * 按会写入后的样子算出索引文本；算不出（参数不认识、匹配不到）返回 undefined = 放行。
 * 只认会改动索引的工具：write / edit / str_replace_editor 的 create、str_replace、insert。
 */
function predictIndexText(tool, args, current) {
  const base = current.text ?? ''
  const lf = (s) => String(s).replace(/\r\n/g, '\n')
  if (tool === 'write' && typeof args.content === 'string') return args.content
  if (tool === 'str_replace_editor' && args.command === 'create' && typeof args.file_text === 'string') {
    return args.file_text
  }
  const oldStr = typeof args.old_string === 'string' ? args.old_string
    : typeof args.old_str === 'string' ? args.old_str : undefined
  const newStr = typeof args.new_string === 'string' ? args.new_string
    : typeof args.new_str === 'string' ? args.new_str : undefined
  if ((tool === 'edit' || tool === 'str_replace' || tool === 'str_replace_editor') && oldStr !== undefined && newStr !== undefined) {
    const text = lf(base)
    const needle = lf(oldStr)
    if (needle === '' || !text.includes(needle)) return undefined
    const replacement = lf(newStr)
    return args.replace_all === true
      ? text.split(needle).join(replacement)
      : text.replace(needle, () => replacement)
  }
  if (tool === 'str_replace_editor' && args.command === 'insert' && typeof args.new_str === 'string') {
    const line = Number.isInteger(args.insert_line) ? args.insert_line : undefined
    if (line === undefined) return undefined
    const lines = lf(base).split('\n')
    const at = Math.max(0, Math.min(line, lines.length))
    return [...lines.slice(0, at), ...lf(args.new_str).split('\n'), ...lines.slice(at)].join('\n')
  }
  return undefined
}

/** 判定一次索引写入；返回拒绝理由，undefined = 放行。 */
export function judgeIndexWrite(kbRoot, tool, args) {
  if (!args || typeof args !== 'object') return undefined
  const target = typeof args.file_path === 'string' ? args.file_path
    : typeof args.path === 'string' ? args.path : undefined
  if (target === undefined) return undefined
  const cls = classifyPath(kbRoot, expandHome(target))
  if (cls.kind !== 'memory-index') return undefined

  const current = readIndexForGuard(cls.path)
  const nextText = predictIndexText(tool, args, current)
  if (nextText === undefined) return undefined

  const lines = indexLines(nextText)
  const bytes = indexBytes(nextText)
  // 行数或字节各自独立判：只拦住「既越界又在变大」的那一项。
  const grewLines = current.lines === undefined ? false : lines > current.lines
  const grewBytes = bytes > current.bytes
  const overLines = current.lines !== undefined && lines > INDEX_HARD_LINES && grewLines
  const overBytes = bytes > INDEX_HARD_BYTES && grewBytes
  if (!overLines && !overBytes) return undefined

  const over = overLines ? `${lines} 行（上限 ${INDEX_HARD_LINES}）` : `${bytes} B（上限 ${INDEX_HARD_BYTES}）`
  return `记忆索引 ${cls.rel} 写完后是 ${over}，超过硬上限。先把已有条目压缩或归档再追加；` +
    `压缩（让索引变短）的写入一律放行。`
}

/** 注册 guard：Context 的 tools.guard 是同步、单调的拒绝，后续监听无法翻回放行。 */
export function indexCapGuard(kbRoot) {
  return (exec) => {
    try {
      return judgeIndexWrite(kbRoot, exec?.name, exec?.arguments)
    } catch {
      return undefined // 判不动就放行：宁可漏，不可误拒
    }
  }
}

/* =========================================================================
 * 禁止 AI 删除知识库内容
 * -------------------------------------------------------------------------
 * 规则：删除只由用户做。AI 只能「归档」——把笔记移进同目录的 archive/。
 * 这里拦的是 AI 通过 bash 删除：rm / unlink / shred / truncate / find -delete，
 * 以及把文件移出 KB（mv 出界等价于删除）。KB 内部的 mv（进 archive/）放行。
 * ======================================================================= */
const BASH_DELETE_PATTERN = /\b(?:rm|rmdir|unlink|shred|truncate)\b|(?:^|\s)-delete\b/

const deleteRefusal = (rel) => `知识库内容只归档不删除：${rel} 不能删。` +
  `把笔记移到同目录的 archive/（例：memory/archive/2026-11-02-<slug>.md）再改索引；` +
 `物理删除只能由用户在文件管理器里做。`

/** 判定一次删除类操作；返回拒绝理由，undefined = 放行。 */
export function judgeKbDelete(kbRoot, tool, args) {
  if (tool !== 'bash' || typeof args?.command !== 'string') return undefined
  const cmd = args.command
  if (cmd === '' || cmd.length > 8192) return undefined
  if (!BASH_DELETE_PATTERN.test(cmd) && !/\bmv\b/.test(cmd)) return undefined

  const inKb = (p) => {
    const { kind } = classifyPath(kbRoot, p)
    return kind !== 'outside' && kind !== 'unknown'
  }
  const workdir = typeof args?.workdir === 'string' ? args.workdir.trim() : ''
  const workdirHit = workdir !== '' && inKb(expandHome(workdir))

  // 复合命令按 && || ; 换行 分段，逐段判：只有「这一段在删 KB」才拦。
  // 否则 `find /x -delete && python3 kb-check.py <KB>` 会被整条误杀。
  for (const segment of cmd.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean)) {
    const segDelete = BASH_DELETE_PATTERN.test(segment)
    const tokens = commandPathTokens(segment).map((t) => expandHome(t))
    const hit = tokens.filter(inKb)

    if (segDelete) {
      if (hit.length > 0) return deleteRefusal(classifyPath(kbRoot, hit[0]).rel ?? hit[0])
      if (workdirHit) return deleteRefusal(classifyPath(kbRoot, expandHome(workdir)).rel ?? workdir)
      // 一个路径都没解析出来时，才退回文本包含（变量路径兜底）
      if (tokens.length === 0 && segment.includes(kbRoot)) return deleteRefusal(kbRoot)
      continue
    }

    // 纯 mv：源在 KB、目标不在 KB = 移出知识库；KB 内部移动（进 archive/）放行
    if (/\bmv\b/.test(segment) && tokens.length >= 2) {
      const from = tokens[0]
      const to = tokens[tokens.length - 1]
      if (inKb(from) && !inKb(to)) return deleteRefusal(classifyPath(kbRoot, from).rel ?? from)
    }
  }
  return undefined
}

/** 组合 guard：删除判定在前，索引上限在后（indexCap:false 可单独关上限）。 */
export function kbGuard(kbRoot, { indexCap = true } = {}) {
  return (exec) => {
    try {
      const remove = judgeKbDelete(kbRoot, exec?.name, exec?.arguments)
      if (remove !== undefined) return remove
      return indexCap ? judgeIndexWrite(kbRoot, exec?.name, exec?.arguments) : undefined
    } catch {
      return undefined // 判不动就放行：宁可漏，不可误拒
    }
  }
}

/* =========================================================================
 * 同步状态（内存单例 + 磁盘备份，设置页可查）
 * ======================================================================= */
/** 分片键：按一级目录切，projects 再按项目 id 切。 */
function shardOf(rel) {
  const parts = rel.split('/')
  if (parts.length === 1) return '_root'
  if (parts[0] === 'projects' && parts.length > 1) return 'projects__' + parts[1]
  return parts[0]
}

/**
 * 同步状态：meta（时间/结果）一个文件，fileMap 按目录分片。
 *
 * 旧版把 771 条基准塞进一个 106KB 的 JSON，每次同步整份重写。分片后改一个文件
 * 只写它所在的那一片。旧文件只读迁移、不删除（删除只由用户做）。
 */
class SyncState {
  constructor(kbRoot, dshHome) {
    this.kbRoot = kbRoot
    this.state = { ...SYNC_STATE_DEFAULT }
    this.legacyFile = join(kbRoot, SYNC_STATE_FILENAME)
    this.dir = join(dshHome, 'local-kb', 'state', hashOf(kbRoot))
    this.metaFile = join(this.dir, 'meta.json')
    this.map = new Map()
    this.shardCache = new Map()
    this.ready = this.load()
  }

  async load() {
    try {
      this.state = { ...SYNC_STATE_DEFAULT, ...JSON.parse(await readFile(this.metaFile, 'utf8')) }
    } catch {
      // 还没同步过
    }
    try {
      const files = await listJsonFiles(this.dir)
      for (const file of files) {
        if (file.endsWith('meta.json')) continue
        const obj = JSON.parse(await readFile(file, 'utf8'))
        const shard = basename(file, '.json')
        this.shardCache.set(shard, JSON.stringify(obj))
        for (const [rel, info] of Object.entries(obj)) this.map.set(rel, info)
      }
    } catch {
      // 分片目录还不存在
    }
    // 旧版单文件：只读迁移，文件本身保留
    if (this.map.size === 0) {
      try {
        const legacy = JSON.parse(await readFile(this.legacyFile, 'utf8'))
        for (const [rel, info] of Object.entries(legacy.fileMap || {})) this.map.set(rel, info)
      } catch {
        // 没有旧状态
      }
    }
  }

  snapshot() {
    return { ...this.state }
  }

  fileMapObject() {
    return Object.fromEntries(this.map)
  }

  async record(patch) {
    this.state = { ...this.state, ...patch }
    try {
      await mkdir(this.dir, { recursive: true })
      const tmp = this.metaFile + '.tmp'
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      await rename(tmp, this.metaFile)
    } catch {
      // 状态写盘失败不影响功能 —— 下次有 sync 再试
    }
  }

  /** 只写变化的分片；消失的分片写空对象（不删文件）。 */
  async saveFileMap(map) {
    const grouped = new Map()
    for (const [rel, info] of map) {
      const shard = shardOf(rel)
      if (!grouped.has(shard)) grouped.set(shard, {})
      grouped.get(shard)[rel] = info
    }
    try {
      await mkdir(this.dir, { recursive: true })
    } catch {
      return
    }
    for (const [shard, obj] of grouped) {
      const text = JSON.stringify(obj)
      if (this.shardCache.get(shard) === text) continue
      try {
        await writeFile(join(this.dir, shard + '.json'), text, 'utf8')
        this.shardCache.set(shard, text)
      } catch {
        // 单个分片写失败：下次再写
      }
    }
    for (const [shard, text] of this.shardCache) {
      if (grouped.has(shard) || text === '{}') continue
      try {
        await writeFile(join(this.dir, shard + '.json'), '{}', 'utf8')
        this.shardCache.set(shard, '{}')
      } catch {
        // 同上
      }
    }
    this.map = new Map(map)
  }
}

/** 状态目录按 KB 路径区分：一台机器可能有多个 KB_ROOT。 */
function hashOf(text) {
  return createHash('sha256').update(resolve(text)).digest('hex').slice(0, 16)
}

/** 递归列出目录下的 *.json；目录不存在返回空。 */
async function listJsonFiles(dir) {
  const out = []
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full)
    }
  }
  await walk(dir)
  return out
}

/* =========================================================================
 * WebDAV 最小客户端（RFC 4918：只依赖 MKCOL / PUT / PROPFIND）
 * ======================================================================= */
function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(`${user}:${password}`, 'utf8').toString('base64')
}

function joinUrl(base, rel) {
  const normBase = base.endsWith('/') ? base : base + '/'
  return normBase + rel.split(sep).map(encodeURIComponent).join('/')
}

/**
 * 发一个 WebDAV/HTTP 请求。返回 { status, headers, body }。
 * 用 settled 标志保证 timeout 与 error 不会双重结算。
 */
function webdavRequest(url, { method, headers = {}, body, timeoutMs = 20000, auth }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (error) {
      rejectPromise(new Error(`无效的 WebDAV 地址: ${error.message}`))
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      rejectPromise(new Error('WebDAV 地址只支持 http/https'))
      return
    }
    const lib = parsed.protocol === 'https:' ? https : http
    let settled = false
    const req = lib.request(parsed, {
      method,
      headers: {
        ...(auth ? { Authorization: auth } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      // 响应流中途断开（服务器半开连接/代理超时）也必须结算，否则 promise
      // 永不 settle -> syncChain 挂起 -> 插件所有后续同步全部卡死。
      res.on('error', (error) => {
        if (settled) return
        settled = true
        rejectPromise(new Error(`读取 WebDAV 响应失败: ${error.message}`))
      })
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        if (settled) return
        settled = true
        resolvePromise({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectPromise(new Error(`连接 WebDAV 失败: ${error.message}`))
    })
    req.setTimeout(timeoutMs, () => {
      if (settled) return
      settled = true
      req.destroy()
      rejectPromise(new Error(`WebDAV 请求超时（${timeoutMs}ms）`))
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 确保远端目录链存在：逐级 MKCOL；409/405（已存在）视为成功。 */
const _confirmedDirs = new Set() // 本次同步内已确认存在的远端目录
const _dirInFlight = new Map()    // 进行中的 MKCOL（并发同目录合并，只发一次）

/** 限流并发映射：同批最多 limit 个 worker 并行，结果按输入顺序返回。
 *  worker 抛错被统一收集：并发 run 只有一个 Promise.all 捕获点，若 worker 在多个
 *  run 里同时抛，多余 rejection 会变 unhandledRejection —— 这里内部 catch 全部收集。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  const errors = []
  let next = 0
  async function run() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try {
        results[i] = await worker(items[i], i)
      } catch (error) {
        errors.push(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  if (errors.length > 0) throw errors[0]
  return results
}

async function ensureRemoteDirChain(base, relDir, auth) {
  if (!relDir) return
  const parts = relDir.split('/').filter(Boolean)
  let current = base
  for (const part of parts) {
    current = current.replace(/\/+$/, '') + '/' + encodeURIComponent(part)
    if (_confirmedDirs.has(current)) continue // 已确认，跳过
    let inflight = _dirInFlight.get(current)
    if (inflight === undefined) {
      inflight = (async () => {
        const res = await webdavRequest(current, { method: 'MKCOL', auth })
        if (res.status === 409 || res.status === 405 || (res.status >= 200 && res.status < 300)) {
          _confirmedDirs.add(current) // 存在或已创建，后续直接复用
        } else {
          throw new Error(`创建远端目录 ${relDir} 失败（HTTP ${res.status}）`)
        }
      })()
      // 结束即移除 in-flight；失败由 await 它的 worker 传播（mapLimit 收集）
      inflight.finally(() => _dirInFlight.delete(current)).catch(() => {})
      _dirInFlight.set(current, inflight)
    }
    await inflight // 并发到达的 worker 复用一个 MKCOL
  }
}

/**
 * 本地 KB → 远端 WebDAV 的增量同步：
 *  - 扫描 KB_ROOT 下所有文件；
 *  - 对比上次基准清单（fileMap: 相对路径 → {mtimeMs,size}），只 PUT 新增/变化的文件；
 *  - 目录用 MKCOL 逐级保证存在；
 *  - 成功后把本次清单写回状态文件（作为下次基准）。
 */
export async function syncRoot({ kbRoot, url, user, password, previousMap }) {
  const rootBase = url.replace(/\/+$/, '')
  const base = rootBase + '/' + REMOTE_SYNC_DIR
  const auth = basicAuth(user, password)
  _confirmedDirs.clear()
  _dirInFlight.clear() // 每次全新同步，目录确认缓存只作用于本次
  // 确保远端根子目录 local-kb-sync 存在（幂等 MKCOL），所有内容放其下隔离。
  {
    const res = await webdavRequest(base, { method: 'MKCOL', auth })
    if (!(res.status === 409 || res.status === 405 || (res.status >= 200 && res.status < 300))) {
      throw new Error(`创建远端同步目录 ${REMOTE_SYNC_DIR} 失败（HTTP ${res.status}）`)
    }
    _confirmedDirs.add(base)
  }

  const files = await listFiles(kbRoot) // 相对路径，垃圾文件已排除
  const previous = new Map(Object.entries(previousMap || {}))
  const now = new Map()
  const pushed = []

  // 阶段一：扫描对比（无 I/O 网络），找出需要上传的文件
  const pending = []
  for (const rel of files) {
    const abs = join(kbRoot, rel)
    let info
    try {
      info = await stat(abs)
    } catch {
      continue // 并发删除的文件就跳过
    }
    const key = { mtimeMs: info.mtimeMs, size: info.size }
    const prev = previous.get(rel)
    if (prev !== undefined && prev.mtimeMs === key.mtimeMs && prev.size === key.size) {
      now.set(rel, key) // 无变化，直接沿用
      continue
    }
    pending.push({ abs, rel, key })
  }

  // 阶段二：限流并发上传（4 路）。目录 in-flight 合并 + MKCOL 幂等保证并发安全。
  await mapLimit(pending, 4, async ({ abs, rel, key }) => {
    const data = await readFile(abs)
    const relDir = dirname(rel) === '.' ? '' : dirname(rel)
    if (relDir) await ensureRemoteDirChain(base, relDir, auth)
    const res = await webdavRequest(joinUrl(base, rel), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
      },
      body: data,
      timeoutMs: 30000,
      auth,
    })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`PUT ${rel} 失败（HTTP ${res.status}）`)
    }
    pushed.push(rel)
    now.set(rel, key)
  })

  // 阶段三：远端镜像 —— 远端有、本地没有的一律删除（本地什么样，远端什么样）。
  const remote = await listRemote({ base, auth })
  const local = new Set(now.keys())
  const stale = [...remote].filter((rel) => !local.has(rel))
  const deleted = []
  const failedDeletes = []
  await mapLimit(stale, 4, async (rel) => {
    try {
      await deleteRemote(base, rel, auth)
      deleted.push(rel)
    } catch (error) {
      failedDeletes.push({ rel, reason: error instanceof Error ? error.message : String(error) })
    }
  })

  return { pushed, deleted, failedDeletes, total: files.length, fileMap: Object.fromEntries(now) }
}

/**
 * 从远端下载并覆盖本地同名文件（下载方向的镜像）。
 *
 * 只覆盖，不删除：本地多出来的文件保留 —— 删除本地内容只能由用户做。
 * 远端路径一律校验落在 kbRoot 内，防止 ../ 或异常 href 写到知识库外面。
 */
export async function downloadRoot({ kbRoot, url, user, password }) {
  const base = url.replace(/\/+$/, '') + '/' + REMOTE_SYNC_DIR
  const auth = basicAuth(user, password)
  const root = resolve(kbRoot)
  const files = await listRemote({ base, auth })
  const written = []
  const failed = []

  await mapLimit([...files], 4, async (rel) => {
    try {
      const res = await webdavRequest(joinUrl(base, rel), { method: 'GET', timeoutMs: 30000, auth })
      if (res.status < 200 || res.status >= 300) {
        failed.push({ rel, reason: 'HTTP ' + res.status })
        return
      }
      const target = resolve(join(root, rel))
      if (target !== root && !target.startsWith(root + sep)) {
        failed.push({ rel, reason: '路径越界' })
        return
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, res.body)
      written.push(rel)
    } catch (error) {
      failed.push({ rel, reason: error instanceof Error ? error.message : String(error) })
    }
  })

  return { written, failed, total: files.size }
}


/**
 * 同步排除清单：系统垃圾与插件自身状态。
 * 排除项视同「本地不存在」——远端若有同名文件，镜像阶段会删掉，否则远端永远脏。
 */
const SYNC_EXCLUDE = [
  /\.DS_Store$/i,
  /(^|\/)\._/,
  /\.tmp$/i,
  /(^|\/)Thumbs\.db$/i,
  /(^|\/)\.kb-sync-state\.json$/,
]
const isSyncExcluded = (rel) => SYNC_EXCLUDE.some((re) => re.test(rel))

/** 递归列出 KB_ROOT 下所有文件，返回相对路径（忽略目录、符号链接与排除项）。 */
async function listFiles(root) {
  const out = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join('/')
        if (!isSyncExcluded(rel)) out.push(rel)
      }
    }
  }
  await walk(root)
  return out
}

const PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>'

/** 解析 multistatus：只取 href 与「是不是目录」。命名空间前缀不固定，正则按任意前缀。 */
function parseMultistatus(text) {
  const out = []
  const blocks = String(text).split(/<[a-zA-Z0-9]+:response[\s>]/i).slice(1)
  for (const block of blocks) {
    const href = (block.match(/<[a-zA-Z0-9]+:href[^>]*>([^<]+)</i) || [])[1]
    if (href === undefined) continue
    out.push({ href, dir: /<[a-zA-Z0-9]+:collection[\s>/]/i.test(block) })
  }
  return out
}

/** href → 相对 base 的路径；跨出 base 或含 .. 的一律丢弃。 */
function remoteRel(href, prefix) {
  let path
  try {
    path = decodeURIComponent(href)
  } catch {
    path = href
  }
  if (!path.startsWith(prefix)) return undefined
  const rel = path.slice(prefix.length).replace(/\/+$/, '')
  if (rel === '') return undefined
  if (rel.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined
  return rel
}

/**
 * 递归列出远端镜像目录下的全部文件（只读）。
 * 用 Depth:1 逐层走：不少 WebDAV 实现禁用 Depth:infinity。
 */
export async function listRemote({ base, auth, concurrency = 6, maxRequests = 2000 }) {
  const prefix = new URL(base).pathname.replace(/\/+$/, '') + '/'
  const files = new Set()
  const visited = new Set([''])
  let queue = [base]
  let requests = 0

  while (queue.length > 0 && requests < maxRequests) {
    const batch = queue.splice(0, concurrency)
    requests += batch.length
    const responses = await Promise.all(batch.map((dir) => webdavRequest(dir, {
      method: 'PROPFIND',
      headers: { Depth: '1', 'Content-Type': 'application/xml', 'Content-Length': String(PROPFIND_BODY.length) },
      body: PROPFIND_BODY,
      timeoutMs: 15000,
      auth,
    })))
    for (let i = 0; i < responses.length; i++) {
      const response = responses[i]
      if (response.status !== 207) {
        throw new Error(`列远端目录失败（HTTP ${response.status}）: ${batch[i]}`)
      }
      const body = response.body.toString('utf8')
      for (const item of parseMultistatus(body)) {
        const rel = remoteRel(item.href, prefix)
        if (rel === undefined) continue
        if (item.dir) {
          if (visited.has(rel)) continue
          visited.add(rel)
          queue.push(base + '/' + rel.split('/').map(encodeURIComponent).join('/'))
        } else {
          files.add(rel)
        }
      }
    }
  }
  return files
}

/** 删除远端单个文件；404 视为已经不在（成功）。 */
async function deleteRemote(base, rel, auth) {
  const res = await webdavRequest(joinUrl(base, rel), { method: 'DELETE', timeoutMs: 15000, auth })
  if (res.status === 404) return
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`DELETE ${rel} 失败（HTTP ${res.status}）`)
  }
}

/** 测试 WebDAV 配置：PROPFIND depth:0；2xx 可达；401 认证失败；其它 4xx/5xx 路径/权限问题。 */
export async function testLink({ url, user, password }) {
  if (!url) return { ok: false, reason: '未配置 WebDAV 链接' }
  const auth = basicAuth(user, password)
  try {
    // 探测 WebDAV 根目录本身：local-kb-sync 子目录首次同步前不存在，
    // 探子目录会把「可用但未同步」误判为 404。根可达即链接有效。
    const res = await webdavRequest(url.replace(/\/+$/, ''), {
      method: 'PROPFIND',
      headers: { Depth: '0' },
      timeoutMs: 15000,
      auth,
    })
    if (res.status === 401) return { ok: false, reason: '认证失败：用户名或密码不正确' }
    if (res.status >= 200 && res.status < 300) return { ok: true, reason: '连接成功' }
    return { ok: false, reason: `服务器返回 HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, reason: error.message }
  }
}

/* =========================================================================
 * Plugin
 * ======================================================================= */

export function apply(ctx, config = {}) {
  const kbRoot = typeof config.kbRoot === 'string' && config.kbRoot.trim()
    ? resolve(config.kbRoot.trim())
    : resolveKbRoot()
  const dshHome = resolveDshHome()

  // ---- 技能安装：副本 + AGENTS.md 常驻块（幂等，fire-and-forget，绝不阻断启动） ----
  if (config.installSkill !== false) {
    void installSkill({ dshHome, appendRules: config.appendRules })
  }

  // ---- 运行时技能注册：安全网，保证技能条目在 catalog 中（同 checkpoint-memory 模式） ----
  if (config.registerSkill !== false) {
    ctx.inject(['skills'], (inner) => {
      const skillBody = readSkillBody()
      inner.effect(() => inner.skills.register({
        name: SKILL_NAME,
        description:
          '独立知识库。把代码项目与本地文档存入纯 Markdown 文件知识库（' + kbRoot + '），' +
          '供 AI 检索定位与长期记忆，纯本地文件。触发词：存进知识库、加入知识库、' +
          '保存这个文档、保存这个项目、查某功能在哪个代码位置、知识库里有什么、记住、别忘了。' +
          '写入 ' + kbRoot + ' 会由插件自动 WebDAV 同步。',
        whenToUse:
          '知识库查询/写入/记忆的任何请求：找东西、存文档、记住事实时先查知识库；' +
          '任何写入 ' + kbRoot + ' 的读写任务。',
        source: 'runtime',
        // 技能副本读不到（安装失败/被删）时退回内置摘要，绝不让技能条目退回 null。
        content: skillBody ?? builtinSkill(kbRoot),
      }))
    })
  }

  // ---- 记忆索引硬上限：ctx.tools.guard（同步、单调拒绝） ----
  // 200 行 / 25KB 之前只写在 AGENTS.md 和 kb-check.py 里，模型写超了也能落盘。
  // guard 在写入前同步判定，只拦「越界且变大」，压缩写入照常放行。
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard(kbGuard(kbRoot, { indexCap: config.indexCap !== false }))
  }

  // ---- 每轮注入：记忆索引 + 知识地图（systemPrompt.context） ----
  // 记忆是召回型：模型必须每轮知道记过什么，靠它自己 read 会被跳过。
  // 知识是检索型：只注入「有哪些项目 / 当前项目是谁 / 去哪 grep」，正文永远不进上下文。
  // dsh 每个 step 同步调用 text()，inject.js 里全是同步 IO + mtime 缓存。
  let workingDirectory
  ctx.inject(['workingDirectory'], (inner) => {
    inner.effect(() => {
      const service = inner.workingDirectory
      workingDirectory = service
      return () => {
        if (workingDirectory === service) workingDirectory = undefined
      }
    })
  })
  const sessionCwd = (context) => {
    try {
      const dir = workingDirectory?.get(context?.agent?.session)
      return typeof dir === 'string' && isAbsolute(dir) ? dir : undefined
    } catch {
      return undefined // 没有 workingDirectory 服务的 dsh 版本
    }
  }
  const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback)
  if (config.injectContext !== false) {
    const cache = new Map()
    const maxLines = positiveInt(config.injectMaxLines, DEFAULT_INDEX_MAX_LINES)
    const maxBytes = positiveInt(config.injectMaxBytes, DEFAULT_INDEX_MAX_BYTES)
    ctx.inject(['systemPrompt'], (inner) => {
      const prompt = inner.systemPrompt
      if (typeof prompt?.context !== 'function') return
      // 索引按原文引用，不参与 {{}} 插值：笔记标题里出现花括号会让整个请求失败。
      inner.effect(() => prompt.context({
        name: 'local-kb:memory',
        order: 300,
        interpolate: false,
        text: (context) => {
          try {
            return memoryIndexText({ kbRoot, cwd: sessionCwd(context), cache, maxLines, maxBytes })
          } catch {
            return '' // 注入失败绝不拖垮请求
          }
        },
      }))
      inner.effect(() => prompt.context({
        name: 'local-kb:map',
        order: 301,
        interpolate: false,
        text: (context) => {
          try {
            return knowledgeMapText({ kbRoot, cwd: sessionCwd(context), cache })
          } catch {
            return ''
          }
        },
      }))
    })
  }

  // ---- 长对话提醒：把值得留的先写进 KB（每会话一次） ----
  if (config.compactionReminder !== false) {
    const pressure = {}
    for (const name of ['tokenMeter', 'sessionProjections']) {
      ctx.inject([name], (inner) => {
        inner.effect(() => {
          const service = inner[name]
          pressure[name] = service
          return () => {
            if (pressure[name] === service) delete pressure[name]
          }
        })
      })
    }
    const reminder = createCompactionReminder(pressure, config.reminderPressure)
    ctx.inject(['systemPrompt'], (inner) => {
      const prompt = inner.systemPrompt
      if (typeof prompt?.context !== 'function') return
      inner.effect(() => prompt.context({
        name: 'local-kb:compaction',
        order: 302,
        interpolate: false,
        text: (context) => {
          try {
            return reminder(context)
          } catch {
            return ''
          }
        },
      }))
    })
  }

  // ---- 写入即同步 hook：tools/result 监听（核心） ----
  const syncState = new SyncState(kbRoot, dshHome)
  let syncChain = syncState.ready.then(() => {}) // 串行化：同一时刻最多一个同步任务
  let autoTimer = null
  ctx.effect(() => () => {
    if (autoTimer !== null) clearTimeout(autoTimer)
  }, 'local-kb: sync timer cleanup')

  function scheduleSync(trigger, delayMs = 1500) {
    // 防抖：连续多次写入合并为「一次同步 + 一次 kb-check」（技能铁律：写入后必校验）。
    // kb-check 全库扫描较慢，绝不每次写入都跑 —— 并入同一窗口，风暴只跑一轮。
    if (trigger === 'auto') {
      if (autoTimer !== null) {
        clearTimeout(autoTimer)
      }
      autoTimer = setTimeout(() => {
        autoTimer = null
        enqueueSync('auto')            // 仅 WebDAV 同步；校验在 runSync 内（检查通过才同步）
      }, delayMs)
      return
    }
    return enqueueSync(trigger)
  }

  function enqueueSync(trigger) {
    syncChain = syncChain.then(() => runSync({ trigger }))
    return syncChain
  }

  /** 定位插件自带的 kb-check.py（随技能副本一起发布）。 */
function kbCheckScript() {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, 'skill', 'tools', 'kb-check.py')
}

/** kb-check.py 校验：技能铁律「写入后必跑校验」的 hook 兜底 —— AI 忘记跑时插件补跑。
 *  fire-and-forget；判定完全依赖**退出码**（脚本语义：0=通过，1=错误，2=警告），
 *  绝不解析输出文本（"警告"字样可能出现在"0 警告"这类正常行里）。
 *  execFile 对非 0 退出码会 reject 且吞掉 stdout，故用 spawn+手动收集两路输出来精确取码。 */
async function runKbCheck() {
  const script = kbCheckScript()
  const at = new Date().toISOString()
  const python = platform() === 'win32' ? 'python' : 'python3'
  try {
    // --json：结构化拿错误/警告/统计，页面据此分项目展示，不解析人类可读文本
    const result = await runKbCheckProcess(python, script, kbRoot, ['--json'])
    const status = result.code === 0 ? 'ok' : result.code === 2 ? 'warn' : 'failed'
    let parsed
    try {
      parsed = JSON.parse(String(result.out).trim().split('\n').filter(Boolean).pop())
    } catch {
      parsed = undefined
    }
    const errors = Array.isArray(parsed?.errors) ? parsed.errors.slice(0, 5) : []
    const warns = Array.isArray(parsed?.warns) ? parsed.warns.slice(0, 5) : []
    await syncState.record({
      lastCheckAt: at,
      lastCheckStatus: status,
      lastCheckError: errors[0] ?? warns[0] ?? null,
      lastCheckErrors: errors,
      lastCheckWarns: warns,
      lastCheckStats: parsed?.stats ?? null,
    })
    return { status, at }
  } catch {
    // spawn 失败（python 缺失/超时）：记为工具不可用，不影响同步与对话
    await syncState.record({ lastCheckAt: at, lastCheckStatus: 'no-python', lastCheckError: null })
    return { status: 'no-python', at }
  }
}

/** spawn 跑 kb-check，返回 { code, out }。超时/spawn 错误 reject。 */
function runKbCheckProcess(python, script, kbRoot, extraArgs = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = ''
    let settled = false
    const child = spawn(python, [script, kbRoot, ...extraArgs], { timeout: 60000 })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      rejectPromise(new Error('kb-check 超时'))
    }, 60000)
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rejectPromise(error) // ENOENT = python 缺失
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: code ?? 1, out })
    })
  })
}

/** 真正的同步执行体：读凭据 → 同步 → 记录状态。任何失败只落状态，不抛。 */
  async function runSync({ trigger }) {
    try {
      // 校验永远不阻塞同步：kb-check 只记录状态供设置页展示。
      // auto（写入后）跑一次校验（技能铁律），manual（立即同步）跳过。
      // 无论校验通过/警告/失败，文件照常推 —— 知识库长期有错不能被卡死不同步。
      if (trigger === 'auto') {
        await runKbCheck()
      }
      const creds = ctx.get('credentials')
      const url = await resolveRef(creds, CRED_URL_REF)
      if (!url) {
        await syncState.record({ lastSyncAt: new Date().toISOString(), lastSyncStatus: 'failed', lastError: '未配置 WebDAV 链接', lastTrigger: trigger })
        return { ok: false, reason: '未配置 WebDAV 链接' }
      }
      const user = (await resolveRef(creds, CRED_USER_REF)) || ''
      const password = (await resolveRef(creds, CRED_PASSWORD_REF)) || ''
      const result = await syncRoot({
        kbRoot, url, user, password, previousMap: syncState.fileMapObject(),
      })
      await syncState.saveFileMap(new Map(Object.entries(result.fileMap)))
      await syncState.record({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: 'ok',
        lastError: null,
        lastTrigger: trigger,
        syncedFiles: result.pushed.length,
        deletedFiles: result.deleted.length,
        failedDeletes: result.failedDeletes.length,
      })
      return { ok: true, pushed: result.pushed, total: result.total, state: syncState.snapshot() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await syncState.record({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: 'failed',
        lastError: message,
        lastTrigger: trigger,
      })
      return { ok: false, reason: message, state: syncState.snapshot() }
    }
  }

  async function resolveRef(creds, ref) {
    if (!creds || typeof creds.resolve !== 'function') return undefined
    const hit = await creds.resolve(ref)
    return hit && typeof hit.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  }

  ctx.on('tools/result', (exec, result) => {
    try {
      if (!exec || !exec.arguments || typeof exec.arguments !== 'object') return
      if (result && result.isError) return // 只同步写入成功的调用
      const args = exec.arguments
      const tool = typeof exec.name === 'string' ? exec.name : ''
      const filePath = typeof args.file_path === 'string' ? args.file_path
        : typeof args.path === 'string' ? args.path
          : undefined

      // 写工具判定：
      //  - write/edit/str_replace/insert 有 file_path 且落在 KB_ROOT 内；
      //  - str_replace_editor 的 create/str_replace/insert 走 args.path；
      //  - bash：参数里出现 KB_ROOT 文本即触发（增量检查，无变化零成本）。
      let isKbWrite = false
      if (FILE_WRITE_TOOLS.has(tool) && filePath !== undefined) {
        isKbWrite = isInside(kbRoot, filePath)
      } else if (tool === 'str_replace_editor'
        && (args.command === 'create' || args.command === 'str_replace' || args.command === 'insert')
        && filePath !== undefined) {
        isKbWrite = isInside(kbRoot, filePath)
      } else if (tool === 'bash' && bashWritesKb(kbRoot, args)) {
        isKbWrite = true
      }
      if (!isKbWrite) return

      // 技能纪律「写入后必校验 + 写入即同步」的 hook 兜底：一次防抖窗口内
      // 同步 + 校验并行 fire-and-forget，失败只落状态，绝不阻塞对话。
      scheduleSync('auto')
    } catch {
      // 监听器自身出错不得影响 tools/result 分发
    }
  })

  // ---- KB-first 门禁 hook：tools/pre-execute（唯一硬闸）+ tools/post-execute（不打断提醒）----
  // v2（2026-10）判定权交给模型（常驻块 M/K/W 规则），插件只留「无可争议」的硬闸：
  //   - 唯一硬闸：grep/rg **内容搜索**的目标 = 根 / 或 home 本身（无差别全盘扫描，
  //     AI 必然不知道去哪），且本 agent 从未查过 KB → deny 一次；
  //   - 永不拦：web_search/web_fetch（外部知识不归 KB 管）、find/locate/mdfind（KB 无文件清单）、
  //     codegraph（项目内）、read 任意路径（定点访问=知道去哪）、home 一级目录
  //     （~/Documents、~/projects… 有位置语义，误伤 > 漏拦）、工作区内搜索、写入工具；
  //   - 状态 per-agent（WeakMap，随 agent 回收，零清理代码）：kbChecked=查过 KB →
  //     该 agent 永不再拦全盘搜索；memoryChecked=碰过 KB 记忆区（只 grep docs 不算）；
  //     reminded=任务内提醒计数（每类 1 次，用户新消息经 agent/pre-step 重置）；
  //   - 性能：全程同步字符串判定，零 IO；bash token 解析只发生在命令含 grep/rg 时；
  //     超长命令（>8192）跳过判定；handler 绝无 await 外部调用；
  //   - 异常安全：任何内部错误 → next() 放行（门禁宁可失效不可误伤）；
  //   - DSH_LOCAL_KB_ENFORCE=0 总闸。
  {
    const home = homedir()
    const MAX_CMD = 8192
    /** macOS APFS：/System/Volumes/Data 前缀等价于真实根 /（含 /Users → home）。 */
    const normalizePath = (p) => {
      if (p === '/System/Volumes/Data') return '/'
      return p.startsWith('/System/Volumes/Data/') ? p.slice('/System/Volumes/Data'.length) : p
    }
    /** ~ 前缀（或单独的 ~）展开成绝对路径。 */
    const expand = (raw) => raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw

    /** per-agent 状态（WeakMap：键是 Agent 实例，GC 随 agent 回收，无 Map 泄漏/清理事件）。 */
    const states = new WeakMap()
    const stateOf = (agent) => {
      if (!agent || typeof agent !== 'object') return null
      let st = states.get(agent)
      if (!st) {
        st = { kbChecked: false, memoryChecked: false, reminded: { global: false, memory: false, web: false } }
        states.set(agent, st)
      }
      return st
    }

    /** 路径是否落在 KB（含 ~/.local-kb 简写兜底）。 */
    const touchesKb = (s) => typeof s === 'string' && s !== '' &&
      (s.includes(kbRoot) || (kbRoot.includes('.local-kb') && s.includes('.local-kb')))

    /** 记录 KB 认知：kbChecked 必置；路径真实碰过记忆区才置 memoryChecked。 */
    const noteKbHit = (st, s) => {
      if (!st) return
      st.kbChecked = true
      if (touchesKb(s) && s.includes('/memory/')) st.memoryChecked = true
    }

    /** 截取搜索命令段：管道/分号/与之前的非搜索命令不解析。只认 grep/rg（内容搜索）——
     *  find/locate/mdfind 永不判定（KB 没有文件清单，拦了答非所问）。 */
    const searchSegment = (cmd) => {
      const m = cmd.match(/\b(?:grep|rg)\b[^|;&\n]*/)
      return m ? m[0] : ''
    }
    /** 搜索段内的全部显式目标（绝对路径 token + workdir），KB 内目标不算。 */
    const bashTargets = (cmd, args) => {
      const out = []
      const toks = cmd.match(/(?<![A-Za-z0-9_.-])(?:~(?:\/|(?=[\s"'`|&;<>()]|$))|\/)(?!\/)[^\s"'`|&;<>()]*/g) || []
      for (const t of toks) {
        const e = expand(t)
        if (isAbsolute(e) && !isInside(kbRoot, e)) out.push(e)
      }
      const workdir = typeof args?.workdir === 'string' && args.workdir.trim() !== '' ? expand(args.workdir) : ''
      if (workdir !== '' && !isInside(kbRoot, workdir)) out.push(workdir)
      return out
    }
    /** 唯一硬闸判定：grep/rg 的目标（归一后）落在根或 home 本身。 */
    const isGlobalSearch = (cmd, args) => bashTargets(searchSegment(cmd), args).some((t) => {
      const n = normalizePath(t)
      return n === '/' || n === home
    })

    // ---- 任务内提醒（post-execute 附加上下文；不 deny、不重写结果、零打断）----
    const kbGrep = 'grep -rn "关键词" ' + kbRoot + '/projects/*/*.md ' + kbRoot + '/docs/'
    const reminderTexts = {
      // 知识库没有覆盖项目/文档的总索引（只有记忆有 MEMORY.md），
      // 所以这里不能说「知识库有索引」——那是错误的定位信息。
      global: '全盘扫描开销大。KB 没命中可以换关键词再搜一次（项目页/文档是中文正文，别名在 frontmatter）；仍无结果再全盘搜索。',
      // 索引通常已由插件注入；提醒只在「没看到注入内容」时有意义。
      memory: '任务若涉及记忆（上次说过/项目上下文/偏好/之前配置），记忆只从知识库取：' +
        '上下文里已有「知识库记忆（已注入）」就直接用；没看到时 read ' + kbRoot + '/memory/MEMORY.md' +
        '（提项目再读 projects/<id>/memory/MEMORY.md）。不涉及记忆可忽略本提示。',
      web: '若在查本地项目/代码/配置相关问题，先查知识库：' + kbGrep + '；外部知识查询可忽略本提示。',
    }
    const summaryOf = { global: '提示：本地检索优先用知识库', memory: '记忆先行：先读 KB memory/MEMORY.md', web: '提示：本地问题先查知识库' }
    const makeReminder = async (text, summary) => {
      const create = await reminderFactory
      const msg = { role: 'user', content: [{ type: 'text', text }], source: { kind: 'local-kb-reminder', form: 'notice', summary } }
      return create ? create({ ...msg }) : { ...msg, id: randomUUID() }
    }

    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        if (process.env.DSH_LOCAL_KB_ENFORCE === '0') return next()
        const tool = exec.name
        if (tool === 'bash') {
          const args = exec.arguments
          const cmd = typeof args?.command === 'string' ? args.command : ''
          const st = stateOf(exec.agent)
          if (touchesKb(cmd)) { noteKbHit(st, cmd); return next() } // KB 操作放行 + 刷新认知
          if (cmd.length > MAX_CMD) return next()                    // 超长命令跳过判定
          if (st && isGlobalSearch(cmd, args) && !st.kbChecked) {   // 唯一硬闸（无 agent 直调永不拦）
            return {
              kind: 'deny',
              reason: '先查知识库：' + kbGrep + ' 或 read KB 内文件；KB 未命中再全盘搜索' +
                (st && !st.memoryChecked ? '。涉及记忆先 read ' + kbRoot + '/memory/MEMORY.md' : '') +
                '。本会话查过 KB 后放行',
            }
          }
          return next()
        }
        if (tool === 'read') {
          const st = stateOf(exec.agent)
          const p = typeof exec.arguments?.file_path === 'string' ? exec.arguments.file_path : ''
          if (touchesKb(p)) noteKbHit(st, p)
          return next() // read 有明确路径 = 定点访问，永不拦
        }
        // 其余（web_search/web_fetch/codegraph/find/写入工具…）永不拦
        return next()
      } catch {
        return next() // 门禁宁可失效不可误伤
      }
    })

    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const decision = await next() // 先让下游/结果定型，再叠加提醒
      try {
        if (process.env.DSH_LOCAL_KB_ENFORCE === '0') return decision
        const st = stateOf(exec.agent)
        if (!st) return decision
        const tool = exec.name
        const args = exec.arguments
        let reminder = null
        if (tool === 'web_search' || tool === 'web_fetch') {
          if (!st.kbChecked && !st.reminded.web) { reminder = await makeReminder(reminderTexts.web, summaryOf.web); st.reminded.web = true }
        } else if (tool === 'bash') {
          const cmd = typeof args?.command === 'string' ? args.command : ''
          if (!touchesKb(cmd) && cmd.length <= MAX_CMD) {
            if (!st.memoryChecked && !st.reminded.memory && /\b(grep|rg|find)\b/.test(cmd)) {
              reminder = await makeReminder(reminderTexts.memory, summaryOf.memory); st.reminded.memory = true
            } else if (st.kbChecked && isGlobalSearch(cmd, args) && !st.reminded.global) {
              reminder = await makeReminder(reminderTexts.global, summaryOf.global); st.reminded.global = true
            }
          }
        } else if (tool === 'read') {
          const p = typeof args?.file_path === 'string' ? args.file_path : ''
          if (!touchesKb(p) && !st.memoryChecked && !st.reminded.memory) {
            reminder = await makeReminder(reminderTexts.memory, summaryOf.memory); st.reminded.memory = true
          }
        }
        if (!reminder) return decision
        if (decision.kind === 'block') {
          return { kind: 'block', feedback: decision.feedback, additionalContexts: [reminder, ...(decision.additionalContexts ?? [])] }
        }
        return { ...decision, additionalContexts: [reminder, ...(decision.additionalContexts ?? [])] }
      } catch {
        return decision
      }
    })

    // 新用户消息 = 新任务 → 重新武装任务内提醒（KB 认知标记保留：查过就是查过）
    ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
      const st = stateOf(agent)
      if (st && messages.some((m) => m && m.source && m.source.kind === 'user')) {
        st.reminded = { global: false, memory: false, web: false }
      }
      return next()
    })
  }

  // ---- 设置页 API：走 dsh 的 connection.fetch（带登录态与跨站校验） ----
  // 旧写法用 webServer 注册 exact 路由，直接命中本插件的 node handler，绕过了 dsh 的
  // /api 鉴权围栏：实测未登录请求 /api/local-kb/state 返回 200，并吐出 WebDAV 地址与
  // 用户名（DSH 自身路由同场景返回 401）。connection.fetch.register 的路由由 dsh 判定
  // 主人身份：未登录 401、跨站 403，插件不再自己承担鉴权。
  ctx.inject(['connection'], (scope) => {
    const register = scope.connection?.fetch?.register
    if (typeof register !== 'function') {
      writeRouteDebug(dshHome, { at: new Date().toISOString(), problem: 'connection.fetch.register 不可用' })
      return
    }
    const handlers = createApiHandlers({
      kbRoot, dshHome, syncState, runSync, getCredentials: () => ctx.get('credentials'),
    })
    // 每条路都必须带 requestBody：dsh 靠它决定请求体怎么喂给 handler。
    const routes = [
      { path: API_BASE + '/state', methods: ['GET'], requestBody: 'buffered', fetch: handlers.state },
      { path: API_BASE + '/overview', methods: ['GET'], requestBody: 'buffered', fetch: handlers.overview },
      { path: API_BASE + '/sync', methods: ['POST'], requestBody: 'buffered', fetch: handlers.sync },
      { path: API_BASE + '/test-link', methods: ['POST'], requestBody: 'buffered', fetch: handlers.testLink },
      { path: API_BASE + '/download', methods: ['POST'], requestBody: 'buffered', fetch: handlers.download },
    ]
    const failures = []
    for (const route of routes) {
      scope.effect(() => {
        try {
          return register(route)
        } catch (error) {
          // 同路径已被别的行占用：不注册，页面拿到 404 而不是把请求交给别人。
          // 只在失败时留证据，正常启动不产生任何文件。
          failures.push({ path: route.path, error: String(error?.message ?? error) })
          writeRouteDebug(dshHome, { at: new Date().toISOString(), failures })
          return () => {}
        }
      }, 'local-kb: route ' + route.path)
    }
  })

}

/** 技能副本不可用时的最小说明：保证技能条目存在且指向正确位置。 */
function builtinSkill(kbRoot) {
  return [
    '# local-kb — 知识库 + 长期记忆',
    '',
    '知识库根：' + kbRoot,
    '',
    '- 记忆：' + join(kbRoot, 'memory', 'MEMORY.md') + '（全局）、' +
      join(kbRoot, 'projects', '<id>', 'memory', 'MEMORY.md') + '（项目级）',
    '- 知识：' + join(kbRoot, 'projects') + '/<id>/<id>.md（项目页）、' + join(kbRoot, 'docs') + '（文档）',
    '- 项目路径：' + join(kbRoot, 'paths.yaml'),
    '- 检索：grep -rn "关键词" ' + join(kbRoot, 'projects', '*', '*.md') + ' ' + join(kbRoot, 'docs'),
    '',
    '完整协议见插件自带的 skill/SKILL.md；这一份只是副本不可用时的兜底。',
  ].join('\n')
}

/** 读插件自带的完整 SKILL.md（注册运行时技能用）。 */
function readSkillBody() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return readFileSync(join(here, 'skill', 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

/** 组装设置页 API 的三个 handler（Web Fetch API：Request → Response）。 */
function createApiHandlers({ kbRoot, dshHome, syncState, runSync, getCredentials }) {
  const resolveRefFor = async (ref) => {
    const creds = getCredentials()
    if (!creds || typeof creds.resolve !== 'function') return undefined
    const hit = await creds.resolve(ref)
    return hit && typeof hit.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  }

  return {
    /** GET /api/local-kb/state：设置页打开时读取的位置、凭据回显与同步状态。 */
    state: async () => {
      // message 级状态（时间/结果/错误）返回；fileMap 只在插件内部作增量基准，
      // 体积大且 client 不需要（状态已持久化到 .kb-sync-state.json）。
      const st = syncState.snapshot()
      const storedUrl = await resolveRefFor(CRED_URL_REF)
      const storedUser = (await resolveRefFor(CRED_USER_REF)) || ''
      return jsonResponse(200, {
        ok: true,
        kbRoot,
        dshHome,
        webdavUrl: storedUrl || '',
        webdavUser: storedUser,
        state: {
          lastSyncAt: st.lastSyncAt,
          lastSyncStatus: st.lastSyncStatus,
          lastError: st.lastError,
          lastTrigger: st.lastTrigger,
          syncedFiles: st.syncedFiles,
          lastCheckAt: st.lastCheckAt,
          lastCheckStatus: st.lastCheckStatus,
          lastCheckError: st.lastCheckError,
        },
        installed: await skillInstalled(dshHome),
      })
    },

    /** GET /api/local-kb/overview：知识库全貌（项目、文档、记忆用量），只读。 */
    overview: async () => {
      const entries = new Map()
      try {
        for (const entry of parsePathsYaml(readFileSync(join(kbRoot, 'paths.yaml'), 'utf8'))) {
          entries.set(entry.id, entry.path)
        }
      } catch {
        // 没有 paths.yaml：项目仍然列出，只是没有本机路径
      }
      const projects = []
      let projectDirs = []
      try {
        projectDirs = readdirSync(join(kbRoot, 'projects'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .slice(0, 100)
      } catch {
        projectDirs = []
      }
      for (const id of projectDirs) {
        const memoryDir = join(kbRoot, 'projects', id, 'memory')
        let memories = 0
        try {
          memories = readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').length
        } catch {
          memories = 0
        }
        let indexLines = 0
        try {
          indexLines = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8').split('\n').length
        } catch {
          indexLines = 0
        }
        const localPath = entries.get(id)
        projects.push({
          id,
          path: localPath ?? null,
          // 只报「登记了且目录还在」，不替用户猜路径
          pathExists: localPath === undefined ? null : existsSyncSafe(localPath),
          memories,
          indexLines,
        })
      }
      let docs = 0
      const countDocs = async (dir) => {
        let total = 0
        const walk = async (current) => {
          const items = await readdir(current, { withFileTypes: true }).catch(() => [])
          for (const item of items) {
            const full = join(current, item.name)
            if (item.isDirectory()) {
              if (item.name !== 'archive') await walk(full)
            } else if (item.name.endsWith('.md')) total++
          }
        }
        await walk(dir)
        return total
      }
      docs += await countDocs(join(kbRoot, 'docs'))
      projects.sort((a, b) => a.id.localeCompare(b.id))
      // 只列目录名，不读文档正文
      let docDirs = []
      try {
        docDirs = readdirSync(join(kbRoot, 'docs'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        docDirs = []
      }
      return jsonResponse(200, { ok: true, kbRoot, projects, docs, docDirs })
    },

    /** POST /api/local-kb/sync：上传（本地覆盖云端，远端多余文件删除）。 */
    sync: async () => {
      const result = await runSync({ trigger: 'manual' })
      return jsonResponse(200, { ok: result.ok, ...result })
    },

    /** POST /api/local-kb/download：从云端下载，覆盖本地同名文件（本地多余文件保留）。 */
    download: async () => {
      const url = await resolveRefFor(CRED_URL_REF)
      if (!url) return jsonResponse(200, { ok: false, reason: '未配置 WebDAV 链接' })
      const user = (await resolveRefFor(CRED_USER_REF)) || ''
      const password = (await resolveRefFor(CRED_PASSWORD_REF)) || ''
      try {
        const result = await downloadRoot({ kbRoot, url, user, password })
        await syncState.record({
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: result.failed.length === 0 ? 'ok' : 'failed',
          lastError: result.failed.length === 0 ? null : result.failed.length + ' 个文件下载失败',
          lastTrigger: 'download',
          syncedFiles: result.written.length,
          deletedFiles: 0,
        })
        return jsonResponse(200, {
          ok: result.failed.length === 0,
          written: result.written.length,
          failed: result.failed,
          total: result.total,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await syncState.record({
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: 'failed',
          lastError: message,
          lastTrigger: 'download',
        })
        return jsonResponse(200, { ok: false, reason: message })
      }
    },

    /** POST /api/local-kb/test-link：用表单值（空则回退已存凭据）测 WebDAV 连通性。 */
    testLink: async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      if (body === null || typeof body !== 'object') body = {}
      // 表单里的空串（用户没填/没动密码框）一律回退已存凭据 —— 空密码绝不能
      // 覆盖已存密码去测试。未保存的改动可先测：非空字段用表单值。
      const url = (typeof body.url === 'string' && body.url.trim() !== '') ? body.url.trim() : (await resolveRefFor(CRED_URL_REF))
      const user = (typeof body.user === 'string' && body.user.trim() !== '') ? body.user.trim() : ((await resolveRefFor(CRED_USER_REF)) || '')
      const password = (typeof body.password === 'string' && body.password !== '') ? body.password : ((await resolveRefFor(CRED_PASSWORD_REF)) || '')
      return jsonResponse(200, await testLink({ url, user, password }))
    },
  }
}

async function skillInstalled(dshHome) {
  try {
    await access(join(dshHome, 'skills', SKILL_NAME, 'SKILL.md'), FS.F_OK)
    return true
  } catch {
    return false
  }
}

/* =========================================================================
 * 长对话提醒（最小版）
 * -------------------------------------------------------------------------
 * 不算 dsh 的压缩触发点（那要复制 compaction 的阈值推导，跨版本易碎）。
 * 只用 tokenMeter 的 totalTokens 与 contextPressure 的窗口算比例，过线提醒一次。
 * 目的是「别把该写的攒到压缩前」，不是精确预测压缩。
 * ======================================================================= */
export const REMINDER_PRESSURE = 0.6
export const COMPACTION_REMINDER_TEXT =
  '对话已经很长（约 60% 上下文窗口）。趁还没被压缩，把这次任务里值得长期保留的结论写进知识库：' +
  '一条事实一个文件，指针进对应的 MEMORY.md。只写长期有用的，过程细节不要写。'

/**
 * 返回一个 context.text 函数：同一 session 只提醒一次（WeakSet 随 session 回收）。
 * 拿不到 tokenMeter、上下文窗口或 session 时一律不提醒 —— 宁可漏，不制造噪音。
 */
export function createCompactionReminder(pressure = {}, threshold = REMINDER_PRESSURE) {
  const reminded = new WeakSet()
  const ratio = Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : REMINDER_PRESSURE
  return (context) => {
    const session = context?.agent?.session
    if (session === null || typeof session !== 'object') return ''
    if (reminded.has(session)) return ''
    let tokens
    let window
    try {
      tokens = pressure.tokenMeter?.measure?.(session)?.totalTokens
      window = pressure.sessionProjections?.stateOf?.(session, 'contextPressure')?.contextWindow
    } catch {
      return ''
    }
    if (!Number.isFinite(tokens) || !Number.isInteger(window) || window <= 0) return ''
    if (tokens / window < ratio) return ''
    reminded.add(session)
    return COMPACTION_REMINDER_TEXT
  }
}

/** 路由注册诊断：写 $DSH_HOME/local-kb/route-debug.json（排查设置页 404 用）。 */
function writeRouteDebug(dshHome, report) {
  try {
    const dir = join(dshHome, 'local-kb')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'route-debug.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch {
    // 诊断写不出来不影响功能
  }
}

/** 目录是否存在（overview 判断项目路径是否还在）。 */
function existsSyncSafe(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 所有 API 回答：JSON、不缓存、不被浏览器嗅探成别的类型。 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}


