/**
 * install-skill.js — materialise the FULL local-kb skill into dsh's user skill
 * library at activation time, and append its always-on rules block (the
 * KB_LOCAL section from references/agents-snippet.md) to `$DSH_HOME/AGENTS.md`.
 *
 * DEPRECATED（0.4.0 起）：技能改由 `bundledSkillDir` 直接加载，常驻规则走
 * systemPrompt.context，本文件只在 `installSkill: true` 显式开启时兜底（老 DSH 无
 * bundledSkillDir 时）。它的删除/清理能力仍然被 migrate.js 复用。
 *
 * 机制：
 *
 *  - dsh's filesystem skill provider scans `$DSH_HOME/skills/` as its user skill
 *    root, discovering one skill per subdirectory that carries a valid SKILL.md.
 *  - The plugin ships a byte-identical copy of the whole local-kb skill in
 *    `./skills/local-kb/` (SKILL.md + references/ + tools/) and — on apply() — ensures that
 *    copy is present at `$DSH_HOME/skills/local-kb/`.
 *  - It also appends `./skills/local-kb/references/agents-snippet.md` to
 *    `$DSH_HOME/AGENTS.md` so the always-on KB_LOCAL rules are loaded by dsh for
 *    every session. The append is idempotent: if the block is already present,
 *    nothing is added.
 *
 * Hard constraint (user): the local-kb SKILL content is NEVER modified — it is
 * shared with other tools outside DSH. We install a copy, we do not touch
 * `~/.dsh/skills/local-kb` (the user-maintained source), and we never rewrite a
 * file under the destination except payload files that differ from the bundled
 * version.
 *
 * Idempotence, not clobbering:
 *  - A `.skill-version` marker (SHA-256 of SKILL.md) is compared first. An
 *    identical marker means "already installed at this version" and the whole
 *    sync is skipped.
 *  - Only files that are part of the payload are ever written. Files the user
 *    layered into the destination that are NOT in the payload are left alone.
 *  - Missing or unreadable destination roots are created; an unwritable root
 *    returns an error instead of throwing out of apply().
 *  - The AGENTS.md rules block is appended once when missing, and refreshed in
 *    place whenever the payload version changes. It never touches content
 *    outside its start/end markers.
 *
 * Zero dependencies, plain ESM, node: builtins only — same ethos as index.js.
 */
import { createHash } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { lstatSync, realpathSync } from 'node:fs'
import { access, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'local-kb'
export const VERSION_FILENAME = '.skill-version'
/** 曾经在 payload 里、现在已删除或改名的文件：同步时从目标目录清掉。
 *  不通用删除（会误删用户自己加的文件），只维护这份精确清单。 */
export const OBSOLETE_PAYLOAD = ['references/doc-archive.md']
export const RULES_SNIPPET = 'references/agents-snippet.md'
export const AGENTS_FILENAME = 'AGENTS.md'
export const AGENTS_MARKER_START = '<!-- KB_LOCAL_START -->'
export const AGENTS_MARKER_END = '<!-- KB_LOCAL_END -->'

/** Resolve `$DSH_HOME`, mirroring dsh's `resolveDshHome`: env wins, else `~/.dsh`. */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

/** The directory the bundled payload ships from. 0.4.0 起是 `./skills/local-kb`（跟 DSH 技能根布局一致）。 */
export function defaultPayloadDir(moduleUrl = import.meta.url) {
  return join(dirname(fileURLToPath(moduleUrl)), 'skills', 'local-kb')
}

/* Reconciliation outcome summary. */
function outcome(status, dest, detail = '') {
  return detail === '' ? { status, dest } : { status, dest, detail }
}

/**
 * Ensure the full skill is installed at `$DSH_HOME/skills/local-kb/`, and that
 * the rules snippet from the payload is present in `$DSH_HOME/AGENTS.md`.
 *
 * @param opts -
 *   - payloadDir:  bundled skill tree to install from (default: ./skill).
 *   - dshHome:     resolved `$DSH_HOME` (default: resolveDshHome()).
 *   - env:         environment used only to build the default dshHome.
 *   - appendRules: set `false` to skip appending `agents-snippet.md` to AGENTS.md.
 * @returns a settled result; never throws for routine filesystem conditions.
 */

export async function installSkill(opts = {}) {
  const dshHome = opts.dshHome ?? resolveDshHome(opts.env)
  const payloadDir = resolve(opts.payloadDir ?? defaultPayloadDir())
  const dest = resolve(join(dshHome, 'skills', SKILL_NAME))
  if (opts.payloadDir === undefined) {
    try {
      await access(payloadDir, FS.F_OK)
    } catch {
      return outcome('skipped', dest, 'no bundled skill payload')
    }
  }

  try {
    await mkdir(dest, { recursive: true })
  } catch (error) {
    return outcome('error', dest, errorMessage(error))
  }

  const payloadFiles = await listTree(payloadDir).catch((error) => ({ error }))
  if (Array.isArray(payloadFiles) && payloadFiles.length === 0) {
    return outcome('skipped', dest, 'bundled skill payload is empty')
  }
  if (!Array.isArray(payloadFiles)) {
    return outcome('error', dest, errorMessage(payloadFiles.error))
  }

  // 有就覆盖，保持最新：逐文件比对 payload 与目标，内容不同才写。
  // 目标若是软链（例如 skills/local-kb -> cc-switch 的共享技能库），写入会跟随
  // 到真实目录 —— 这是预期行为，结果里如实报告真实路径。
  let symlink = false
  try {
    symlink = lstatSync(dest).isSymbolicLink()
  } catch {
    symlink = false
  }

  const changed = []
  for (const src of payloadFiles) {
    const rel = relative(payloadDir, src)
    const target = join(dest, rel)
    const next = await readFile(src)
    let current
    try {
      current = await readFile(target)
    } catch {
      current = undefined
    }
    if (current !== undefined && current.equals(next)) continue
    changed.push({ rel, target, next })
  }

  const agentsPath = resolve(join(dshHome, AGENTS_FILENAME))
  const blockPlan = opts.appendRules === false
    ? { status: 'skipped', path: agentsPath, detail: 'appendRules is false' }
    : await planRulesBlock(agentsPath, payloadDir)

  // 任一将要变化才备份：只保留一份，先清空再写，不散落 .kb-bak 文件。
  let backup
  if (changed.length > 0 || blockPlan.status === 'update') {
    backup = await backupBefore(dshHome, dest, agentsPath)
  }

  for (const item of changed) {
    try {
      await mkdir(dirname(item.target), { recursive: true })
      await writeFile(item.target, item.next)
    } catch (error) {
      return outcome('error', dest, `write ${item.rel} failed: ${errorMessage(error)}`)
    }
  }

  // 清理已废弃/改名的 payload 文件：否则副本里会同时存在新旧两份协议，
  // AI 只按 SKILL.md 的指向读新的，旧文件留着迟早被误读。
  const removed = []
  for (const rel of OBSOLETE_PAYLOAD) {
    const target = join(dest, rel)
    try {
      await unlink(target)
      removed.push(rel)
    } catch {
      // 不存在就是已经干净
    }
  }

  // 版本标记：SKILL.md 的 SHA-256。上面注释承诺过这个标记，早前实现漏了写。
  let version = 'unchanged'
  try {
    const body = await readFile(join(payloadDir, 'SKILL.md'))
    const digest = createHash('sha256').update(body).digest('hex')
    const versionPath = join(dest, VERSION_FILENAME)
    let current = ''
    try {
      current = (await readFile(versionPath, 'utf8')).trim()
    } catch {
      current = ''
    }
    if (current !== digest) {
      await writeFile(versionPath, digest + '\n')
      version = 'updated'
    }
  } catch {
    version = 'skipped'
  }

  const agentsResult = blockPlan.status === 'update'
    ? await applyRulesBlock(blockPlan)
    : blockPlan

  const status = changed.length === 0 && removed.length === 0 && version === 'unchanged'
    && agentsResult.status !== 'update'
    ? 'present'
    : 'installed'
  return {
    ...outcome(status, dest),
    changed: changed.length,
    ...(removed.length === 0 ? {} : { removed }),
    version,
    ...(backup === undefined ? {} : { backup }),
    ...(symlink ? { symlinkTarget: realpathOf(dest) } : {}),
    agents: agentsResult,
  }
}

/**
 * 计算 AGENTS.md 的常驻块要怎么改：没有就追加，有就用 payload 覆盖标记之间。
 * 只做计划，不写盘 —— installSkill 需要在写之前统一备份一次。
 */
async function planRulesBlock(agentsPath, payloadDir) {
  const snippetPath = resolve(join(payloadDir, RULES_SNIPPET))

  let snippet
  try {
    snippet = await readFile(snippetPath, 'utf8')
  } catch (error) {
    return { status: 'skipped', path: agentsPath, detail: `no ${RULES_SNIPPET} in payload: ${errorMessage(error)}` }
  }

  const block = snippet.trim()
  if (block === '') {
    return { status: 'skipped', path: agentsPath, detail: `${RULES_SNIPPET} is empty` }
  }
  if (!block.includes(AGENTS_MARKER_START) || !block.includes(AGENTS_MARKER_END)) {
    return {
      status: 'error',
      path: agentsPath,
      detail: `${RULES_SNIPPET} must carry ${AGENTS_MARKER_START} and ${AGENTS_MARKER_END}`,
    }
  }

  let current = ''
  let currentExists = false
  try {
    current = await readFile(agentsPath, 'utf8')
    currentExists = true
  } catch {
    current = ''
  }

  const startAt = current.indexOf(AGENTS_MARKER_START)
  if (startAt === -1) return { status: 'append', path: agentsPath, current, currentExists, block }

  const endAt = current.indexOf(AGENTS_MARKER_END, startAt)
  if (endAt === -1) {
    // 只有开头没有结尾：不猜，交给用户
    return { status: 'error', path: agentsPath, detail: `${AGENTS_MARKER_START} 没有对应的 ${AGENTS_MARKER_END}` }
  }
  const existing = current.slice(startAt, endAt + AGENTS_MARKER_END.length)
  // 有就覆盖：内容一致才跳过，否则用 payload 替换标记之间（块外不动）。
  if (existing.trim() === block) return { status: 'present', path: agentsPath }
  return { status: 'update', path: agentsPath, current, startAt, endAt, block }
}

/** 执行 planRulesBlock 的结果。 */
async function applyRulesBlock(plan) {
  if (plan.status === 'append') {
    const prefix = plan.currentExists && !plan.current.endsWith('\n') ? '\n\n' : plan.currentExists ? '\n' : ''
    try {
      await writeFile(plan.path, `${plan.current}${prefix}${plan.block}\n`, 'utf8')
    } catch (error) {
      return { status: 'error', path: plan.path, detail: errorMessage(error) }
    }
    return { status: 'appended', path: plan.path }
  }
  if (plan.status === 'update') {
    const next = plan.current.slice(0, plan.startAt) + plan.block + plan.current.slice(plan.endAt + AGENTS_MARKER_END.length)
    try {
      await writeFile(plan.path, next, 'utf8')
    } catch (error) {
      return { status: 'error', path: plan.path, detail: errorMessage(error) }
    }
    return { status: 'updated', path: plan.path }
  }
  return plan
}

/**
 * 覆盖前的备份：清空后写一份，只保留这一次（不散落 .kb-bak 文件）。
 * 放在 $DSH_HOME/local-kb/backups/。
 */
async function backupBefore(dshHome, dest, agentsPath) {
  const root = join(dshHome, 'local-kb', 'backups')
  try {
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { recursive: true })
  } catch {
    return undefined
  }
  try {
    if (dest !== undefined) {
      // 备份只留插件装的东西：系统垃圾与其他工具产物不进备份目录
      const files = (await listTree(dest).catch(() => []))
        .filter((file) => !/\.DS_Store$|__pycache__|.kb-bak-|\.pyc$/.test(file))
      for (const file of files) {
        const rel = relative(dest, file)
        const target = join(root, 'skills', rel)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, await readFile(file))
      }
    }
    if (agentsPath !== undefined) {
      try {
        await writeFile(join(root, AGENTS_FILENAME), await readFile(agentsPath))
      } catch {
        // 还没有 AGENTS.md：没什么可备份
      }
    }
    return root
  } catch {
    return undefined
  }
}

/** 软链的真实路径（报告用，失败返回原路径）。 */
function realpathOf(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Sync `references/agents-snippet.md` from the payload into `$DSH_HOME/AGENTS.md`.
 *
 * 有就覆盖：块存在且内容不同就替换标记之间，块外一行不动；内容相同则跳过。
 * 直接调用时会自己备份一次；installSkill 会先统一备份，再跳过这里。
 */
export async function appendRulesToAgents(dshHome, payloadDir, opts = {}) {
  const agentsPath = resolve(join(dshHome, AGENTS_FILENAME))
  const plan = await planRulesBlock(agentsPath, payloadDir)
  if (plan.status !== 'update' && plan.status !== 'append') return plan
  if (opts.skipBackup !== true) await backupBefore(dshHome, undefined, agentsPath)
  return applyRulesBlock(plan)
}

/** Copy every file+dir inside `src` into `dst`, creating parent dirs as needed. */
async function copyPayload(src, dst) {
  const entries = await listTree(src)
  try {
    for (const entry of entries) {
      const target = join(dst, relative(src, entry))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await readFile(entry))
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/** List all files under `root` (directories walked, symlinks ignored). */
/** payload 里的运行期垃圾：python 跑一次就生成 .pyc，不同解释器版本内容还不同，
 *  不排除的话每次 installSkill 都会判成「有变化」并把 pyc 同步进技能库。 */
const SKIP_TREE = /(^|\/)(__pycache__|node_modules|\.git)(\/|$)|(\.pyc|\.DS_Store|\.skill-version)$/
// `.skill-version` 是安装产物，不该出现在 payload 里；一并排除，防止它自己成为「每次都在变」的文件。

async function listTree(root) {
  const files = []
  const walk = async (dir) => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (SKIP_TREE.test(full)) continue
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  await walk(root)
  return files
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 从 .credentials.yaml 里删掉本插件的三个 ref，先备份原文件。 */
async function removeWebdavCredentials(dshHome) {
  const file = join(dshHome, '.credentials.yaml')
  const keys = ['dsh_local_kb_webdav_url', 'dsh_local_kb_webdav_user', 'dsh_local_kb_webdav_password']
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { removed: 0 }
  }
  const lines = text.split('\n')
  const kept = lines.filter((line) => !keys.some((key) => new RegExp('^\\s*' + key + ':').test(line)))
  if (kept.length === lines.length) return { removed: 0 }
  const backup = file + '.local-kb-bak'
  try {
    await writeFile(backup, text, { mode: 0o600 })
    await writeFile(file, kept.join('\n'), 'utf8')
    return { removed: lines.length - kept.length, backup }
  } catch (error) {
    return { removed: 0, error: errorMessage(error) }
  }
}

/**
 * 卸载：撤掉插件留在用户目录里的**全部**产物。
 *
 * 删：技能副本（软链只解链接，不动目标）、AGENTS.md 的 KB_LOCAL 块、
 *     WebDAV 凭据、插件设置/同步状态/备份目录。
 * 不删：知识库目录（`$KB_ROOT`），那是用户数据。
 *
 * 这是**用户主动运行**的操作（`node install-skill.js --uninstall`）。插件被
 * `dsh plugin remove` 移除后代码不再运行，没有自动钩子，只能靠这条命令收尾。
 */
export async function uninstallSkill(opts = {}) {
  const dshHome = resolveDshHome(opts.env ?? process.env)
  const skillsRoot = resolve(join(dshHome, 'skills'))
  const dest = resolve(join(skillsRoot, SKILL_NAME))
  const removed = []
  const notes = []

  // 只删自己装的那一个目录，且必须真的落在 skills/ 下面。
  // 目标是软链时只解链接：它可能指向 cc-switch 之类被其他工具共用的技能库。
  if (dest !== skillsRoot && dest.startsWith(skillsRoot + sep)) {
    try {
      const info = lstatSync(dest)
      if (info.isSymbolicLink()) {
        await unlink(dest)
        removed.push(`${dest}（软链，仅解链接，目标保留）`)
      } else if (info.isDirectory()) {
        await rm(dest, { recursive: true, force: true })
        removed.push(dest)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') notes.push(`技能副本删除失败：${errorMessage(error)}`)
    }
  }

  const agentsPath = resolve(join(dshHome, AGENTS_FILENAME))
  let current
  try {
    current = await readFile(agentsPath, 'utf8')
  } catch {
    current = undefined
  }
  if (current === undefined) {
    notes.push(`${AGENTS_FILENAME} 不存在，无需处理`)
  } else {
    const start = current.indexOf(AGENTS_MARKER_START)
    const end = current.indexOf(AGENTS_MARKER_END)
    if (start !== -1 && end > start) {
      const before = current.slice(0, start).replace(/\s+$/, '')
      const after = current.slice(end + AGENTS_MARKER_END.length).replace(/^\s+/, '')
      const next = [before, after].filter(Boolean).join('\n\n')
      try {
        await writeFile(agentsPath, next === '' ? '' : next + '\n', 'utf8')
        removed.push(`${agentsPath} 的 KB_LOCAL 块`)
      } catch (error) {
        notes.push(`${AGENTS_FILENAME} 清理失败：${errorMessage(error)}`)
      }
    } else {
      notes.push(`${AGENTS_FILENAME} 里没有 KB_LOCAL 块`)
    }
  }

  // WebDAV 凭据：卸载就该清掉，删前备份原文件（0600）
  const creds = await removeWebdavCredentials(dshHome)
  if (creds.error !== undefined) {
    notes.push(`凭据清理失败：${creds.error}`)
  } else if (creds.removed > 0) {
    removed.push(`WebDAV 凭据 ${creds.removed} 项（备份：${creds.backup}）`)
  } else {
    notes.push('没有找到本插件的 WebDAV 凭据')
  }

  // 插件运行状态：设置、同步基准分片、覆盖前备份
  const stateDir = join(dshHome, 'local-kb')
  try {
    await access(stateDir, FS.F_OK)
    await rm(stateDir, { recursive: true, force: true })
    removed.push(stateDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') notes.push(`插件状态目录删除失败：${errorMessage(error)}`)
  }

  notes.push('知识库目录（$KB_ROOT，默认 ~/.local-kb）未删除：那是你的数据，需要时手动处理')
  return { removed, notes }
}

// 直接运行：node install-skill.js [--uninstall]
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const result = process.argv.includes('--uninstall')
    ? await uninstallSkill()
    : await installSkill()
  console.log(JSON.stringify(result, null, 2))
}
