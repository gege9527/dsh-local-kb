import { bashWritesKb, commandPathTokens, expandHome } from '../index.js'

// ---- bash 写 KB 判定：先要求写动作，再按 classifyPath 判路径 ----

const KB = '/tmp/kb-bash-test'
const results = []
const check = (name, got, want) => {
  const ok = got === want
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  got=${got} want=${want}`))
}
const w = (command, workdir) => bashWritesKb(KB, workdir === undefined ? { command } : { command, workdir })

check('cp 进 KB', w(`cp /tmp/a.md ${KB}/memory/x.md`), true)
check('重定向进 KB', w(`echo hi > ${KB}/memory/x.md`), true)
check('追加重定向进 KB', w(`echo hi >> ${KB}/memory/x.md`), true)
check('rm KB 文件', w(`rm ${KB}/memory/x.md`), true)
check('mkdir 在 KB', w(`mkdir -p ${KB}/docs/new`), true)
check('cd 进 KB 后写相对路径', w(`cd ${KB} && echo x > y.md`), true)
check('workdir 在 KB + 相对写', w('echo hi > y.md', KB), true)

check('ls KB 只读', w(`ls ${KB}`), false)
check('grep KB 只读', w(`grep -rn foo ${KB}`), false)
check('cat KB 只读', w(`cat ${KB}/memory/MEMORY.md`), false)
check('写到 KB 外', w('echo hi > /tmp/other/x.md'), false)
check('2>&1 不算重定向', w(`ls ${KB} 2>&1`), false)
check('管道不算重定向', w(`ls ${KB} | head -5`), false)
check('git status 无关', w('git status'), false)
check('空命令', w(''), false)

// 展开与 token
check('展开 ~', expandHome('~/x.md') === expandHome('~') + '/x.md', true)
check('展开 $HOME', expandHome('$HOME/x.md'), expandHome('~') + '/x.md')
check('token 提取绝对路径', commandPathTokens('cp a ' + KB + '/x.md').some((t) => t.startsWith(KB)), true)
check('token 提取 ~ 路径', commandPathTokens('ls ~/.local-kb').some((t) => t.startsWith('~')), true)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
if (failed > 0) process.exitCode = 1
