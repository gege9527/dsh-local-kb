import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---- 改位置端到端：经设置页 API 走完复制 → 切换 → 旧目录改名，验证库根热生效 ----

// 隔离 $DSH_HOME：apply 会写设置与同步状态，绝不能落到真实 ~/.dsh
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-home-'))

const { apply } = await import('../index.js')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-e2e-'))
const parentA = path.join(work, 'a')
const parentB = path.join(work, 'b')
const kbRootA = path.join(parentA, '.local-kb')
fs.mkdirSync(path.join(kbRootA, 'memory'), { recursive: true })
fs.mkdirSync(parentB)
fs.writeFileSync(path.join(kbRootA, 'paths.yaml'), 'demo:\n  path: /tmp/demo\n')
fs.writeFileSync(path.join(kbRootA, 'memory', 'MEMORY.md'), '- [a](a.md)\n')

// 初始位置：设置里的父目录 = a
fs.mkdirSync(path.join(process.env.DSH_HOME, 'local-kb'), { recursive: true })
fs.writeFileSync(path.join(process.env.DSH_HOME, 'local-kb', 'settings.json'), JSON.stringify({ parent: parentA }))

const routes = []
const ctx = {
  on() {},
  get() { return undefined },
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  inject(names, cb) {
    if (names[0] !== 'connection') return
    cb({
      connection: { fetch: { register(route) { routes.push(route); return () => {} } } },
      effect(fn) {
        const dispose = fn()
        return typeof dispose === 'function' ? dispose : () => {}
      },
    })
  },
}
apply(ctx)

const byPath = new Map(routes.map((r) => [r.path, r]))
const callGet = async (p) => (await byPath.get(p).fetch(new Request('http://local' + p))).json()
const callPost = async (p, body) => (await byPath.get(p).fetch(new Request('http://local' + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}))).json()

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

// 1) 初始状态
const state0 = await callGet('/api/local-kb/state')
check('初始库根是 a/.local-kb', state0.kbRoot === kbRootA, String(state0.kbRoot))

// 2) 预检
const pre = await callPost('/api/local-kb/relocate/precheck', { parent: parentB })
check('预检通过', pre.ok === true, JSON.stringify(pre))
check('预检目标是 b/.local-kb', pre.target === path.join(parentB, '.local-kb'), String(pre.target))
check('预检统计文件数', pre.plan.files === 2, JSON.stringify(pre.plan))

// 3) 执行迁移
const moved = await callPost('/api/local-kb/relocate', { parent: parentB })
check('迁移成功', moved.ok === true, JSON.stringify(moved))
check('新库存在', fs.existsSync(path.join(parentB, '.local-kb', 'paths.yaml')))
check('内容搬过去', fs.readFileSync(path.join(parentB, '.local-kb', 'memory', 'MEMORY.md'), 'utf8').includes('a.md'))
check('旧库改名保留', typeof moved.legacyDir === 'string' && moved.legacyDir.includes('.local-kb-old-') && fs.existsSync(moved.legacyDir), String(moved.legacyDir))
check('旧路径已不在', !fs.existsSync(kbRootA))
check('未残留 incoming', fs.readdirSync(parentB).every((n) => !n.includes('.incoming-')), fs.readdirSync(parentB).join(','))

// 4) 设置与内存根都换新（热生效）
const settings = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'local-kb', 'settings.json'), 'utf8'))
check('settings.parent 已换', settings.parent === parentB, JSON.stringify(settings))
const state1 = await callGet('/api/local-kb/state')
check('state 库根热生效', state1.kbRoot === path.join(parentB, '.local-kb'), String(state1.kbRoot))
check('迁移阶段已清空', (state1.state?.relocatePhase ?? null) === null, JSON.stringify(state1.state?.relocatePhase))

// 5) 目标已有同名文件夹 → 拒绝且不动磁盘
const pre2 = await callPost('/api/local-kb/relocate/precheck', { parent: parentB })
check('已存在同名文件夹时预检拒绝', pre2.ok === false && pre2.blockers.some((b) => b.includes('同名')), JSON.stringify(pre2.blockers))

fs.rmSync(work, { recursive: true, force: true })
fs.rmSync(process.env.DSH_HOME, { recursive: true, force: true })

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
if (failed > 0) process.exitCode = 1
