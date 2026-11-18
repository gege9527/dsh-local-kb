import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ---- 项目改名 / 移动同步工具 ----
// 覆盖：scan 只出计划不动盘、apply 执行迁移、指纹篡改被拒、备份生成、引用与 frontmatter 更新。

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'skills', 'local-kb', 'tools', 'kb-move-project.py')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-move-'))
const root = path.join(base, 'kb')
const projA = path.join(base, 'alpha')
const projB = path.join(base, 'web-轻量化')
fs.mkdirSync(root, { recursive: true })
fs.mkdirSync(projA, { recursive: true })
fs.mkdirSync(projB, { recursive: true })
const write = (rel, text) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
write('paths.yaml', [
  '# 注释保留',
  'alpha:',
  '  path: ' + projA,
  '  git_remote: none',
  'web-lite:',
  '  path: ' + projB,
  '  git_remote: none',
].join('\n'))
write('projects/alpha/alpha.md', '---\ntitle: alpha\nproject_id: alpha\ntype: code-project\n---\n\n## 这是什么\n\nalpha 项目\n')
write('projects/web-lite/web-lite.md', '---\ntitle: 轻量 Web 版\nproject_id: web-lite\ntype: code-project\n---\n\n## 这是什么\n\nweb 项目\n')
write('projects/web-lite/memory/MEMORY.md', '# Memory\n\n- [某结论](x.md) — 说明\n')
write('projects/web-lite/memory/x.md', '---\nname: x\ndescription: 一条结论\ntype: reference\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n内容：web-lite 的结论\n')
write('docs/ref.md', '---\ntitle: 引用\ntype: doc\nsource: 会话产出\ndate_added: "2026-01-01"\n---\n\n# 引用\n\n见 projects/web-lite/web-lite.md 与 projects/web-lite/memory/\n')
write('docs/topic/_topic.md', '---\ntopic: T\nprojects:\n  - web-lite\n---\n')

const run = (args) => execFileSync('python3', [tool, root, ...args], { encoding: 'utf8' })

// 1. scan 只出计划
const planPath = path.join(root, 'plan.json')
const out1 = run(['--scan', '--plan', planPath])
check('scan 识别出 1 项改名', out1.includes('web-lite') && out1.includes('web-轻量化'), out1)
check('scan 写出计划文件', fs.existsSync(planPath))
check('scan 不动盘', fs.existsSync(path.join(root, 'projects/web-lite')))
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'))
check('计划含指纹', typeof plan.fingerprint === 'string' && plan.fingerprint.length === 64)
check('计划记录了引用文件', plan.moves[0].ref_files.includes('docs/ref.md'), JSON.stringify(plan.moves[0].ref_files))

// 2. 篡改计划被拒
const tampered = path.join(root, 'tampered.json')
const bad = JSON.parse(JSON.stringify(plan))
bad.moves[0].id_new = 'hacked'
fs.writeFileSync(tampered, JSON.stringify(bad, null, 2))
let refused = false
try { run(['--apply', '--plan', tampered]) } catch (e) { refused = true }
check('指纹不匹配时拒绝执行', refused)
check('拒绝后仍不改盘', fs.existsSync(path.join(root, 'projects/web-lite')))

// 3a. 正文裸 id 默认拒绝（避免短 id 误伤源码路径与普通用词）
let bodyRefused = false
try { run(['--apply', '--plan', planPath]) } catch (e) { bodyRefused = true }
check('正文裸 id 默认拒绝', bodyRefused && fs.existsSync(path.join(root, 'projects/web-lite')), '未被拦截')

// 3b. apply 执行（显式允许正文改写）
const out3 = run(['--apply', '--plan', planPath, '--allow-body-rewrite'])
check('apply 输出完成信息', out3.includes('完成') && out3.includes('备份'), out3)
check('目录已改名', fs.existsSync(path.join(root, 'projects/web-轻量化')) && !fs.existsSync(path.join(root, 'projects/web-lite')))
check('项目页改名并更新 frontmatter', fs.readFileSync(path.join(root, 'projects/web-轻量化/web-轻量化.md'), 'utf8').includes('project_id: web-轻量化'))
check('人类标题不被 id 覆盖', fs.readFileSync(path.join(root, 'projects/web-轻量化/web-轻量化.md'), 'utf8').includes('title: 轻量 Web 版'))
check('记忆目录跟随移动', fs.existsSync(path.join(root, 'projects/web-轻量化/memory/MEMORY.md')))
check('自己项目内的旧 id 也替换', fs.readFileSync(path.join(root, 'projects/web-轻量化/memory/x.md'), 'utf8').includes('web-轻量化 的结论'), '')
check('路径引用已替换', fs.readFileSync(path.join(root, 'docs/ref.md'), 'utf8').includes('projects/web-轻量化/memory/'))
check('裸 id 引用已替换', fs.readFileSync(path.join(root, 'docs/topic/_topic.md'), 'utf8').includes('- web-轻量化'), fs.readFileSync(path.join(root, 'docs/topic/_topic.md'), 'utf8'))
const pathsText = fs.readFileSync(path.join(root, 'paths.yaml'), 'utf8')
check('paths.yaml 改 id 保留 path 与注释', pathsText.includes('web-轻量化:') && pathsText.includes(projB) && pathsText.includes('# 注释保留'), pathsText)
check('未涉及的项目没被动', pathsText.includes('alpha:') && pathsText.includes(projA))
const backups = fs.existsSync(path.join(root, '.backup')) ? fs.readdirSync(path.join(root, '.backup')) : []
check('生成了备份', backups.length === 1 && backups[0].endsWith('.tar.gz'), JSON.stringify(backups))

// 4. 再次 scan 应为 0 项
const out4 = run(['--scan'])
check('迁移后 scan 无待改项', out4.includes('计划 0 项'), out4)

// 5. 真实移动：计划里 path_old 必须是旧路径（旧实现先覆盖再记录，恒等于新路径）
const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-move2-'))
const root2 = path.join(base2, 'kb')
const oldDir = path.join(base2, 'zz-old')
const newDir = path.join(base2, 'zz-new')
fs.mkdirSync(root2, { recursive: true })
fs.mkdirSync(oldDir, { recursive: true })
fs.mkdirSync(newDir, { recursive: true })
const write2 = (rel, text) => {
  const abs = path.join(root2, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
write2('paths.yaml', 'zz-old:\n  path: ' + oldDir + '\n  git_remote: none\n')
write2('projects/zz-old/zz-old.md', '---\ntitle: zz-old\nproject_id: zz-old\n---\n')
const plan2Path = path.join(base2, 'plan2.json')
const out5 = execFileSync('python3', [tool, root2, '--from-path', oldDir, '--to-path', newDir, '--plan', plan2Path], { encoding: 'utf8' })
const plan2 = JSON.parse(fs.readFileSync(plan2Path, 'utf8'))
check('移动场景标记为「移动」', out5.includes('移动'), out5)
check('计划记录旧路径', plan2.moves[0].path_old === oldDir, JSON.stringify(plan2.moves[0].path_old))
check('计划记录新路径', plan2.moves[0].path_new === newDir, JSON.stringify(plan2.moves[0].path_new))
fs.rmSync(base2, { recursive: true, force: true })

const failed = results.filter((r) => !r).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
fs.rmSync(base, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
