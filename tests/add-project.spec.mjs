import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- kb-add-project：一条命令建档 / id 推导 / 查重 / dry-run ----
// 锁的是「id 由全库唯一后缀决定」这条规则：新增 work/api 时已有 apps/api，
// 推导结果必须是 work-api，而不是手写的父目录拼名或裸 api。

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb-add-project.py')
const py = process.env.PYTHON ?? 'python3'

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-add-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
const mkdir = (rel) => fs.mkdirSync(path.join(kb, rel), { recursive: true })
const projectPage = (id) => '---\ntitle: ' + id + '\nproject_id: ' + id + '\n---\n\n## 项目资料\n'

// 已有两个项目：alpha 唯一，api 唯一（为后面制造 api 冲突做准备）
mkdir('work/alpha')
mkdir('apps/api')
write('paths.yaml', [
  'alpha:',
  '  path: ' + path.join(kb, 'work/alpha'),
  '  git_remote: none',
  'api:',
  '  path: ' + path.join(kb, 'apps/api'),
  '  git_remote: none',
  '',
].join('\n'))
write('memory/MEMORY.md', '# Global Memory Index\n')
write('projects/alpha/alpha.md', projectPage('alpha'))
write('projects/api/api.md', projectPage('api'))

const add = (args) => spawnSync(py, [tool, kb, ...args], { encoding: 'utf8' })
const desc = '测试专用的一次性目录，用来验证建档工具是否按路径推导 id、是否拒绝重复登记，不承载任何业务代码，也不进 git。'

// 1. 唯一后缀：Desktop/test → test
mkdir('Desktop/test')
const pTest = path.join(kb, 'Desktop/test')
const r1 = add(['--path', pTest, '--description', desc])
check('建档成功', r1.status === 0, r1.stdout + r1.stderr)
check('id 取最短唯一后缀', r1.stdout.includes('id: test'), r1.stdout)
const page = fs.readFileSync(path.join(kb, 'projects/test/test.md'), 'utf8')
check('项目页 frontmatter 完整', page.includes('project_id: test') && page.includes('type: code-project') && page.includes('git_remote: none'), page)
check('记忆索引已建', fs.existsSync(path.join(kb, 'projects/test/memory/MEMORY.md')))
check('paths.yaml 已追加', fs.readFileSync(path.join(kb, 'paths.yaml'), 'utf8').includes('test:'), '')

// 2. 重复路径拒绝：属刷新，不是新建
const r2 = add(['--path', pTest])
check('重复路径拒绝', r2.status === 2 && r2.stderr.includes('已登记'), r2.status + ' ' + r2.stderr)

// 3. 同名后缀：已有 apps/api，新增 work/api 必须得到 work-api
mkdir('work/api')
const r3 = add(['--path', path.join(kb, 'work/api'), '--description', desc, '--no-check'])
check('同名后缀自动加父目录', r3.status === 0 && r3.stdout.includes('id: work-api'), r3.stdout + r3.stderr)
// 新增同名目录会让已有 api 不再唯一：必须显式提示去同步，而不是悄悄改别人的 id
check('提示已有 id 需同步', r3.stdout.includes('不再唯一') && r3.stdout.includes('api→apps-api'), r3.stdout)

// 4. dry-run 不落盘
mkdir('Desktop/dry')
const before = fs.readdirSync(path.join(kb, 'projects')).sort().join(',')
const r4 = add(['--path', path.join(kb, 'Desktop/dry'), '--dry-run'])
const after = fs.readdirSync(path.join(kb, 'projects')).sort().join(',')
check('dry-run 不写盘', r4.status === 0 && before === after && !fs.existsSync(path.join(kb, 'projects/dry')), before + ' → ' + after)

// 5. 路径不存在拒绝
const r5 = add(['--path', path.join(kb, 'nope/missing')])
check('路径不存在拒绝', r5.status === 2 && r5.stderr.includes('不存在'), r5.status + ' ' + r5.stderr)

// 6. 建档后知识库本身通过校验（工具内已跑 kb-check，退出码透传）
check('建档后 kb-check 通过', r1.status === 0 && !/错误/.test(r1.stdout), r1.stdout)

const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
