import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { legacyDirOf, precheckRelocate, relocateCopy, stampNow } from '../index.js'

// ---- 改位置：预检拒绝矩阵 + 复制校验 + 旧库目录名 ----

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-relocate-'))
const kbRoot = path.join(work, 'home', '.local-kb')
fs.mkdirSync(path.join(kbRoot, 'memory'), { recursive: true })
fs.writeFileSync(path.join(kbRoot, 'README.md'), 'x')
fs.writeFileSync(path.join(kbRoot, 'paths.yaml'), 'demo:\n  path: /tmp/demo\n')
fs.writeFileSync(path.join(kbRoot, 'memory', 'MEMORY.md'), '- [a](a.md)\n')

const parentDir = path.join(work, 'data')
fs.mkdirSync(parentDir)

// 1) 正常预检
const plan = await precheckRelocate({ kbRoot, parent: parentDir })
check('预检通过', plan.ok === true, JSON.stringify(plan.blockers))
check('目标是 <parent>/.local-kb', plan.target === path.join(parentDir, '.local-kb'), String(plan.target))
check('预检统计文件数与字节', plan.plan.files === 3 && plan.plan.bytes > 0, JSON.stringify(plan.plan))

// 2) 目标已存在同名文件夹 —— 用户定的核心拒绝规则
const occupied = path.join(parentDir, '.local-kb')
fs.mkdirSync(occupied)
const blocked = await precheckRelocate({ kbRoot, parent: parentDir })
check('目标已有 .local-kb 拒绝', blocked.ok === false && blocked.blockers.some((b) => b.includes('同名')), JSON.stringify(blocked.blockers))
check('拒绝时预检不统计（未动磁盘）', blocked.plan.files === 0, JSON.stringify(blocked.plan))
fs.rmdirSync(occupied)

// 3) 非法父目录
check('相对路径拒绝', (await precheckRelocate({ kbRoot, parent: 'data' })).ok === false)
check('父目录不存在拒绝', (await precheckRelocate({ kbRoot, parent: path.join(work, 'nope') })).ok === false)
check('与当前库重叠拒绝', (await precheckRelocate({ kbRoot, parent: path.join(kbRoot, 'sub') })).ok === false)
check('当前位置相同拒绝', (await precheckRelocate({ kbRoot, parent: path.dirname(kbRoot) })).ok === false)

// 4) 当前库不完整
const brokenKb = path.join(work, 'broken', '.local-kb')
fs.mkdirSync(brokenKb, { recursive: true })
check('缺少 paths.yaml 拒绝', (await precheckRelocate({ kbRoot: brokenKb, parent: parentDir })).ok === false)

// 5) 复制 + 校验
const copied = await relocateCopy({ kbRoot, parent: parentDir })
check('复制成功', copied.ok === true, JSON.stringify(copied))
const target = path.join(parentDir, '.local-kb')
check('目标目录已落位', fs.existsSync(target))
check('旧库未改动（内容仍在）', fs.existsSync(path.join(kbRoot, 'paths.yaml')))
check('复制内容一致', fs.readFileSync(path.join(target, 'paths.yaml'), 'utf8') === fs.readFileSync(path.join(kbRoot, 'paths.yaml'), 'utf8'))
check('无 incoming 残留', fs.readdirSync(parentDir).every((n) => !n.includes('.incoming-')), fs.readdirSync(parentDir).join(','))

// 6) 再搬一次 → 目标已存在，失败且不留半成品
const again = await relocateCopy({ kbRoot, parent: parentDir })
check('目标已存在时复制失败', again.ok === false && again.code === 'PRECHECK_FAILED', JSON.stringify(again))

// 7) 旧库目录名与时间戳
check('时间戳 14 位', /^\d{14}$/.test(stampNow()), stampNow())
const legacy = legacyDirOf(kbRoot, '20261120162734')
check('旧库目录名带秒级时间戳', path.basename(legacy) === '.local-kb-old-20261120162734', legacy)
check('旧库目录同父目录', path.dirname(legacy) === path.dirname(kbRoot), legacy)

fs.rmSync(work, { recursive: true, force: true })

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
if (failed > 0) process.exitCode = 1
