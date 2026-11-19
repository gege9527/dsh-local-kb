#!/usr/bin/env node
/**
 * check-privacy.mjs — 发布前隐私校验（prepublishOnly 第二道闸）。
 *
 * 为什么要有：npm publish 不可撤销（72 小时后只能 deprecate）。
 * 包里混进本机路径、用户名、凭据或内网地址，发出去就收不回来。
 *
 * 扫描 package.json files 白名单覆盖的所有文本文件，命中即 exit 1：
 *   1. 绝对路径（/Users/、/home/、C:\\Users\\）
 *   2. 本机用户名（os.userInfo().username，作为独立词出现）
 *   3. 私钥块 / 凭据赋值
 *   4. 内网 IP
 *
 * 允许：公开 GitHub 账号、LICENSE 版权人、127.0.0.1 / localhost / example.com。
 *
 * 可单独跑：node scripts/check-privacy.mjs [--root <dir>]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { userInfo } from 'node:os'

const args = process.argv.slice(2)
const rootArg = args.indexOf('--root')
const ROOT = rootArg >= 0 ? resolve(args[rootArg + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.py', '.md', '.json', '.yml', '.yaml', '.svg', '.txt'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.backup', '.kb-index', '__pycache__'])

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) out.push(...walk(abs))
    else out.push(abs)
  }
  return out
}

function expand(entry) {
  const abs = join(ROOT, entry)
  if (!entry.includes('*')) {
    if (!existsSync(abs)) return []
    return statSync(abs).isDirectory() ? walk(abs) : [abs]
  }
  const dir = dirname(abs)
  if (!existsSync(dir)) return []
  const pattern = basename(entry).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const rx = new RegExp('^' + pattern + '$')
  return readdirSync(dir).filter((name) => rx.test(name)).map((name) => join(dir, name))
}

const files = [...new Set((pkg.files ?? []).flatMap(expand))]
  .filter((abs) => TEXT_EXT.has(abs.slice(abs.lastIndexOf('.'))))

const username = userInfo().username
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const RULES = [
  {
    name: '绝对路径',
    rx: /(\/Users\/[^/\s'"`]+|\/home\/[^/\s'"`]+|[A-Z]:\\\\Users\\\\[^\\\s]+)/,
    why: '换成 ~ 或相对路径',
  },
  {
    name: '本机用户名',
    rx: username.length >= 3 ? new RegExp('(?<![A-Za-z0-9_-])' + esc(username) + '(?![A-Za-z0-9_-])', 'i') : null,
    why: '发布包里不该出现本机账户名',
  },
  {
    name: '私钥块',
    rx: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    why: '私钥绝不能进包',
  },
  {
    name: '凭据赋值',
    rx: /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i,
    why: '疑似真实凭据；占位符用 xxx / <...> / ***',
  },
  {
    name: '内网 IP',
    rx: /(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})/,
    why: '内网地址会暴露拓扑',
  },
]

const hits = []
for (const abs of files) {
  const rel = relative(ROOT, abs).split('\\').join('/')
  let text
  try {
    text = readFileSync(abs, 'utf8')
  } catch {
    continue
  }
  text.split('\n').forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.rx) continue
      const m = line.match(rule.rx)
      if (!m) continue
      // 占位符与文档说明放行：<...>、xxx、***、… 以及「禁止记凭据」这类说明行
      if (/<[^>]+>|xxx+\*{0,3}|\*{3,}|…|凭据|占位/.test(line)) continue
      // 常量键名放行：全大写变量 + 全小写值（CRED_PASSWORD = 'dsh_local_kb_webdav_password'）
      if (rule.name === '凭据赋值' && /\b[A-Z][A-Z0-9_]+\s*=\s*'[a-z0-9_]+'/.test(line)) continue
      // 公开署名放行：© 作者 / LICENSE 版权行
      if (rule.name === '本机用户名' && /©|版权|author/i.test(line)) continue
      hits.push({ rel, line: index + 1, rule: rule.name, text: line.trim().slice(0, 120) })
    }
  })
}

if (hits.length === 0) {
  console.log('隐私校验通过（' + files.length + ' 个文件）')
  process.exit(0)
}

console.log('✖ 隐私校验未通过：' + hits.length + ' 处命中')
for (const hit of hits.slice(0, 30)) {
  console.log('  ' + hit.rel + ':' + hit.line + ' [' + hit.rule + '] ' + hit.text)
}
if (hits.length > 30) console.log('  … 还有 ' + (hits.length - 30) + ' 处')
process.exit(1)