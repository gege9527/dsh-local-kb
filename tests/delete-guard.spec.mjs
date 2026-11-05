import { judgeKbDelete } from '../index.js'

// ---- 删除守卫：AI 不能删 KB 内容，只能归档（mv 进 <KB_ROOT>/archive/） ----

const KB = '/tmp/kb-delete-test'
const results = []
const check = (name, got, want) => {
  const ok = (got !== undefined) === want
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : `  got=${JSON.stringify(got)}`))
}
const judge = (command, workdir) => judgeKbDelete(KB, 'bash', workdir === undefined ? { command } : { command, workdir })

check('rm KB 内文件被拒', judge(`rm ${KB}/memory/x.md`), true)
check('rm -rf KB 被拒', judge(`rm -rf ${KB}`), true)
check('rm 临时文件放行', judge('rm /tmp/build/x.o'), false)
check('rm -rf /tmp 放行', judge('rm -rf /tmp/build'), false)
check('unlink KB 被拒', judge(`unlink ${KB}/memory/x.md`), true)
check('truncate KB 被拒', judge(`truncate -s 0 ${KB}/memory/x.md`), true)
check('shred KB 被拒', judge(`shred ${KB}/memory/x.md`), true)
check('find -delete 被拒', judge(`find ${KB} -name '*.md' -delete`), true)
check('rmdir KB 子目录被拒', judge(`rmdir ${KB}/projects/old`), true)

check('mv 进根层 archive 放行', judge(`mv ${KB}/memory/x.md ${KB}/archive/memory/x.md`), false)
check('项目归档进根层放行', judge(`mv ${KB}/projects/demo ${KB}/archive/projects/demo`), false)
check('mv 到 KB 外被拒', judge(`mv ${KB}/memory/x.md /tmp/`), true)
check('mv 从 KB 外进 KB 放行', judge(`mv /tmp/x.md ${KB}/memory/x.md`), false)

check('ls 放行', judge(`ls ${KB}`), false)
check('grep 放行', judge(`grep -rn x ${KB}`), false)
check('cp 进 KB 放行', judge(`cp /tmp/a.md ${KB}/memory/a.md`), false)
check('workdir 在 KB + rm 相对路径被拒', judge('rm x.md', KB), true)
check('workdir 在 KB + ls 放行', judge('ls', KB), false)

// 变量形式（判不出具体路径时的兜底）
check('rm 变量 KB 路径被拒', judge('rm $KB/memory/x.md'.replace('$KB', KB)), true)

// 复合命令：别处删除 + 顺手读 KB，不该被当成删 KB
check('复合命令不误伤', judge('find ~/.dsh/local-kb/backups -name "*.tmp" -delete && python3 check.py ' + KB), false)
check('复合命令里真的删 KB 仍被拒', judge('find ~/.dsh -delete && rm ' + KB + '/memory/x.md'), true)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
if (failed > 0) process.exitCode = 1
