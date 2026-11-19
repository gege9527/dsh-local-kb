import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// ---- check-privacy：发布前隐私闸（本机路径 / 用户名 / 凭据 / 内网 IP） ----

const here = path.dirname(fileURLToPath(import.meta.url))
const tool = path.join(here, '..', 'scripts', 'check-privacy.mjs')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const make = (files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-privacy-'))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ files: Object.keys(files) }))
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  return root
}
const run = (root) => spawnSync(process.execPath, [tool, '--root', root], { encoding: 'utf8' })

const clean = make({ 'a.js': 'const x = 1\n', 'README.md': '# 说明\n' })
const r1 = run(clean)
check('干净包通过', r1.status === 0, r1.stdout + r1.stderr)

const leak = make({ 'a.js': "const p = '/Users/someone/secret.txt'\n" })
const r2 = run(leak)
check('本机绝对路径拦截', r2.status === 1 && r2.stdout.includes('绝对路径'), r2.status + ' ' + r2.stdout)

const key = make({ 'k.md': '-----BEGIN RSA PRIVATE KEY-----\nxxx\n' })
const r3 = run(key)
check('私钥拦截', r3.status === 1 && r3.stdout.includes('私钥'), r3.status + ' ' + r3.stdout)

const ip = make({ 'n.md': '内网 192.168.5.88 部署\n' })
const r4 = run(ip)
check('内网 IP 拦截', r4.status === 1 && r4.stdout.includes('内网 IP'), r4.status + ' ' + r4.stdout)

const user = make({ 'u.md': '作者 ' + os.userInfo().username + ' 的本机\n' })
const r5 = run(user)
check('本机用户名拦截', r5.status === 1 && r5.stdout.includes('本机用户名'), r5.status + ' ' + r5.stdout)

const sign = make({ 'LICENSE.md': 'MIT © ' + os.userInfo().username + '\n' })
const r6 = run(sign)
check('署名放行', r6.status === 0, r6.status + ' ' + r6.stdout)

for (const d of [clean, leak, key, ip, user, sign]) fs.rmSync(d, { recursive: true, force: true })
const failed = results.filter((ok) => !ok).length
console.log('\n---- ' + (results.length - failed) + ' passed, ' + failed + ' failed ----')
if (failed > 0) process.exitCode = 1
