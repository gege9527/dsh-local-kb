import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

// ---- 设置页 API 测试：路由走 connection.fetch（dsh 鉴权围栏），不再是 webServer ----
// 这里只验证注册形状与 handler 行为；401/403 由 dsh 的 connection 层负责，
// 需要真实 host 才能复现（见 README 的验证命令）。

const KB_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-api-'))
// 状态目录跟着测试走，不写用户真实的 ~/.dsh
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-api-home-'))

const mk = (rel, text) => {
  const abs = path.join(KB_ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
mk('projects/demo/memory/MEMORY.md', '# demo\n- [a](a.md)\n')
mk('projects/demo/memory/a.md', 'x')
mk('projects/demo/demo.md', '---\ntitle: demo\n---\n')
mk('docs/guide.md', '# guide\n')
fs.writeFileSync(path.join(KB_ROOT, 'paths.yaml'), 'demo:\n  path: /tmp/demo\n')

const routes = []
const registeredServices = []

function makeCtx() {
  return {
    on() {},
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            if (ref === 'dsh_local_kb_webdav_url') return { value: '' }
            return { value: '' }
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(names, cb) {
      registeredServices.push(names[0])
      if (names[0] === 'connection') {
        const scope = {
          connection: {
            fetch: {
              register(route) {
                routes.push(route)
                return () => {}
              },
            },
          },
          effect: (fn) => {
            const dispose = fn()
            return typeof dispose === 'function' ? dispose : () => {}
          },
        }
        cb(scope)
      }
      // skills 关闭注册，其余服务不提供（可选服务缺失时应静默跳过）
    },
  }
}

apply(makeCtx(), { kbRoot: KB_ROOT })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

check('注册 7 条路由', routes.length === 7, 'got ' + routes.length)
const byPath = new Map(routes.map((r) => [r.path, r]))
check('state 路由存在', byPath.has('/api/local-kb/state'))
check('overview 路由存在', byPath.has('/api/local-kb/overview'))
check('overview 只接受 GET', JSON.stringify(byPath.get('/api/local-kb/overview')?.methods) === '["GET"]')
check('sync 路由存在', byPath.has('/api/local-kb/sync'))
check('test-link 路由存在', byPath.has('/api/local-kb/test-link'))
check('download 路由存在', byPath.has('/api/local-kb/download'))
check('download 只接受 POST', JSON.stringify(byPath.get('/api/local-kb/download')?.methods) === '["POST"]')
check('settings 路由存在', byPath.has('/api/local-kb/settings'))
check('clear 路由存在', byPath.has('/api/local-kb/clear'))
check('state 只接受 GET', JSON.stringify(byPath.get('/api/local-kb/state')?.methods) === '["GET"]')
check('sync 只接受 POST', JSON.stringify(byPath.get('/api/local-kb/sync')?.methods) === '["POST"]')
check('test-link 只接受 POST', JSON.stringify(byPath.get('/api/local-kb/test-link')?.methods) === '["POST"]')
check('每条路由都声明 requestBody', routes.every((r) => r.requestBody === 'buffered'), JSON.stringify(routes.map((r) => [r.path, r.requestBody])))
check('不再注册 webServer', !registeredServices.includes('webServer'), registeredServices.join(','))

const stateRoute = byPath.get('/api/local-kb/state')
const stateRes = await stateRoute.fetch(new Request('http://local/api/local-kb/state'))
const stateBody = await stateRes.json()
check('state 返回 200', stateRes.status === 200, String(stateRes.status))
check('state 是 JSON', (stateRes.headers.get('content-type') || '').includes('application/json'))
check('state 不缓存', stateRes.headers.get('cache-control') === 'no-store')
check('state 不被嗅探', stateRes.headers.get('x-content-type-options') === 'nosniff')
check('state 带 kbRoot', stateBody.kbRoot === KB_ROOT, String(stateBody.kbRoot))
check('state 带同步状态', typeof stateBody.state === 'object' && stateBody.state !== null)
check('state 带体检统计与警告列表', 'lastCheckStats' in stateBody.state && Array.isArray(stateBody.state.lastCheckWarns), JSON.stringify(stateBody.state))

const testRoute = byPath.get('/api/local-kb/test-link')
const testRes = await testRoute.fetch(new Request('http://local/api/local-kb/test-link', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: '', user: '', password: '' }),
}))
const testBody = await testRes.json()
check('test-link 空表单回退已存凭据', testRes.status === 200 && testBody.ok === false, JSON.stringify(testBody))
check('test-link 缺 URL 时给出可读原因', /未配置|无效|连接/.test(String(testBody.reason)), String(testBody.reason))

const badRes = await testRoute.fetch(new Request('http://local/api/local-kb/test-link', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: 'not json',
}))
const badBody = await badRes.json()
check('test-link 非法 JSON 不抛 500', badRes.status === 200 && badBody.ok === false, JSON.stringify(badBody))

const overviewRoute = byPath.get('/api/local-kb/overview')
const overviewRes = await overviewRoute.fetch(new Request('http://local/api/local-kb/overview'))
const overviewBody = await overviewRes.json()
check('overview 返回 200', overviewRes.status === 200, String(overviewRes.status))
check('overview 返回项目数组', Array.isArray(overviewBody.projects), JSON.stringify(overviewBody))
check('overview 统计到项目', overviewBody.projects.length === 1, JSON.stringify(overviewBody.projects))
check('overview 项目里带记忆条数', overviewBody.projects[0]?.memories === 1, JSON.stringify(overviewBody.projects[0]))
check('overview 项目里带索引行数', overviewBody.projects[0]?.indexLines === 3, JSON.stringify(overviewBody.projects[0]))
check('overview 统计到文档', overviewBody.docs === 1, String(overviewBody.docs))
check('overview 标出已登记路径', overviewBody.projects[0]?.path === '/tmp/demo', JSON.stringify(overviewBody.projects[0]))

const failed = results.filter((r) => !r.ok)
console.log(`\n---- ${results.length - failed.length} passed, ${failed.length} failed ----`)
fs.rmSync(KB_ROOT, { recursive: true, force: true })
if (failed.length > 0) process.exitCode = 1
