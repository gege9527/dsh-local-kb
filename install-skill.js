/**
 * install-skill.js — 旧安装器的**卸载**部分。
 *
 * 0.5.0 起技能由 cordis.patch.yml 的 bundledSkillDir 直接加载，不再往
 * $DSH_HOME/skills/ 复制副本，也不再往 AGENTS.md 写规则块；安装/追加逻辑因此删除，
 * 只保留：
 *   - 常量（SKILL_NAME / VERSION_FILENAME / AGENTS_*）：migrate.js 与 index.js 复用
 *   - uninstallSkill()：用户主动跑 node install-skill.js --uninstall 时清理残留
 *   - resolveDshHome()：统一的 $DSH_HOME 解析
 *
 * 卸载删什么：技能副本（软链只解链接）、AGENTS.md 的 KB_LOCAL 块、WebDAV 凭据（先备份）、
 * 插件设置与同步状态。不删知识库目录（$KB_ROOT），那是用户数据。
 */
import { lstatSync } from 'node:fs'
import { access, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_NAME = 'local-kb'
export const VERSION_FILENAME = '.skill-version'
export const AGENTS_FILENAME = 'AGENTS.md'
export const AGENTS_MARKER_START = '<!-- KB_LOCAL_START -->'
export const AGENTS_MARKER_END = '<!-- KB_LOCAL_END -->'

export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
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
 * 这是**用户主动运行**的操作（node install-skill.js --uninstall）。插件被
 * dsh plugin remove 移除后代码不再运行，没有自动钩子，只能靠这条命令收尾。
 */
export async function uninstallSkill(opts = {}) {
  const dshHome = resolveDshHome(opts.env ?? process.env)
  const skillsRoot = resolve(join(dshHome, 'skills'))
  const dest = resolve(join(skillsRoot, SKILL_NAME))
  const removed = []
  const notes = []

  // 只删自己装的那一个目录，且必须真的落在 skills/ 下面。
  // 目标是软链时只解链接：它可能指向被其他工具共用的技能库。
  if (dest !== skillsRoot && dest.startsWith(skillsRoot + sep)) {
    try {
      const info = lstatSync(dest)
      if (info.isSymbolicLink()) {
        await unlink(dest)
        removed.push(dest + '（软链，仅解链接，目标保留）')
      } else if (info.isDirectory()) {
        await rm(dest, { recursive: true, force: true })
        removed.push(dest)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') notes.push('技能副本删除失败：' + errorMessage(error))
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
    notes.push(AGENTS_FILENAME + ' 不存在，无需处理')
  } else {
    const start = current.indexOf(AGENTS_MARKER_START)
    const end = current.indexOf(AGENTS_MARKER_END)
    if (start !== -1 && end > start) {
      const before = current.slice(0, start).replace(/\s+$/, '')
      const after = current.slice(end + AGENTS_MARKER_END.length).replace(/^\s+/, '')
      const next = [before, after].filter(Boolean).join('\n\n')
      try {
        await writeFile(agentsPath, next === '' ? '' : next + '\n', 'utf8')
        removed.push(agentsPath + ' 的 KB_LOCAL 块')
      } catch (error) {
        notes.push(AGENTS_FILENAME + ' 清理失败：' + errorMessage(error))
      }
    } else {
      notes.push(AGENTS_FILENAME + ' 里没有 KB_LOCAL 块')
    }
  }

  // WebDAV 凭据：卸载就该清掉，删前备份原文件（0600）
  const creds = await removeWebdavCredentials(dshHome)
  if (creds.error !== undefined) {
    notes.push('凭据清理失败：' + creds.error)
  } else if (creds.removed > 0) {
    removed.push('WebDAV 凭据 ' + creds.removed + ' 项（备份：' + creds.backup + '）')
  } else {
    notes.push('没有找到本插件的 WebDAV 凭据')
  }

  // 插件运行状态：设置、同步基准分片、覆盖前备份
  const stateDir = join(dshHome, 'local-kb')
  try {
    await access(stateDir)
    await rm(stateDir, { recursive: true, force: true })
    removed.push(stateDir)
  } catch (error) {
    if (error?.code !== 'ENOENT') notes.push('插件状态目录删除失败：' + errorMessage(error))
  }

  notes.push('知识库目录（$KB_ROOT，默认 ~/.local-kb）未删除：那是你的数据，需要时手动处理')
  return { removed, notes }
}

// 直接运行：node install-skill.js [--uninstall]
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  if (process.argv.includes('--uninstall')) {
    console.log(JSON.stringify(await uninstallSkill(), null, 2))
  } else {
    console.log('安装已由插件自动完成（bundledSkillDir）。要清理残留：node install-skill.js --uninstall')
  }
}
