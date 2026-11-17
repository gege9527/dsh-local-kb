/**
 * migrate.js — 把旧的「复制技能副本 + 写 AGENTS.md 常驻块」安装方式迁掉。
 *
 * 旧方式（<= 0.3.x）：
 *   - 技能整份复制到 `$DSH_HOME/skills/local-kb/`（用户技能根，rank 400）
 *   - 常驻规则块追加到 `$DSH_HOME/AGENTS.md`
 *
 * 新方式（>= 0.4.0）：
 *   - 技能由 `bundledSkillDir` 直接从包内加载（bundled rank 600）
 *   - 常驻规则走 `systemPrompt.context`，随插件卸载自动注销
 *
 * 为什么必须迁移：技能根 rank 数字小的赢（user-dsh 400 < bundled 600），
 * 旧副本不删就会**压住**新技能 —— 升级后加载的还是旧版本。
 *
 * 安全约束（与 install-skill.js 同一套）：
 *   - 只删插件自己写过的东西：技能目录必须带 `.skill-version` 标记；没有标记
 *     视为用户手工目录，保留并报告冲突。
 *   - 删前先备份到 `$DSH_HOME/.local-kb-legacy-backup/<时间戳>/`。
 *   - 目标是软链时只解链接，不跟随删除真实目录。
 *   - AGENTS.md 只动 `KB_LOCAL_START/END` 标记之间，块外内容一字不改。
 *   - 全程同步、零依赖、绝不抛：迁移失败不影响插件启动。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'

import {
  AGENTS_FILENAME,
  AGENTS_MARKER_END,
  AGENTS_MARKER_START,
  SKILL_NAME,
  VERSION_FILENAME,
  resolveDshHome,
} from './install-skill.js'

/** 旧产物备份根：删前留一份，用户随时能手工还原。 */
export const LEGACY_BACKUP_DIR = '.local-kb-legacy-backup'

/** 从 AGENTS.md 正文里摘掉 KB_LOCAL 块（含标记行）。块外文本原样保留。 */
export function stripAgentsBlock(current) {
  const text = typeof current === 'string' ? current : ''
  const start = text.indexOf(AGENTS_MARKER_START)
  if (start === -1) return { text, removed: false }
  const end = text.indexOf(AGENTS_MARKER_END, start)
  if (end === -1) return { text, removed: false } // 半个标记：不认识就不动
  const before = text.slice(0, start).replace(/\s+$/, '')
  const after = text.slice(end + AGENTS_MARKER_END.length).replace(/^\s+/, '')
  return { text: [before, after].filter(Boolean).join('\n\n'), removed: true }
}

const outcome = (skillCopy, agentsBlock, extra = {}) => ({
  skillCopy,
  agentsBlock,
  backup: null,
  conflict: null,
  ...extra,
})

/**
 * 执行一次迁移。幂等：没有旧产物时是几次 stat，不改任何文件。
 *
 * @param opts - dshHome: 已解析的 `$DSH_HOME`；now: 备份目录名用的时间戳（测试注入）。
 * @returns `{ skillCopy, agentsBlock, backup, conflict }`，值域：
 *   absent | removed | kept | conflict | error
 */
export function migrateLegacyInstall(opts = {}) {
  let dshHome
  try {
    dshHome = resolve(opts.dshHome ?? resolveDshHome(opts.env))
  } catch {
    return outcome('error', 'error')
  }

  const result = outcome('absent', 'absent')

  // ---- 1. 旧技能副本 ----
  const skillsRoot = resolve(join(dshHome, 'skills'))
  const dest = resolve(join(skillsRoot, SKILL_NAME))
  // 只认 `skills/` 下的那一个目录；软链目标是用户共享库时只解链接。
  if (dest !== skillsRoot && dest.startsWith(skillsRoot + sep) && existsSync(dest)) {
    try {
      const info = lstatSync(dest)
      if (info.isSymbolicLink()) {
        unlinkSync(dest)
        result.skillCopy = 'removed'
      } else if (info.isDirectory()) {
        if (existsSync(join(dest, VERSION_FILENAME))) {
          result.backup = backupSkillCopy(dshHome, dest, opts.now, opts.backupRoot)
          if (result.backup === null) {
            // 备份失败就不删：宁可留着旧副本（技能由 bundled 加载，旧副本只是冗余），
            // 也不能在没有退路的情况下删用户磁盘上的东西。
            result.skillCopy = 'kept'
            result.conflict = 'backup-failed'
          } else {
            rmSync(dest, { recursive: true, force: true })
            result.skillCopy = 'removed'
          }
        } else {
          // 没有我们自己写的版本标记：可能是用户手工维护的技能目录，别删。
          result.skillCopy = 'conflict'
          result.conflict = 'unmarked-skill-copy'
        }
      } else {
        result.skillCopy = 'kept'
      }
    } catch {
      result.skillCopy = 'error'
    }
  }

  // ---- 2. AGENTS.md 常驻块 ----
  const agentsPath = resolve(join(dshHome, AGENTS_FILENAME))
  try {
    if (existsSync(agentsPath)) {
      const current = readFileSync(agentsPath, 'utf8')
      const { text, removed } = stripAgentsBlock(current)
      if (removed) {
        if (text.trim() === '') rmSync(agentsPath, { force: true })
        else writeFileSync(agentsPath, text.endsWith('\n') ? text : text + '\n', 'utf8')
        result.agentsBlock = 'removed'
      }
    }
  } catch {
    result.agentsBlock = 'error'
  }

  return result
}

/** 删前把旧副本整份复制到备份根；失败返回 null（迁移继续，报告里说明）。 */
function backupSkillCopy(dshHome, dest, now, backupRoot) {
  try {
    const stamp = now ?? new Date().toISOString().replace(/[:.]/g, '-')
    const root = backupRoot ?? join(dshHome, LEGACY_BACKUP_DIR)
    const target = join(root, stamp, 'skills-' + SKILL_NAME)
    mkdirSync(join(root, stamp), { recursive: true })
    cpSync(dest, target, { recursive: true, dereference: false, filter: (src) => baseNameSafe(src) })
    return target
  } catch {
    return null
  }
}

/** 备份时跳过 `__pycache__` 这类可再生目录与超大对象。 */
function baseNameSafe(path) {
  const name = path.split(sep).pop() ?? ''
  if (name === '__pycache__' || name === 'node_modules' || name === '.git') return false
  try {
    const st = statSync(path)
    return st.size <= 8 * 1024 * 1024
  } catch {
    return true
  }
}
