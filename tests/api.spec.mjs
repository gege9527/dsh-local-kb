import { apply } from '../index.js'

// ---- 设置页 API 测试：路由走 connection.fetch（dsh 鉴权围栏），不再是 webServer ----
// 这里只验证注册形状与 handler 行为；401/403 由 dsh 的 connection 层负责，
// 需要真实 host 才能复现（见 README 的验证命令）。

const KB_ROOT = '/tmp/fake-kb-api'

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

apply(makeCtx(), { kbRoot: KB_ROOT, installSkill: false, registerSkill: false })

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

check('注册 4 条路由', routes.length === 4, 'got ' + routes.length)
const byPath = new Map(routes.map((r) => [r.path, r]))
check('state 路由存在', byPath.has('/api/local-kb/state'))
check('sync 路由存在', byPath.has('/api/local-kb/sync'))
check('test-link 路由存在', byPath.has('/api/local-kb/test-link'))
check('根路径也能读状态', byPath.has('/api/local-kb'))
check('state 只接受 GET', JSON.stringify(byPath.get('/api/local-kb/state')?.methods) === '["GET"]')
check('sync 只接受 POST', JSON.stringify(byPath.get('/api/local-kb/sync')?.methods) === '["POST"]')
check('test-link 只接受 POST', JSON.stringify(byPath.get('/api/local-kb/test-link')?.methods) === '["POST"]')
check('test-link 缓冲请求体', byPath.get('/api/local-kb/test-link')?.requestBody === 'buffered')
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

const failed = results.filter((r) => !r.ok)
console.log(`\n---- ${results.length - failed.length} passed, ${failed.length} failed ----`)
if (failed.length > 0) process.exitCode = 1
