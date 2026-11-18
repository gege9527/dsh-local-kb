import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { downloadRoot, shouldAutoUpload, syncRoot } from '../index.js'

// ---- 远端镜像：本地什么样远端什么样；垃圾文件排除；多余项删除 ----

const remote = new Map() // rel -> content（内存里的「远端」）
let propfindCount = 0 // 验证「无变化时不扫远端」

const xml = (p, dir) => '<D:response><D:href>' + p + '</D:href><D:propstat><D:prop><D:resourcetype>' +
  (dir ? '<D:collection/>' : '') + '</D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>'

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local')
  const rel = decodeURIComponent(url.pathname).replace(/^\/dav\/local-kb-sync\/?/, '').replace(/\/+$/, '')
  if (req.method === 'MKCOL') { res.writeHead(201); res.end(); return }
  if (req.method === 'PUT') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { remote.set(rel, body); res.writeHead(201); res.end() })
    return
  }
  if (req.method === 'DELETE') {
    remote.delete(rel)
    res.writeHead(204)
    res.end()
    return
  }
  if (req.method === 'GET') {
    if (!remote.has(rel)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(remote.get(rel))
    return
  }
  if (req.method === 'PROPFIND') {
    propfindCount++
    const prefix = rel === '' ? '' : rel + '/'
    const items = new Set()
    for (const key of remote.keys()) {
      if (prefix !== '' && !key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (rest === '') continue
      items.add(rest.includes('/') ? rest.split('/')[0] + '/' : rest)
    }
    const parts = ['<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">']
    parts.push(xml('/dav/local-kb-sync/' + (rel === '' ? '' : rel), true))
    for (const item of items) parts.push(xml('/dav/local-kb-sync/' + prefix + item, item.endsWith('/')))
    parts.push('</D:multistatus>')
    res.writeHead(207, { 'content-type': 'application/xml' })
    res.end(parts.join(''))
    return
  }
  res.writeHead(405)
  res.end()
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const url = 'http://127.0.0.1:' + port + '/dav'

const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-mirror-'))
const write = (rel, text) => {
  const abs = path.join(kb, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}
write('README.md', 'readme')
write('docs/a.md', 'doc a')
write('projects/p/p.md', 'page')
write('.DS_Store', 'junk')
write('docs/.DS_Store', 'junk')
// 卡片索引是生成物：新设备重建即可，不该占同步带宽
write('.kb-index/cards/docs-a.md', '---\ndoc: docs/a.md\n---\n')
write('.kb-index/.card-version', '3\n')
// kb-move 的整库快照只在本地回滚用，不能占同步带宽
write('.backup/20260101-000000.tar.gz', 'snapshot')

// 远端预置：一个本地已删的旧文件、一个垃圾文件、一个已删的文档
remote.set('stale.md', 'old')
remote.set('.DS_Store', 'junk')
remote.set('docs/old.md', 'old doc')
remote.set('README.md', 'outdated')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

const first = await syncRoot({ kbRoot: kb, url, user: 'u', password: 'p', previousMap: {} })
check('首次推送 3 个文件', first.pushed.length === 3, JSON.stringify(first.pushed))
check('垃圾文件不推送', !first.pushed.some((r) => r.includes('.DS_Store')), JSON.stringify(first.pushed))
check('删除远端多余 3 项', first.deleted.length === 3, JSON.stringify(first.deleted))
check('删除包含已删笔记', first.deleted.includes('stale.md'))
check('删除包含垃圾文件', first.deleted.includes('.DS_Store'))
check('远端最终与本地一致', [...remote.keys()].sort().join(',') === 'README.md,docs/a.md,projects/p/p.md', JSON.stringify([...remote.keys()]))
check('内容被覆盖为本地版本', remote.get('README.md') === 'readme')
check('卡片索引不进推送', !first.pushed.some((r) => r.startsWith('.kb-index/')), JSON.stringify(first.pushed))
check('远端不含卡片索引', ![...remote.keys()].some((r) => r.startsWith('.kb-index/')))
check('备份快照不进推送', !first.pushed.some((r) => r.startsWith('.backup/')), JSON.stringify(first.pushed))
check('远端不含备份快照', ![...remote.keys()].some((r) => r.startsWith('.backup/')))

const previousMap = first.fileMap
const scansBefore = propfindCount
const second = await syncRoot({ kbRoot: kb, url, user: 'u', password: 'p', previousMap })
check('无变化时不重复推送', second.pushed.length === 0, JSON.stringify(second.pushed))
check('无变化时无删除', second.deleted.length === 0, JSON.stringify(second.deleted))
check('无变化时跳过远端扫描', propfindCount === scansBefore, '多了 ' + (propfindCount - scansBefore) + ' 次 PROPFIND')
check('跳过时标记 skipped', second.skipped === true, JSON.stringify(second.skipped))

// 本地删一个文件 → 远端跟着删
fs.rmSync(path.join(kb, 'docs', 'a.md'))
write('docs/new.md', 'new')
const third = await syncRoot({ kbRoot: kb, url, user: 'u', password: 'p', previousMap: second.fileMap })
check('新增文件被推送', third.pushed.includes('docs/new.md'), JSON.stringify(third.pushed))
check('本地删除被镜像到远端', third.deleted.includes('docs/a.md'), JSON.stringify(third.deleted))
check('远端不再有该文件', !remote.has('docs/a.md'))

// 下载方向：云端覆盖本地同名文件；本地多出来的保留
remote.set('docs/a.md', 'cloud version')
remote.set('docs/cloud-only.md', 'only in cloud')
fs.writeFileSync(path.join(kb, 'docs/local-only.md'), 'only local')
const down = await downloadRoot({ kbRoot: kb, url, user: 'u', password: 'p' })
check('下载写入云端文件', down.written.includes('docs/a.md') && down.written.includes('docs/cloud-only.md'), JSON.stringify(down.written))
check('云端内容覆盖本地', fs.readFileSync(path.join(kb, 'docs/a.md'), 'utf8') === 'cloud version')
check('云端独有文件落到本地', fs.existsSync(path.join(kb, 'docs/cloud-only.md')))
check('本地独有文件不被删除', fs.existsSync(path.join(kb, 'docs/local-only.md')))
check('下载失败清单为空', down.failed.length === 0, JSON.stringify(down.failed))

// ---- 上传闸门：体检常开，上传只看开关（默认关） ----
check('默认关：auto 链路不上传', shouldAutoUpload(false) === false)
check('默认值 undefined 视为关', shouldAutoUpload(undefined) === false)
check('显式开：auto 链路上传', shouldAutoUpload(true) === true)
check('非布尔值不放开', shouldAutoUpload('true') === false)

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
server.close()
fs.rmSync(kb, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
