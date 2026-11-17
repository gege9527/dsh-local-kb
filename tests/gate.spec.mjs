import { homedir } from 'node:os'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离 $DSH_HOME：apply() 会跑旧安装迁移，绝不能落到用户真实 ~/.dsh
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gate-home-'))

import { apply } from '../index.js'

// ---- 门禁 v2 测试矩阵（2026-10-26）：判定权归模型，插件只留唯一硬闸 + 零打断提醒 ----
// 硬闸：grep/rg 内容搜索打 / 或 home，且本 agent 从未查过 KB → deny 一次。
// 其余全放行：web、find、codegraph、read 任意路径、home 一级目录、workdir 定点。
// 提醒（post-execute additionalContexts）：记忆未读 / 认知后全盘搜索 / web 首搜；
// 每类每任务 1 次，且全会话上限 2 次（防长会话刷屏）。
const KB_ROOT = '/tmp/fake-kb'
const HOME = homedir()

const handlers = {}
const ctx = {
  on(name, handler) { (handlers[name] ??= []).push(handler) },
  get() { return undefined },
  inject() {},
  effect() {},
}
apply(ctx, { kbRoot: KB_ROOT, injectContext: false })

const pre = handlers['tools/pre-execute']?.[0]
const post = handlers['tools/post-execute']?.[0]
const preStep = handlers['agent/pre-step']?.[0]
if (!pre) throw new Error('pre-execute handler not registered')
if (!post) throw new Error('post-execute handler not registered')
if (!preStep) throw new Error('agent/pre-step handler not registered')

const allow = async () => ({ kind: 'allow' })
// 每个 agent 用独立对象（WeakMap 键），验证 per-agent 隔离
const a1 = { session: { id: 's1' } }
const a2 = { session: { id: 's2' } }
const a3 = { session: { id: 's3' } }
const a4 = { session: { id: 's4' } }
const a5 = { session: { id: 's5' } }

const runPre = (name, args, agent = a1) => pre({ name, arguments: args, agent }, allow)
// post-execute 签名是 (exec, result, next)：第三个参数才是 next()
const runPost = async (name, args, agent = a1) => post({ name, arguments: args, agent }, { kind: 'accept' }, async () => ({ kind: 'accept' }))
const userTurn = async (agent = a1) => preStep({ agent, messages: [{ source: { kind: 'user' } }] }, allow)

const results = []
let pass = 0, fail = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (ok) pass++; else fail++
  results.push((ok ? 'PASS' : 'FAIL') + '  ' + label + (ok ? '' : '  → got ' + JSON.stringify(actual)))
}
const hasReminder = (decision) =>
  Array.isArray(decision?.additionalContexts) && decision.additionalContexts[0]?.source?.kind === 'local-kb-reminder'

// ============ ① 永不拦（知道去哪 / 外部知识 / 非内容搜索） ============
check('web_search 未认知放行', (await runPre('web_search', { queries: ['x'] })).kind, 'allow')
check('web_fetch 未认知放行', (await runPre('web_fetch', { url: 'https://example.com' })).kind, 'allow')
check('codegraph 永不拦', (await runPre('codegraph', { query: 'x' })).kind, 'allow')
check('find / 放行（KB 无文件清单）', (await runPre('bash', { command: 'find / -name foo' })).kind, 'allow')
check('find ~ 放行', (await runPre('bash', { command: 'find ~ -name "*.pdf"' })).kind, 'allow')
check('read /etc/hosts 放行（定点）', (await runPre('read', { file_path: '/etc/hosts' })).kind, 'allow')
check('grep ~/Documents 一级目录放行', (await runPre('bash', { command: 'grep -r foo ~/Documents' })).kind, 'allow')
check('grep 具体项目放行', (await runPre('bash', { command: 'grep -r foo /Users/lyu/Documents/Source/proj' })).kind, 'allow')
check('grep 工作区相对路径放行', (await runPre('bash', { command: 'grep -rn x src' })).kind, 'allow')
check('echo / | grep 管道不误拦', (await runPre('bash', { command: 'echo / | grep foo' })).kind, 'allow')
check('ls / 非搜索放行', (await runPre('bash', { command: 'ls /' })).kind, 'allow')
check('grep ~/.zshrc 单文件放行', (await runPre('bash', { command: 'grep hook ~/.zshrc' })).kind, 'allow')

// ============ ② 唯一硬闸：grep/rg 打 / 或 home，未认知 → deny ============
check('grep / deny', (await runPre('bash', { command: 'grep -r foo /' })).kind, 'deny')
check('rg home deny', (await runPre('bash', { command: 'rg foo ' + HOME })).kind, 'deny')
check('grep ~ deny', (await runPre('bash', { command: 'grep -r foo ~' })).kind, 'deny')
check('grep 无路径 + workdir home deny', (await runPre('bash', { command: 'grep -rn foo', workdir: HOME })).kind, 'deny')
check('cd / && grep . deny', (await runPre('bash', { command: 'cd / && grep -r foo .', workdir: '/' })).kind, 'deny')
check('Data 卷 home 等价 deny', (await runPre('bash', { command: 'grep -r foo /System/Volumes/Data' + HOME })).kind, 'deny')

// ============ ③ 畸形/超长/无 agent：绝不炸、不误拦 ============
check('command 非字符串', (await runPre('bash', { command: 123 })).kind, 'allow')
check('command 缺省', (await runPre('bash', {})).kind, 'allow')
check('超长命令跳过判定', (await runPre('bash', { command: 'grep -r x /' + 'a'.repeat(9000) })).kind, 'allow')
check('无 agent 直调永不拦', (await runPre('bash', { command: 'grep -r foo /' }, null)).kind, 'allow')

// ============ ④ 认知与隔离 ============
check('a1 grep KB → 认知', (await runPre('bash', { command: 'grep -rn x ' + KB_ROOT + '/projects' }, a1)).kind, 'allow')
check('a1 read KB memory → 记忆认知', (await runPre('read', { file_path: KB_ROOT + '/memory/MEMORY.md' }, a1)).kind, 'allow')
check('a1 认知后 grep / 放行', (await runPre('bash', { command: 'grep -r foo /' }, a1)).kind, 'allow')
check('a2 未认知 grep / 仍 deny', (await runPre('bash', { command: 'grep -r foo /' }, a2)).kind, 'deny')

// ============ ⑤ 提醒：记忆未读（每任务 1 次；读 memory 或只查 docs 的语义差） ============
check('a2 首次非 KB read 附记忆提醒', hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a2)), true)
check('a2 第二次不再附', hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a2)), false)
check('a3 读过 memory 后不再提醒', await (async () => {
  await runPre('read', { file_path: KB_ROOT + '/memory/MEMORY.md' }, a3)
  return hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a3))
})(), false)
check('a4 只查 docs 仍触发记忆提醒', await (async () => {
  await runPre('bash', { command: 'grep -rn x ' + KB_ROOT + '/docs' }, a4)
  return hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a4))
})(), true)
await userTurn(a2)
check('用户新消息后记忆提醒重新武装', hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a2)), true)
await userTurn(a2)
check('会话内第 3 次不再提醒（上限 2）', hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a2)), false)
await userTurn(a2)
await userTurn(a2)
check('换任务也压不住上限', hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a2)), false)

// ============ ⑥ 提醒：web 首搜 / 认知后全盘 ============
check('a5 web 首搜附提醒', hasReminder(await runPost('web_search', { queries: ['x'] }, a5)), true)
check('a5 web 二次不再附', hasReminder(await runPost('web_search', { queries: ['y'] }, a5)), false)
check('a1 认知后全盘搜索附 global 提醒', hasReminder(await runPost('bash', { command: 'grep -r foo /' }, a1)), true)
check('a1 global 提醒仅一次', hasReminder(await runPost('bash', { command: 'grep -r foo /' }, a1)), false)

// ============ ⑦ 逃生门 ============
process.env.DSH_LOCAL_KB_ENFORCE = '0'
check('逃生门 grep /', (await runPre('bash', { command: 'grep -r foo /' })).kind, 'allow')
check('逃生门无提醒', hasReminder(await runPost('read', { file_path: '/etc/hosts' }, a5)), false)
delete process.env.DSH_LOCAL_KB_ENFORCE

console.log(results.join('\n'))
console.log('---- ' + pass + ' passed, ' + fail + ' failed ----')
process.exit(fail > 0 ? 1 : 0)
