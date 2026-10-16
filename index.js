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
import { constants as FS } from 'node:fs'
import { readFileSync } from 'node:fs'
import { access, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import http from 'node:http'
import https from 'node:https'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { installSkill, SKILL_NAME } from './install-skill.js'

export const name = 'local-kb'

// `tools` 是唯一硬依赖：写入钩子必须能确权。skills/credentials/webServer 都是可选服务，
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
  lastCheckAt: null,     // kb-check.py 最近一次运行时间（技能铁律：写入后必校验）
  lastCheckStatus: null, // 'ok' | 'warn' | 'failed' | null
  lastCheckError: null,  // 校验输出的错误行
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

/** 判断 path 是否在 root 内（解析后前缀比较）。 */
export function isInside(root, path) {
  const r = resolve(root)
  const p = resolve(path)
  return p === r || p.startsWith(r + sep)
}

/* =========================================================================
 * 同步状态（内存单例 + 磁盘备份，设置页可查）
 * ======================================================================= */
class SyncState {
  constructor(kbRoot) {
    this.kbRoot = kbRoot
    this.state = { ...SYNC_STATE_DEFAULT }
    this.file = join(kbRoot, SYNC_STATE_FILENAME)
    this.ready = this.load()
  }
  async load() {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.state = { ...SYNC_STATE_DEFAULT, ...parsed }
    } catch {
      // 无状态文件 = 从未同步，保持默认
    }
  }
  snapshot() {
    return { ...this.state }
  }
  async record(patch) {
    this.state = { ...this.state, ...patch }
    const tmp = this.file + '.tmp'
    try {
      await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
      await import('node:fs/promises').then(({ rename }) => rename(tmp, this.file))
    } catch {
      // 状态写盘失败不影响功能 —— 下次有 sync 再试
    }
  }
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
export async function syncRoot({ kbRoot, url, user, password, state }) {
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

  const files = await listFiles(kbRoot)
  const previous = new Map(Object.entries((state && state.fileMap) || {}))
  const now = new Map()
  const pushed = []

  // 阶段一：扫描对比（无 I/O 网络），找出需要上传的文件
  const pending = []
  for (const abs of files) {
    const rel = relative(kbRoot, abs).split(sep).join('/')
    if (rel === SYNC_STATE_FILENAME) continue // 状态文件本身不同步
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

  return { pushed, total: files.length, fileMap: Object.fromEntries(now) }
}

/** 递归列出 KB_ROOT 下所有文件（忽略目录、符号链接）。 */
async function listFiles(root) {
  const out = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(full)
    }
  }
  await walk(root)
  return out
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
        content: skillBody,
      }))
    })
  }

  // ---- 写入即同步 hook：tools/result 监听（核心） ----
  const syncState = new SyncState(kbRoot)
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
    const result = await runKbCheckProcess(python, script, kbRoot)
    const status = result.code === 0 ? 'ok' : result.code === 2 ? 'warn' : 'failed'
    if (status === 'ok') {
      await syncState.record({ lastCheckAt: at, lastCheckStatus: status, lastCheckError: null })
    } else {
      // warn/failed：把脚本错误输出行记录进状态（供设置页提示）
      const lines = (result.out || '').split('\n').filter((l) => l && !/^kb-check @/.test(l) && !/记忆目录/.test(l) && !/文档/.test(l) && !/=====/.test(l))
      await syncState.record({ lastCheckAt: at, lastCheckStatus: status, lastCheckError: lines.slice(0, 5).join('\n') })
    }
    return { status, at }
  } catch {
    // spawn 失败（python 缺失/超时）：记为工具不可用，不影响同步与对话
    await syncState.record({ lastCheckAt: at, lastCheckStatus: 'no-python', lastCheckError: null })
    return { status: 'no-python', at }
  }
}

/** spawn 跑 kb-check，返回 { code, out }。超时/spawn 错误 reject。 */
function runKbCheckProcess(python, script, kbRoot) {
  return new Promise((resolvePromise, rejectPromise) => {
    let out = ''
    let settled = false
    const child = spawn(python, [script, kbRoot], { timeout: 60000 })
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
      const result = await syncRoot({ kbRoot, url, user, password, state: syncState.state })
      await syncState.record({
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: 'ok',
        lastError: null,
        lastTrigger: trigger,
        syncedFiles: result.pushed.length,
        fileMap: result.fileMap,
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
      } else if (tool === 'bash' && typeof args.command === 'string' && args.command.includes(kbRoot)) {
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

  // ---- KB-first 硬拦截 hook：tools/pre-execute 在工具调用前拦截全局搜索 ----
  // 确定性工具名匹配（不是猜用户意图）：模型要调用全局搜索工具（bash 全局 grep /
  // web_search / web_fetch / codegraph / read）时先拦下，强制先 grep 知识库。
  // kbRoot 动态解析（KB_ROOT 环境变量优先，默认 ~/.local-kb），跨设备不用写死路径。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = exec.name
    if (!['bash', 'web_search', 'web_fetch', 'codegraph', 'read'].includes(tool)) return next()
    if (tool === 'bash') {
      const cmd = typeof exec.arguments?.command === 'string' ? exec.arguments.command : ''
      // 查 KB 本身 → 放行（含 kbRoot 绝对路径或 ~/.local-kb 缩写）
      if (cmd.includes(kbRoot) || /\.local-kb/.test(cmd)) return next()
      // 全局搜索型命令（grep/rg/find/cat/sed/head/tail/ls）→ 拦
      if (/\b(grep|rg|find|cat|sed|head|tail|ls)\b/.test(cmd)) {
        return { kind: 'deny', reason: '先查知识库：grep ' + kbRoot + '/projects/*/*.md 与 docs/；KB 未命中才能搜索源项目' }
      }
      return next()
    }
    // web_search / web_fetch / codegraph / read → 拦（这些必然全局搜索）
    return { kind: 'deny', reason: '先查知识库：grep ' + kbRoot + '/projects/*/*.md 与 docs/；KB 未命中才能搜索源项目或网络' }
  }, { prepend: true })

  // ---- 设置页 HTTP API（静态插件的 Client↔Host 通道：webServer 路由 + fetch） ----
  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => {
      const handler = createApiHandler({
        kbRoot, dshHome, syncState, runSync, getCredentials: () => ctx.get('credentials'),
      })
      for (const sub of ['', '/state', '/sync', '/test-link']) {
        scope.webServer.register({ kind: 'exact', path: API_BASE + sub, handler })
      }
      return () => {}
    }, 'local-kb: http-api')
  })

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

/** 组装设置页 HTTP handler。 */
function createApiHandler({ kbRoot, dshHome, syncState, runSync, getCredentials }) {
  const resolveRefFor = async (ref) => {
    const creds = getCredentials()
    if (!creds || typeof creds.resolve !== 'function') return undefined
    const hit = await creds.resolve(ref)
    return hit && typeof hit.value === 'string' && hit.value.length > 0 ? hit.value : undefined
  }
  return async (req, res) => {
    // exact 路由直接命中本 handler（绕过 connection 的 /api prefix 围栏，同 turn-undo）。
    const url = new URL(req.url, 'http://local')
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (req.method === 'GET' && (pathname === API_BASE || pathname === API_BASE + '/state')) {
        // message 级状态（时间/结果/错误）返回；fileMap 只在插件内部作增量基准，
        // 体积大且 client 不需要（状态已持久化到 .kb-sync-state.json）。
        const st = syncState.snapshot()
        // 回显已存凭据（URL/用户名可见；密码永不回显——describe 不返回值是安全设计）。
        // host 能 resolve 拿值，client 打开设置页时据此回填输入框。
        const storedUrl = await resolveRefFor(CRED_URL_REF)
        const storedUser = (await resolveRefFor(CRED_USER_REF)) || ''
        json(res, 200, {
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
        return
      }
      if (req.method === 'POST' && pathname === API_BASE + '/sync') {
        const result = await runSync({ trigger: 'manual' })
        json(res, 200, { ok: result.ok, ...result })
        return
      }
      if (req.method === 'POST' && pathname === API_BASE + '/test-link') {
        const body = await readBody(req).catch(() => ({}))
        // 表单里的空串（用户没填/没动密码框）一律回退已存凭据 —— 空密码绝不能
        // 覆盖已存密码去测试。未保存的改动可先测：非空字段用表单值。
        const url = (typeof body.url === 'string' && body.url.trim() !== '') ? body.url.trim() : (await resolveRefFor(CRED_URL_REF))
        const user = (typeof body.user === 'string' && body.user.trim() !== '') ? body.user.trim() : ((await resolveRefFor(CRED_USER_REF)) || '')
        const password = (typeof body.password === 'string' && body.password !== '') ? body.password : ((await resolveRefFor(CRED_PASSWORD_REF)) || '')
        const result = await testLink({ url, user, password })
        json(res, 200, result)
        return
      }
      json(res, 404, { ok: false, reason: 'not found' })
    } catch (error) {
      json(res, 500, { ok: false, reason: error instanceof Error ? error.message : String(error) })
    }
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

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolvePromise(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value) + '\n')
}
