#!/usr/bin/env node
/**
 * check-package.mjs — 发布前校验（prepublishOnly）。
 *
 * 为什么要有：技能只有一条加载路径（cordis.patch.yml 的 bundledSkillDir 指向
 * 包内 skills/），没有任何运行时兜底。发布包里少了 skills/local-kb，
 * 用户装完就是「技能不存在」，且只在启动日志里留一条 warn。
 * 所以把「文件齐不齐」挡在 npm publish 之前。
 *
 * 校验三组事实，任何一条不满足就 exit 1：
 *   1. package.json files 覆盖 skills/ 与核心模块
 *   2. 技能载荷文件确实在盘上（SKILL.md / references / tools）
 *   3. cordis.patch.yml 里那行 provider 配置完整（providerName / includeDefaultRoots /
 *      bundledSkillDir 的 !!js 表达式指向本包名）
 *
 * 零依赖、node: builtins；可单独跑：node scripts/check-package.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const oks = []

const fail = (msg) => failures.push(msg)
const ok = (msg) => oks.push(msg)

const exists = (rel) => existsSync(join(ROOT, rel))

// ---- 1. 技能载荷 ----
const REQUIRED_SKILL_FILES = [
  'skills/local-kb/SKILL.md',
  'skills/local-kb/references/agents-snippet.md',
  'skills/local-kb/references/memory.md',
  'skills/local-kb/tools/kb-search.py',
  'skills/local-kb/tools/kb-check.py',
  'skills/local-kb/tools/kb-card.py',
  'skills/local-kb/tools/kb-move-project.py',
  'skills/local-kb/tools/kb-add-project.py',
  'skills/local-kb/tools/kb-archive-project.py',
  'skills/local-kb/tools/kb-archive-note.py',
  'skills/local-kb/tools/kb_common.py',
]
for (const rel of REQUIRED_SKILL_FILES) {
  if (!exists(rel)) {
    fail('缺少技能文件：' + rel)
    continue
  }
  if (statSync(join(ROOT, rel)).size === 0) fail('技能文件为空：' + rel)
}
if (failures.length === 0) ok('技能载荷完整（' + REQUIRED_SKILL_FILES.length + ' 个关键文件）')

// ---- 2. 核心模块与 patch ----
for (const rel of ['index.js', 'inject.js', 'migrate.js', 'install-skill.js', 'client.js', 'cordis.patch.yml']) {
  if (!exists(rel)) fail('缺少插件文件：' + rel)
}
if (!failures.length) ok('插件模块齐全')

// ---- 3. package.json files 覆盖 ----
let pkg
try {
  pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
} catch (error) {
  fail('package.json 读不出来：' + error.message)
}
if (pkg) {
  const files = Array.isArray(pkg.files) ? pkg.files : []
  // 技能按 SKILL.md / references/ / tools/*.py 三条列出（不整目录打包，避免 __pycache__ 混进去）
  if (!files.some((entry) => entry.startsWith('skills/local-kb/'))) fail('package.json files 缺技能条目')
  for (const need of ['index.js', 'inject.js', 'migrate.js', 'install-skill.js', 'client.js', 'cordis.patch.yml']) {
    if (!files.includes(need)) fail('package.json files 缺条目：' + need)
  }
  if (failures.length === 0) ok('package.json files 覆盖技能与核心模块')
  if (!pkg.dsh?.bundle?.patch) fail('package.json 缺 dsh.bundle.patch')
  else ok('dsh.bundle.patch 已声明')
}

// ---- 4. cordis.patch.yml 的 provider 行 ----
try {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  const checks = [
    ['id: local-kb-skill', 'patch 缺 local-kb-skill 行'],
    ["name: '@deepseek-ai/dsh-skill-filesystem'", 'patch 的 provider 不是 skill-filesystem'],
    ['providerName: local-kb-bundled', 'patch 缺 providerName'],
    ['includeDefaultRoots: false', 'patch 没关 includeDefaultRoots（会与用户技能根重复扫描）'],
    ['bundledSkillDir: !!js', 'patch 的 bundledSkillDir 不是 !!js 表达式'],
    ["node_modules/dsh-local-kb/skills/", 'patch 的 bundledSkillDir 没指向本包 skills/'],
    ['name: dsh-local-kb', 'patch 缺插件本体行'],
  ]
  for (const [needle, why] of checks) if (!patch.includes(needle)) fail(why)
  if (!failures.length) ok('cordis.patch.yml provider 行完整')
} catch (error) {
  fail('cordis.patch.yml 读不出来：' + error.message)
}

// ---- 5. 常驻规则文件必须带 KB_LOCAL 标记（注入时按标记剥离） ----
try {
  const snippet = readFileSync(join(ROOT, 'skills/local-kb/references/agents-snippet.md'), 'utf8')
  if (!snippet.includes('<!-- KB_LOCAL_START -->') || !snippet.includes('<!-- KB_LOCAL_END -->')) {
    fail('agents-snippet.md 缺 KB_LOCAL_START/END 标记')
  } else {
    ok('常驻规则文件带标记（' + snippet.length + ' 字符）')
  }
} catch {
  // 已在第 1 步报过缺失
}

// ---- 结果 ----
for (const line of oks) console.log('PASS  ' + line)
for (const line of failures) console.log('FAIL  ' + line)
if (failures.length > 0) {
  console.log('\n发布前校验失败：' + failures.length + ' 项，npm publish 已中止')
  process.exit(1)
}
console.log('\n发布前校验通过（' + oks.length + ' 组）')
