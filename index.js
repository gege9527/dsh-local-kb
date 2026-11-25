/**
 * dsh-local-kb — 知识库插件 Host 半。
 *
 * 三件事（技能文件本身一字不改，全部旁路增强）：
 *   1. 技能随包加载（bundledSkillDir，见 cordis.patch.yml），常驻规则走 systemPrompt.context；
 *      旧版本留下的技能副本与 AGENTS.md 常驻块由 migrate.js 一次性清掉，卸载零残留。
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
import { randomUUID } from 'node:crypto'
import { constants as FS, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import http from 'node:http'
import https from 'node:https'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SKILL_NAME } from './install-skill.js'
import { migrateLegacyInstall } from './migrate.js'
import {
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
  knowledgeMapText,
  memoryIndexText,
  parsePathsYaml,
  projectKind,
  rulesText,
  skillDir,
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

/**
 * 自动链路是否继续上传。
 * 体检（kb-check）不受这个开关影响：写入后永远体检，只是没开自动同步就不推远端。
 * 手动上传走 trigger: 'manual'，不看这个开关。
 */
export function shouldAutoUpload(autoSync) {
  return autoSync === true
}

/** 远端根目录：只允许相对路径，挡掉空值、.. 与反斜杠。 */
export function sanitizeRemoteDir(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '' || trimmed.includes('..') || trimmed.includes('\\')) return undefined
  return trimmed
}
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
  // 基准指纹：库根换了，分片基准描述的就是另一个库，必须作废，否则增量会漏传。
  rootPath: null,
  staleBaseline: false,
  // 改位置阶段：'copying' | 'verifying' | 'switching' | 'renaming' | null（设置页轮询它显示进度）
  relocatePhase: null,
}

/** Sync 目录的写工具名（write 是整体替换；edit/str_replace/insert 是就地修改）。 */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'str_replace', 'insert'])

function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** 知识库目录名固定：位置可以换，名字不可换（工具链契约）。 */
export const KB_DIR_NAME = '.local-kb'

/** 父目录 → 库根。名字硬拼，不接受、也不解析任何自定义库名。 */
export function kbRootOf(parent) {
  return resolve(parent, KB_DIR_NAME)
}

/** 生效的父目录：插件设置优先；没设置就用主目录（此时库根仍是 ~/.local-kb）。 */
export function resolveParent(settings) {
  const raw = settings && typeof settings.parent === 'string' ? settings.parent.trim() : ''
  return raw !== '' ? resolve(raw) : homedir()
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

/**
 * run_code 里的写文件调用（Node fs / 流）。
 * 只认明确的写函数，不认任意函数名：判错的方向是「多触发一次体检」，不是「漏同步」。
 */
const CODE_WRITE_PATTERN = new RegExp(
  '(?:\\bfs\\.(?:promises\\.)?(?:writeFile|appendFile|rename|copyFile|rm|unlink|mkdir|truncate|createWriteStream)\\w*\\s*\\()'
  + '|(?:\\b(?:writeFileSync|appendFileSync|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync|truncateSync|createWriteStream)\\s*\\()',
)

/**
 * run_code 的代码是否会改动 KB 内文件。
 *
 * PTC 模式下 AI 常用 `fs.writeFileSync('…/.local-kb/…')` 直写，绕过 write/edit 工具，
 * tools/result 里看不到 —— 体检与自动同步都不会触发。这里按 bashWritesKb 的思路补一条：
 * 先要求有写动作，再按 classifyPath 判路径；变量拼出来的路径退回到文本包含。
 */
export function codeWritesKb(kbRoot, args) {
  const code = typeof args?.code === 'string' ? args.code : ''
  if (code === '' || code.length > 262144) return false
  if (!CODE_WRITE_PATTERN.test(code)) return false
  // 变量拼出来的路径判不出（如 `${kb}/memory/${name}.md`）：退回到文本包含的下限
  if (commandPathTokens(code).length === 0) {
    return code.includes(kbRoot) || (kbRoot.includes('.local-kb') && code.includes('.local-kb'))
  }
  // 只看写调用附近的窗口（前后各 400 字符）：路径可能先赋值给变量再传参。
  // 同一段代码里「读 KB + 写别处」会多触发一次体检 —— 幂等且防抖，宁可多跑不漏跑。
  const re = new RegExp(CODE_WRITE_PATTERN.source, 'g')
  let m
  while ((m = re.exec(code)) !== null) {
    const win = code.slice(Math.max(0, m.index - 400), m.index + 400)
    for (const raw of commandPathTokens(win)) {
      const { kind } = classifyPath(kbRoot, expandHome(raw))
      if (kind !== 'outside' && kind !== 'unknown') return true
    }
  }
  return false
}

/* =========================================================================
 * 记忆索引上限：确定性拒绝（不是提醒）
 * -------------------------------------------------------------------------
 * 与 skills/local-kb/tools/kb-check.py 同一组数字：软 150 行/20KB 只警告，硬 200 行/25KB 拒绝。
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
 * 规则：删除只由用户做。AI 只能「归档」——把内容移进 <KB_ROOT>/archive/。
 * 这里拦的是 AI 通过 bash 删除：rm / unlink / shred / truncate / find -delete，
 * 以及把文件移出 KB（mv 出界等价于删除）。KB 内部的 mv（进 archive/）放行。
 * ======================================================================= */
const BASH_DELETE_PATTERN = /\b(?:rm|rmdir|unlink|shred|truncate)\b|(?:^|\s)-delete\b/

const deleteRefusal = (rel) => `知识库内容只归档不删除：${rel} 不能删。` +
  `把内容移到 <KB_ROOT>/archive/（例：archive/memory/<slug>.md、archive/projects/<id>/）再改索引；` +
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

/** 组合 guard：删除判定在前，索引上限在后（indexCap:false 可单独关上限）。
 *  第一个参数可以是路径字符串，也可以是 getter —— 改位置后判定跟着走。 */
export function kbGuard(rootOrGetter, { indexCap = true } = {}) {
  const rootOf = typeof rootOrGetter === 'function' ? rootOrGetter : () => rootOrGetter
  return (exec) => {
    try {
      const kbRoot = rootOf()
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
/** 插件设置：远端根目录、自动同步开关、服务商标识。 */
export const SETTINGS_FILENAME = 'settings.json'

// 自动同步默认关闭：避免新装用户一写入就把远端备份覆盖掉。
// parent 是知识库父目录：库根固定为 <parent>/.local-kb。
const SETTINGS_DEFAULTS = { parent: null, remoteDir: REMOTE_SYNC_DIR, autoSync: false, provider: 'custom' }

/** 设置里的父目录：只接受绝对路径；非法值当没写。 */
function sanitizeParent(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '' || !isAbsolute(trimmed)) return undefined
  return resolve(trimmed)
}

export function loadPluginSettings(dshHome) {
  try {
    const raw = JSON.parse(readFileSync(join(dshHome, 'local-kb', SETTINGS_FILENAME), 'utf8'))
    return {
      parent: sanitizeParent(raw.parent) ?? null,
      remoteDir: sanitizeRemoteDir(raw.remoteDir) ?? SETTINGS_DEFAULTS.remoteDir,
      // 只有明确写了 true 才开；旧文件没有这个字段 → 按默认关闭
      autoSync: raw.autoSync === true,
      provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() : 'custom',
    }
  } catch {
    return { ...SETTINGS_DEFAULTS }
  }
}

export function savePluginSettings(dshHome, patch) {
  const current = loadPluginSettings(dshHome)
  const next = {
    // 显式传 null = 清回默认（主目录）；非法值保留原值。
    parent: patch.parent === null ? null : (sanitizeParent(patch.parent) ?? current.parent),
    remoteDir: sanitizeRemoteDir(patch.remoteDir) ?? current.remoteDir,
    autoSync: typeof patch.autoSync === 'boolean' ? patch.autoSync : current.autoSync,
    provider: typeof patch.provider === 'string' && patch.provider.trim() ? patch.provider.trim() : current.provider,
  }
  try {
    mkdirSync(join(dshHome, 'local-kb'), { recursive: true })
    writeFileSync(join(dshHome, 'local-kb', SETTINGS_FILENAME), JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // 设置写不进去也不影响本次会话
  }
  return next
}

/* =========================================================================
 * 改位置：预检 + 复制校验（切换与旧目录改名在 apply 里，需要内存状态）
 * ======================================================================= */

/** 时间戳 YYYYMMDDHHmmss（本地时区）：旧库目录名用，秒级防重名。 */
export function stampNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return String(date.getFullYear()) + pad(date.getMonth() + 1) + pad(date.getDate()) +
    pad(date.getHours()) + pad(date.getMinutes()) + pad(date.getSeconds())
}

/** 旧库改名目标：<同目录>/.local-kb-old-<时间戳>。 */
export function legacyDirOf(kbRoot, stamp = stampNow()) {
  return join(dirname(resolve(kbRoot)), KB_DIR_NAME + '-old-' + stamp)
}

/** 递归统计文件数与总字节数（预检与校验都用它）。 */
async function measureTree(dir) {
  let files = 0
  let bytes = 0
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        files += 1
        const info = await stat(full).catch(() => undefined)
        if (info) bytes += info.size
      }
    }
  }
  await walk(dir)
  return { files, bytes }
}

/**
 * 预检：只读，不改任何东西。
 * 拒绝条件 = 目标不合法 / 已存在同名文件夹 / 与当前库重叠 / 当前库不完整。
 */
export async function precheckRelocate({ kbRoot, parent }) {
  const blockers = []
  if (typeof parent !== 'string' || parent.trim() === '' || !isAbsolute(parent.trim())) {
    return { ok: false, target: null, blockers: ['目标父目录必须是绝对路径'], plan: { files: 0, bytes: 0 } }
  }
  const parentPath = resolve(parent.trim())
  const target = kbRootOf(parentPath)
  const parentStat = await stat(parentPath).catch(() => undefined)
  if (parentStat === undefined) blockers.push('目标父目录不存在')
  else if (!parentStat.isDirectory()) blockers.push('目标父目录不是目录')
  else {
    try {
      await access(parentPath, FS.W_OK)
    } catch {
      blockers.push('目标父目录不可写')
    }
  }
  // 库名固定，目标只可能是 <parent>/.local-kb：已存在就整体拒绝，不做合并。
  if (existsSync(target)) blockers.push('目标已存在同名文件夹 ' + KB_DIR_NAME)
  if (target === resolve(kbRoot)) blockers.push('目标与当前位置相同')
  else if (isInside(kbRoot, target) || isInside(target, kbRoot)) blockers.push('目标与当前知识库重叠')
  if (!existsSync(join(kbRoot, 'paths.yaml'))) blockers.push('当前知识库缺少 paths.yaml，先确认库完整')
  const plan = blockers.length === 0 ? await measureTree(kbRoot) : { files: 0, bytes: 0 }
  return { ok: blockers.length === 0, target, blockers, plan }
}

/**
 * 复制 + 校验 + 落位：复制到 <target>.incoming-<时间戳>/，比对文件数与字节数，
 * 通过才 rename 成正式目录。失败删临时目录（不留半成品）。
 */
export async function relocateCopy({ kbRoot, parent, onPhase }) {
  const pre = await precheckRelocate({ kbRoot, parent })
  if (!pre.ok) return { ok: false, code: 'PRECHECK_FAILED', blockers: pre.blockers, target: pre.target }
  const target = pre.target
  const incoming = target + '.incoming-' + stampNow()
  try {
    onPhase?.('copying')
    await cp(kbRoot, incoming, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    onPhase?.('verifying')
    const source = await measureTree(kbRoot)
    const copied = await measureTree(incoming)
    if (source.files !== copied.files || source.bytes !== copied.bytes) {
      throw new Error('校验不一致：源 ' + source.files + ' 文件 / ' + source.bytes + ' B，副本 ' +
        copied.files + ' 文件 / ' + copied.bytes + ' B')
    }
    if (existsSync(target)) throw new Error('目标已存在同名文件夹 ' + KB_DIR_NAME)
    await rename(incoming, target)
    return { ok: true, target, plan: source }
  } catch (error) {
    await rm(incoming, { recursive: true, force: true }).catch(() => {})
    return { ok: false, code: 'COPY_FAILED', reason: String(error?.message ?? error), target }
  }
}

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
    this.rootPath = resolve(kbRoot)
    // 状态目录固定：位置统一后同一时刻只有一个库，不再按路径哈希分桶。
    this.dir = join(dshHome, 'local-kb', 'state')
    this.metaFile = join(this.dir, 'meta.json')
    this.map = new Map()
    this.shardCache = new Map()
    this.ready = this.load()
  }

  async load() {
    let storedRoot
    try {
      this.state = { ...SYNC_STATE_DEFAULT, ...JSON.parse(await readFile(this.metaFile, 'utf8')) }
      storedRoot = typeof this.state.rootPath === 'string' ? this.state.rootPath : undefined
    } catch {
      // 还没同步过
    }
    // 库根变了：分片基准描述的是另一个库，增量会漏传 —— 作废基准，下次按全量重传。
    if (storedRoot !== undefined && storedRoot !== this.rootPath) {
      this.state = { ...SYNC_STATE_DEFAULT, rootPath: this.rootPath, staleBaseline: true }
      return
    }
    this.state.rootPath = this.rootPath
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

  /** 改位置后换根：基准保留（复制过来的内容与相对路径都没变），只更新指纹。 */
  async retarget(newRoot) {
    this.rootPath = resolve(newRoot)
    await this.record({ rootPath: this.rootPath, staleBaseline: false })
  }

  fileMapObject() {
    return Object.fromEntries(this.map)
  }

  async record(patch) {
    this.state = { ...this.state, ...patch, rootPath: this.rootPath }
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
export async function syncRoot({ kbRoot, url, user, password, previousMap, remoteDir }) {
  const dir = sanitizeRemoteDir(remoteDir) ?? REMOTE_SYNC_DIR
  const rootBase = url.replace(/\/+$/, '')
  const base = rootBase + '/' + dir
  const auth = basicAuth(user, password)
  _confirmedDirs.clear()
  _dirInFlight.clear() // 每次全新同步，目录确认缓存只作用于本次
  // 确保远端目录存在：remoteDir 可能是多级路径，逐段 MKCOL（幂等）。
  {
    _confirmedDirs.add(rootBase)
    await ensureRemoteDirChain(rootBase, dir, auth)
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

  // 本地既没有改动也没有删除时，远端不可能有需要清理的东西（单写者），
  // 直接跳过远端全树扫描 —— 每次写入后的自动同步省掉约 3 秒。
  const localPaths = new Set(files)
  const removedLocally = [...previous.keys()].filter((rel) => !localPaths.has(rel))
  if (pending.length === 0 && removedLocally.length === 0) {
    return {
      pushed: [], deleted: [], failedDeletes: [],
      total: files.length, fileMap: Object.fromEntries(now), skipped: true,
    }
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
export async function downloadRoot({ kbRoot, url, user, password, remoteDir }) {
  const dir = sanitizeRemoteDir(remoteDir) ?? REMOTE_SYNC_DIR
  const base = url.replace(/\/+$/, '') + '/' + dir
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
  // 文档卡片是生成物：kb-search 发现缺卡会自动重建，不必占同步带宽。
  /^\.kb-index\//,
  // kb-move-project.py 的整库快照（每次移动一份，可达数 MB）：本地回滚用，不该传远端。
  /^\.backup\//,
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

/** 插件内部固定策略：这些不是用户配置项，值写死，不接受外部覆盖。 */
const FIXED = Object.freeze({
  migrateLegacy: true,
  indexCap: true,
  injectContext: true,
  injectMaxLines: DEFAULT_INDEX_MAX_LINES,
  injectMaxBytes: DEFAULT_INDEX_MAX_BYTES,
  injectDescriptions: true,
  injectRules: true,
  compactionReminder: true,
  reminderPressure: undefined, // undefined → createCompactionReminder 用内置默认
})

export function apply(ctx, _config = {}) {
  const dshHome = resolveDshHome()
  // 运行时设置：知识库父目录、远端根目录、自动同步开关。改设置页即时生效，不必重启。
  const pluginSettings = loadPluginSettings(dshHome)
  // 库根只从设置派生：名字固定 .local-kb，位置由父目录决定。
  // 改位置后立即生效 —— 所有闭包都通过 currentRoot() 取值，不缓存字符串。
  let kbRoot = kbRootOf(resolveParent(pluginSettings))
  const currentRoot = () => kbRoot

  // ---- 旧安装方式迁移：删掉复制出来的技能副本 + AGENTS.md 常驻块 ----
  // 必须跑在其它事情之前：技能根是 rank 400（user-dsh），会压过 bundled 的 600，
  // 旧副本不删就永远加载旧技能。只删带 .skill-version 标记的，删前备份。
  if (FIXED.migrateLegacy) {
    try {
      const migration = migrateLegacyInstall({ dshHome })
      if (migration.skillCopy === 'removed' || migration.agentsBlock === 'removed') {
        ctx.logger?.info?.('local-kb: 已迁移旧安装（' + describeMigration(migration) + '）')
      } else if (migration.skillCopy === 'conflict') {
        ctx.logger?.warn?.('local-kb: $DSH_HOME/skills/local-kb 不是本插件装的（无 .skill-version），保留原样')
      }
    } catch {
      // 迁移失败不影响插件本体：技能由 bundled 加载，最坏是旧副本还压着。
    }
  }

  // ---- 技能只有一条路径：cordis.patch.yml 的 bundledSkillDir ----
  // 不装副本、不做运行时注册、没有兜底：技能要么由 provider 加载，要么就是没有。
  // 这里只做一次存在性检查并发日志，方便排查「发布包漏了 skills/」这类问题。
  if (!existsSync(skillDir())) {
    ctx.logger?.warn?.('local-kb: 包内 skills/local-kb 缺失，技能将不可用（检查 package.json files 与发布产物）')
  }

  // ---- 记忆索引硬上限：ctx.tools.guard（同步、单调拒绝） ----
  // 200 行 / 25KB 之前只写在 AGENTS.md 和 kb-check.py 里，模型写超了也能落盘。
  // guard 在写入前同步判定，只拦「越界且变大」，压缩写入照常放行。
  if (typeof ctx.tools?.guard === 'function') {
    ctx.tools.guard(kbGuard(currentRoot, { indexCap: FIXED.indexCap }))
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
  if (FIXED.injectContext) {
    const cache = new Map()
    const maxLines = FIXED.injectMaxLines
    const maxBytes = FIXED.injectMaxBytes
    // 描述默认注入，但协议要求「一行钩子 ≤24 字」——源头写短，不在注入层裁。
    const withDescriptions = FIXED.injectDescriptions
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
            return memoryIndexText({ kbRoot: currentRoot(), cwd: sessionCwd(context), cache, maxLines, maxBytes, withDescriptions })
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
            return knowledgeMapText({ kbRoot: currentRoot(), cwd: sessionCwd(context), cache })
          } catch {
            return ''
          }
        },
      }))
    })
  }

  // ---- 常驻规则：替代旧方案写进 $DSH_HOME/AGENTS.md 的 KB_LOCAL 块 ----
  // 走 systemPrompt.context 而不是改用户文件：插件一卸，effect 自动注销，零残留。
  // 内容与技能自带的 references/agents-snippet.md 同源，跟着插件版本走。
  if (FIXED.injectRules) {
    const ruleCache = new Map()
    ctx.inject(['systemPrompt'], (inner) => {
      const prompt = inner.systemPrompt
      if (typeof prompt?.context !== 'function') return
      inner.effect(() => prompt.context({
        name: 'local-kb:rules',
        order: 299,
        interpolate: false,
        text: () => {
          try {
            return rulesText(ruleCache)
          } catch {
            return '' // 规则缺失不能拖垮请求
          }
        },
      }))
    })
  }

  // ---- 长对话提醒：把值得留的先写进 KB（每会话一次） ----
  if (FIXED.compactionReminder) {
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
    const reminder = createCompactionReminder(pressure, FIXED.reminderPressure)
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

  /** 切换库根：只改内存与同步指纹；settings.json 与旧目录改名由调用方负责。 */
  async function setRoot(newRoot) {
    kbRoot = resolve(newRoot)
    await syncState.retarget(kbRoot)
  }
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
    return join(here, 'skills', 'local-kb', 'tools', 'kb-check.py')
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
    const result = await runKbCheckProcess(python, script, currentRoot(), ['--json'])
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
      // auto（写入后）必跑一次校验（技能铁律「写入后必校验」），与是否上传无关；
      // manual（设置页立即同步）跳过，避免用户主动上传时被全库扫描拖慢。
      // 无论校验通过/警告/失败，文件照常推 —— 知识库长期有错不能被卡死不同步。
      if (trigger === 'auto') {
        await runKbCheck()
        // 校验常开、上传受开关控制：没开自动同步就到此为止，只留体检结果。
        if (!shouldAutoUpload(pluginSettings.autoSync)) {
          return { ok: false, skipped: true, reason: '自动上传未开启（仅体检）', state: syncState.snapshot() }
        }
      }
      const creds = ctx.get('credentials')
      const url = await resolveRef(creds, CRED_URL_REF)
      if (!url) {
        await syncState.record({ lastSyncAt: new Date().toISOString(), lastSyncStatus: 'failed', lastError: '未配置 WebDAV 链接', lastTrigger: trigger })
        return { ok: false, reason: '未配置 WebDAV 链接' }
      }
      const user = (await resolveRef(creds, CRED_USER_REF)) || ''
      const password = (await resolveRef(creds, CRED_PASSWORD_REF)) || ''
      // 远端根目录改过：旧基准对应的是另一个目录，必须清空重推，
      // 否则「本地没变化」会让新目录一个文件都建不起来。
      let previousMap = syncState.fileMapObject()
      if (syncState.state.remoteDir !== pluginSettings.remoteDir) {
        previousMap = {}
        await syncState.saveFileMap(new Map())
      }
      const result = await syncRoot({
        kbRoot: currentRoot(), url, user, password, previousMap,
        remoteDir: pluginSettings.remoteDir,
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
        remoteDir: pluginSettings.remoteDir,
      })
      return {
        ok: true,
        pushed: result.pushed.length,
        deleted: result.deleted.length,
        failedDeletes: result.failedDeletes.length,
        total: result.total,
        state: syncState.snapshot(),
      }
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
      // 注意：这里不判 autoSync。写入后必须体检（技能铁律），是否上传由 runSync 决定。
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
      //  - bash：命令里有写动作且目标在 KB_ROOT 内（无变化零成本）；
      //  - run_code：代码里有 fs 写调用且路径在 KB_ROOT 内（PTC 直写，绕过写工具）。
      let isKbWrite = false
      if (FILE_WRITE_TOOLS.has(tool) && filePath !== undefined) {
        isKbWrite = isInside(currentRoot(), filePath)
      } else if (tool === 'str_replace_editor'
        && (args.command === 'create' || args.command === 'str_replace' || args.command === 'insert')
        && filePath !== undefined) {
        isKbWrite = isInside(currentRoot(), filePath)
      } else if (tool === 'bash' && bashWritesKb(currentRoot(), args)) {
        isKbWrite = true
      } else if (tool === 'run_code' && codeWritesKb(currentRoot(), args)) {
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
        st = {
          kbChecked: false,
          memoryChecked: false,
          // reminded：本任务（用户一条新消息）内是否已提醒；sent：本会话累计发送次数。
          // 只有 reminded 会随新用户消息重置，sent 不重置——长会话里「每任务 1 次」
          // 实测会把同一句话刷 4 遍（11-05 13:34 那个调研会话），噪音大于收益。
          reminded: { global: false, memory: false, web: false },
          sent: { global: 0, memory: 0, web: 0 },
          // 已回传过的体检告警签名：同一组告警只提示一次；跨任务不重置（修好或换新告警才变）。
          checkSig: null,
        }
        states.set(agent, st)
      }
      return st
    }

    /** 路径是否落在 KB（含 ~/.local-kb 简写兜底）。 */
    const touchesKb = (s) => typeof s === 'string' && s !== '' &&
      (s.includes(currentRoot()) || (currentRoot().includes('.local-kb') && s.includes('.local-kb')))

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
        if (isAbsolute(e) && !isInside(currentRoot(), e)) out.push(e)
      }
      const workdir = typeof args?.workdir === 'string' && args.workdir.trim() !== '' ? expand(args.workdir) : ''
      if (workdir !== '' && !isInside(currentRoot(), workdir)) out.push(workdir)
      return out
    }
    /** 唯一硬闸判定：grep/rg 的目标（归一后）落在根或 home 本身。 */
    const isGlobalSearch = (cmd, args) => bashTargets(searchSegment(cmd), args).some((t) => {
      const n = normalizePath(t)
      return n === '/' || n === home
    })

    // ---- 任务内提醒（post-execute 附加上下文；不 deny、不重写结果、零打断）----
    // 检索提示：kb-search 带置信分级（弱结果会告警），比裸 grep 可靠；
    // 脚本缺失时回落成"限定项目目录 + 排除 archive"的 grep，不再教整库 grep。
    // 只判断包内脚本在不在：提示文案不拼本机路径 —— 路径由技能自己用相对路径声明，
    // harness 加载技能时给 base directory（见 dsh 的 <skill_resources>）。
    const kbSearchAvailable = (() => {
      try {
        return statSync(fileURLToPath(new URL('./skills/local-kb/tools/kb-search.py', import.meta.url))).isFile()
      } catch {
        return false
      }
    })()
    const kbGrep = () => (kbSearchAvailable
      ? '用技能 local-kb 的 tools/kb-search.py "关键词"（先看它的置信提示）'
      : 'grep -rn "关键词" ' + currentRoot() + '/projects/<id>/ ' + currentRoot() + '/docs/ --exclude-dir=archive')
    const reminderTexts = {
      // 知识库没有覆盖项目/文档的总索引（只有记忆有 MEMORY.md），
      // 所以这里不能说「知识库有索引」——那是错误的定位信息。
      // 原来只写「换关键词再搜一次」+「仍无结果再全盘搜索」：既没给检索命令，又把兜底写成并列选项，
      // 等于替它确认全盘扫也行。现在给命令、把全盘限定为「确认库里没有之后」，并加写回闭环。
      global: '全盘扫描开销大。先换关键词用知识库检索再试一次（项目页/文档是中文正文，别名在 frontmatter）：' +
        kbGrep() + '；确认库里确实没有，再全盘搜索，搜完把结论补进知识库（下次不用再扫）。',
      // 索引通常已由插件注入；提醒只在「没看到注入内容」时有意义。
      memory: '任务若涉及记忆（上次说过/项目上下文/偏好/之前配置），记忆只从知识库取：' +
        '上下文里已有「项目记忆 / 父项目记忆 / 全局记忆」三段索引就直接用；' +
        '真的缺了才 read <KB_ROOT>/projects/<id>/memory/MEMORY.md 或 <KB_ROOT>/memory/MEMORY.md。' +
        '不涉及记忆可忽略本提示。',
      web: '若在查本地项目/代码/配置相关问题，先查知识库：' + kbGrep() + '；外部知识查询可忽略本提示。',
    }
    const summaryOf = { global: '提示：本地检索优先用知识库', memory: '记忆先行：用注入的三段记忆索引', web: '提示：本地问题先查知识库' }
    /** 同一类提醒全会话最多 3 次（每轮最多 1 次，靠 agent/pre-step 重置 reminded）。
     *  长会话里前几个任务就用完额度会静默失忆，所以留 3 次给后续任务。 */
    const MAX_REMINDERS_PER_SESSION = 3
    const mayRemind = (st, kind) => !st.reminded[kind] && (st.sent[kind] ?? 0) < MAX_REMINDERS_PER_SESSION
    const noteRemind = (st, kind) => {
      st.reminded[kind] = true
      st.sent[kind] = (st.sent[kind] ?? 0) + 1
    }
    /** 记忆索引本身已每步注入：注入正常时这条提醒是冗余的，只在读不到索引时才补。 */
    const memoryReminderCache = new Map()
    // 用会话 cwd（workingDirectory 服务）判断，而不是插件进程的 cwd：两者在多工作区下不同。
    const memoryIndexInjected = (agent) => {
      try {
        return memoryIndexText({
          kbRoot: currentRoot(),
          cwd: sessionCwd({ agent }) ?? process.cwd(),
          cache: memoryReminderCache,
          maxLines: DEFAULT_INDEX_MAX_LINES,
          maxBytes: DEFAULT_INDEX_MAX_BYTES,
        }).length > 0
      } catch {
        return false
      }
    }
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
              reason: '先查知识库：' + kbGrep() + ' 或 read KB 内文件；KB 未命中再全盘搜索' +
                (st && !st.memoryChecked ? '。涉及记忆先看注入的三段记忆索引（缺了才 read <KB_ROOT>/projects/<id>/memory/MEMORY.md' : '') +
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
          if (!st.kbChecked && mayRemind(st, 'web')) { reminder = await makeReminder(reminderTexts.web, summaryOf.web); noteRemind(st, 'web') }
        } else if (tool === 'bash') {
          const cmd = typeof args?.command === 'string' ? args.command : ''
          if (!touchesKb(cmd) && cmd.length <= MAX_CMD) {
            if (!st.memoryChecked && !memoryIndexInjected(exec.agent) && mayRemind(st, 'memory') && /\b(grep|rg|find)\b/.test(cmd)) {
              reminder = await makeReminder(reminderTexts.memory, summaryOf.memory); noteRemind(st, 'memory')
            } else if (st.kbChecked && isGlobalSearch(cmd, args) && mayRemind(st, 'global')) {
              reminder = await makeReminder(reminderTexts.global, summaryOf.global); noteRemind(st, 'global')
            }
          }
        } else if (tool === 'read') {
          const p = typeof args?.file_path === 'string' ? args.file_path : ''
          if (!touchesKb(p) && !st.memoryChecked && !memoryIndexInjected(exec.agent) && mayRemind(st, 'memory')) {
            reminder = await makeReminder(reminderTexts.memory, summaryOf.memory); noteRemind(st, 'memory')
          }
        }
        // 体检告警回传：写完 KB 后 kb-check 在防抖窗口里跑完，下一次工具调用才拿得到结果。
        // 用告警签名去重：同一组告警只提示一次（修好或换新告警才再提），不制造噪音。
        if (!reminder) {
          const built = buildCheckReminder(
            { status: syncState.state.lastCheckStatus, warns: syncState.state.lastCheckWarns },
            st.checkSig,
          )
          if (built) {
            st.checkSig = built.sig
            reminder = await makeReminder(built.text, CHECK_REMINDER_SUMMARY)
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
      getRoot: currentRoot, setRoot, awaitSync: () => syncChain.catch(() => {}),
      dshHome, syncState, runSync, pluginSettings,
      getCredentials: () => ctx.get('credentials'),
    })
    // 每条路都必须带 requestBody：dsh 靠它决定请求体怎么喂给 handler。
    const routes = [
      { path: API_BASE + '/state', methods: ['GET'], requestBody: 'buffered', fetch: handlers.state },
      { path: API_BASE + '/overview', methods: ['GET'], requestBody: 'buffered', fetch: handlers.overview },
      { path: API_BASE + '/sync', methods: ['POST'], requestBody: 'buffered', fetch: handlers.sync },
      { path: API_BASE + '/test-link', methods: ['POST'], requestBody: 'buffered', fetch: handlers.testLink },
      { path: API_BASE + '/download', methods: ['POST'], requestBody: 'buffered', fetch: handlers.download },
      { path: API_BASE + '/settings', methods: ['POST'], requestBody: 'buffered', fetch: handlers.settings },
      { path: API_BASE + '/relocate/precheck', methods: ['POST'], requestBody: 'buffered', fetch: handlers.relocatePrecheck },
      { path: API_BASE + '/relocate', methods: ['POST'], requestBody: 'buffered', fetch: handlers.relocate },
      { path: API_BASE + '/clear', methods: ['POST'], requestBody: 'buffered', fetch: handlers.clear },
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

/** 迁移结果的简短描述（写日志用）。 */
function describeMigration(migration) {
  const parts = []
  if (migration.skillCopy === 'removed') parts.push('旧技能副本已删除')
  if (migration.agentsBlock === 'removed') parts.push('AGENTS.md 常驻块已摘除')
  if (migration.backup) parts.push('备份：' + migration.backup)
  return parts.join('；') || '无变更'
}


/** 组装设置页 API 的三个 handler（Web Fetch API：Request → Response）。 */
function createApiHandlers({ getRoot, setRoot, awaitSync, dshHome, syncState, runSync, pluginSettings, getCredentials }) {
  /** 每个 handler 开头取一次当前库根：改位置后立刻是新值。 */
  const rootNow = () => getRoot()
  const resolveRefFor = async (ref) => {
    const creds = getCredentials()
    if (!creds || typeof creds.resolve !== 'function') return undefined
    const hit = await creds.resolve(ref)
    return hit && typeof hit.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  }

  return {
    /** GET /api/local-kb/state：设置页打开时读取的位置、凭据回显与同步状态。 */
    state: async () => {
      const kbRoot = rootNow()
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
          // 页面要用统计与警告列表：只回 lastCheckError 会让「记忆 N 条 / 警告」永远是空的。
          lastCheckStats: st.lastCheckStats,
          lastCheckWarns: st.lastCheckWarns,
          relocatePhase: st.relocatePhase || null,
        },
        settings: {
          parent: pluginSettings.parent,
          remoteDir: pluginSettings.remoteDir,
          autoSync: pluginSettings.autoSync,
          provider: pluginSettings.provider,
        },
        installed: await skillInstalled(),
      })
    },

    /** GET /api/local-kb/overview：知识库全貌（项目、文档、记忆用量），只读。 */
    overview: async () => {
      const kbRoot = rootNow()
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
      const kindCache = new Map()
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
        // 四种状态：ok / stale（登记的是别的机器的路径）/ unregistered / remote（远程设备，本就没有本地代码）
        const pathState = projectKind(kbRoot, id, kindCache) === 'ops-project'
          ? 'remote'
          : localPath === undefined
            ? 'unregistered'
            : existsSyncSafe(localPath) ? 'ok' : 'stale'
        projects.push({
          id,
          path: localPath ?? null,
          pathExists: localPath === undefined ? null : pathState === 'ok',
          pathState,
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

    /** POST /api/local-kb/relocate/precheck：只读预检（目标合法性 / 大小 / 拒绝原因）。 */
    relocatePrecheck: async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      const parent = body && typeof body.parent === 'string' ? body.parent : ''
      const pre = await precheckRelocate({ kbRoot: getRoot(), parent })
      return jsonResponse(200, { ok: pre.ok, target: pre.target, blockers: pre.blockers, plan: pre.plan })
    },

    /** POST /api/local-kb/relocate：复制 → 校验 → 切换 → 旧目录改名。 */
    relocate: async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      const parent = body && typeof body.parent === 'string' ? body.parent.trim() : ''
      if (parent === '') return jsonResponse(200, { ok: false, code: 'BAD_REQUEST', blockers: ['缺少目标父目录'] })
      // 正在同步就先等它收尾，避免边搬边传。
      await awaitSync()
      const current = getRoot()
      const phase = (name) => { void syncState.record({ relocatePhase: name }) }
      phase('copying')
      const copy = await relocateCopy({ kbRoot: current, parent, onPhase: phase })
      if (!copy.ok) {
        void syncState.record({ relocatePhase: null })
        return jsonResponse(200, { ok: false, ...copy })
      }

      // 切换：写设置 → 换内存根
      phase('switching')
      const next = savePluginSettings(dshHome, { parent })
      if (next.parent === null) {
        return jsonResponse(200, { ok: false, code: 'SETTINGS_FAILED', target: copy.target })
      }
      Object.assign(pluginSettings, next)
      await setRoot(copy.target)

      // 收尾：旧库改名保留。失败只是没改名，库已在新位置可用。
      phase('renaming')
      let legacyDir = null
      try {
        const candidate = legacyDirOf(current)
        await rename(current, candidate)
        legacyDir = candidate
      } catch {
        legacyDir = null
      }
      void syncState.record({ relocatePhase: null })
      return jsonResponse(200, { ok: true, kbRoot: copy.target, legacyDir, plan: copy.plan })
    },

    /** POST /api/local-kb/settings：保存远端根目录、自动同步开关、服务商标识。 */
    settings: async (request) => {
      let body = {}
      try {
        body = await request.json()
      } catch {
        body = {}
      }
      if (body === null || typeof body !== 'object') body = {}
      const next = savePluginSettings(dshHome, body)
      Object.assign(pluginSettings, next)
      return jsonResponse(200, { ok: true, settings: next })
    },

    /** POST /api/local-kb/clear：清除 WebDAV 凭据并恢复默认设置。 */
    clear: async () => {
      const creds = getCredentials()
      const cleared = []
      for (const ref of [CRED_URL_REF, CRED_USER_REF, CRED_PASSWORD_REF]) {
        try {
          if (typeof creds?.unset === 'function') {
            await creds.unset(ref)
            cleared.push(ref)
          }
        } catch {
          // 凭据不存在或服务不可用：忽略，页面仍显示已清空
        }
      }
      const next = savePluginSettings(dshHome, {
        remoteDir: REMOTE_SYNC_DIR,
        autoSync: pluginSettings.autoSync,
        provider: 'custom',
      })
      Object.assign(pluginSettings, next)
      await syncState.record({ lastSyncStatus: null, lastError: null, lastSyncAt: null, lastTrigger: null })
      return jsonResponse(200, { ok: true, cleared, settings: next })
    },

    /** POST /api/local-kb/sync：上传（本地覆盖云端，远端多余文件删除）。 */
    sync: async () => {
      const result = await runSync({ trigger: 'manual' })
      return jsonResponse(200, { ok: result.ok, ...result })
    },

    /** POST /api/local-kb/download：从云端下载，覆盖本地同名文件（本地多余文件保留）。 */
    download: async () => {
      const kbRoot = rootNow()
      const url = await resolveRefFor(CRED_URL_REF)
      if (!url) return jsonResponse(200, { ok: false, reason: '未配置 WebDAV 链接' })
      const user = (await resolveRefFor(CRED_USER_REF)) || ''
      const password = (await resolveRefFor(CRED_PASSWORD_REF)) || ''
      try {
        const result = await downloadRoot({ kbRoot, url, user, password, remoteDir: pluginSettings.remoteDir })
        // 下载后本地 mtime 全变了：重建基准，否则下次上传会把所有文件重推一遍
        await syncState.saveFileMap(await rebuildFileMap(kbRoot))
        await syncState.record({
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: result.failed.length === 0 ? 'ok' : 'failed',
          lastError: result.failed.length === 0 ? null : result.failed.length + ' 个文件下载失败',
          lastTrigger: 'download',
          syncedFiles: result.written.length,
          deletedFiles: 0,
          remoteDir: pluginSettings.remoteDir,
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

/** 技能是否可用：只看包内那份（bundledSkillDir 加载的就是它），没有回退路径。 */
async function skillInstalled() {
  try {
    await access(join(skillDir(), 'SKILL.md'), FS.F_OK)
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
  '上下文已用到约 60% 窗口。如果这个任务还没做完，先把恢复点写下来再继续：\n' +
  '1. 写或更新一条 \`status: active\` 的 \`project\` 记忆：目标 / 当前状态 / 阻塞 / 下一步（相对时间转绝对日期）。\n' +
  '   已有 active 就地更新，不要新建第二条。\n' +
  '2. 在所属 MEMORY.md 的指针行前加 \`⚡\`。\n' +
  '3. 跑技能里的 \`tools/kb-check.py\`（路径相对技能目录）。\n' +
  '任务已经做完、或本来就只是一问一答：跳过，不用写。\n' +
  '⚡ 只是恢复锚点，不是「只看这一条」：其余记忆照常按钩子取舍。'

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

/* =========================================================================
 * 体检告警回传（闭环）
 * -------------------------------------------------------------------------
 * 写入 KB 后插件会跑 kb-check，但结果历史上只落设置页状态（runKbCheck → syncState），
 * 模型自己看不到 —— 同一个坑会反复复发。这里把「最近一次告警」做成一条提醒注入上下文，
 * 用告警文本签名去重：同一组告警只说一次，修好或换新告警才重新提示。
 * ======================================================================= */
export const CHECK_REMINDER_SUMMARY = '提示：知识库体检有警告，按提示修'

/** 纯函数（供单测）：给定最近一次体检结果与已提示签名，返回 { text, sig } 或 null。 */
export function buildCheckReminder(lastCheck = {}, seenSig) {
  const status = lastCheck?.status
  if (status !== 'warn' && status !== 'failed') return null
  const warns = Array.isArray(lastCheck?.warns)
    ? lastCheck.warns.filter((w) => typeof w === 'string' && w.trim() !== '')
    : []
  if (warns.length === 0) return null
  const sig = status + '\n' + warns.join('\n')
  if (sig === seenSig) return null
  const head = status === 'failed' ? '知识库体检有错误' : '知识库体检有警告'
  const lines = warns.slice(0, 2).map((w) => '· ' + w).join('\n')
  return {
    text: head + '（最近一次 kb-check，来自你写过或改过的知识库）：\n' + lines + '\n' +
      '按提示修：补 frontmatter / 把索引钩子改到 ≤24 字 / 给进度段加 `> 截至 YYYY-MM-DD：…`；' +
      '改完跑技能里的 `tools/kb-check.py` 确认。与本任务无关可忽略本提示。',
    sig,
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

/** 重新扫描本地文件，重建同步基准（下载后本地 mtime 全变了）。 */
async function rebuildFileMap(kbRoot) {
  const files = await listFiles(kbRoot)
  const map = new Map()
  for (const rel of files) {
    try {
      const info = await stat(join(kbRoot, rel))
      map.set(rel, { mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // 并发删除的文件跳过
    }
  }
  return map
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


