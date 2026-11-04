import { COMPACTION_REMINDER_TEXT, createCompactionReminder } from '../index.js'

// ---- 长对话提醒：过比例提醒一次，拿不到信号就不出声 ----

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const session = { id: 's1' }
const ctx = (s) => ({ agent: { session: s } })
const pressureWith = (tokens, window) => ({
  tokenMeter: { measure: () => ({ totalTokens: tokens }) },
  sessionProjections: { stateOf: () => ({ contextWindow: window }) },
})

// 低于阈值：不出声
let remind = createCompactionReminder(pressureWith(30, 100))
check('30% 不提醒', remind(ctx(session)) === '')

// 过线：提醒一次，再次为空
remind = createCompactionReminder(pressureWith(61, 100))
check('61% 提醒', remind(ctx(session)) === COMPACTION_REMINDER_TEXT)
check('同一会话只说一次', remind(ctx(session)) === '')
check('不同会话各自提醒', remind(ctx({ id: 's2' })) === COMPACTION_REMINDER_TEXT)

// 文案是「有条件地请写」，不是无条件强制（避免为满足要求而制造噪音记忆）
check('文案以未完成条件开头', COMPACTION_REMINDER_TEXT.includes('如果这个任务还没做完'))
check('文案给出跳过条件', COMPACTION_REMINDER_TEXT.includes('跳过'))
check('文案没有强制措辞', !COMPACTION_REMINDER_TEXT.includes('必须执行'))
check('文案给出 active 步骤', COMPACTION_REMINDER_TEXT.includes('status: active'))
check('文案要求 ⚡ 标记', COMPACTION_REMINDER_TEXT.includes('⚡'))
check('文案要求跑 kb-check', COMPACTION_REMINDER_TEXT.includes('kb-check.py'))
check('文案说明不是只看活跃', COMPACTION_REMINDER_TEXT.includes('不是「只看这一条」'))

// 信号缺失：一律不出声
check('没有 tokenMeter', createCompactionReminder({})(ctx(session)) === '')
check('没有窗口', createCompactionReminder({ tokenMeter: { measure: () => ({ totalTokens: 999 }) } })(ctx(session)) === '')
check('没有 session', createCompactionReminder(pressureWith(99, 100))({}) === '')
check('measure 抛错', createCompactionReminder({ tokenMeter: { measure: () => { throw new Error('x') } } })(ctx(session)) === '')
check('窗口为 0', createCompactionReminder(pressureWith(99, 0))(ctx(session)) === '')
check('totalTokens 不是数字', createCompactionReminder({ tokenMeter: { measure: () => ({ totalTokens: 'x' }) }, sessionProjections: { stateOf: () => ({ contextWindow: 100 }) } })(ctx(session)) === '')

// 阈值可配
remind = createCompactionReminder(pressureWith(50, 100), 0.4)
check('自定义阈值 0.4', remind(ctx(session)) === COMPACTION_REMINDER_TEXT)
remind = createCompactionReminder(pressureWith(50, 100), 0.9)
check('自定义阈值 0.9', remind(ctx(session)) === '')

// 非法阈值退回默认
remind = createCompactionReminder(pressureWith(61, 100), 7)
check('非法阈值退回 0.6', remind(ctx(session)) === COMPACTION_REMINDER_TEXT)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
if (failed > 0) process.exitCode = 1
