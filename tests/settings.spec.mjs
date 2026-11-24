import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadPluginSettings, sanitizeRemoteDir, savePluginSettings } from '../index.js'

// ---- 插件设置：远端根目录与自动同步开关 ----

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok ? '' : '  ' + detail))
}

// 远端目录校验
check('普通目录', sanitizeRemoteDir('local-kb-sync') === 'local-kb-sync')
check('去掉首尾斜杠', sanitizeRemoteDir('/kb/sync/') === 'kb/sync')
check('多级目录', sanitizeRemoteDir('a/b') === 'a/b')
check('拒绝 ..', sanitizeRemoteDir('../etc') === undefined)
check('拒绝空串', sanitizeRemoteDir('   ') === undefined)
check('拒绝反斜杠', sanitizeRemoteDir('a\\b') === undefined)
check('拒绝非字符串', sanitizeRemoteDir(42) === undefined)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-settings-'))
const defaults = loadPluginSettings(home)
check('默认远端目录', defaults.remoteDir === 'local-kb-sync', JSON.stringify(defaults))
check('默认关自动同步', defaults.autoSync === false)
check('默认服务商', defaults.provider === 'custom')
check('默认父目录为空（回落主目录）', defaults.parent === null, JSON.stringify(defaults))

// parent：只接受绝对路径；库名固定 .local-kb，不解析自定义库名
check('父目录接受绝对路径', savePluginSettings(home, { parent: '/data' }).parent === '/data')
check('非法父目录保留旧值', loadPluginSettings(home).parent === '/data', JSON.stringify(loadPluginSettings(home)))
const relHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-settings-rel-'))
savePluginSettings(relHome, { parent: 'data/kb' })
check('相对路径不落盘', loadPluginSettings(relHome).parent === null, JSON.stringify(loadPluginSettings(relHome)))
savePluginSettings(home, { parent: null })
check('parent:null 清回默认', loadPluginSettings(home).parent === null)

// 旧文件没有 autoSync 字段：按默认关闭处理，不要偷偷打开
const legacyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-settings-legacy-'))
fs.mkdirSync(path.join(legacyHome, 'local-kb'), { recursive: true })
fs.writeFileSync(path.join(legacyHome, 'local-kb', 'settings.json'), JSON.stringify({ remoteDir: 'old-dir' }))
const legacy = loadPluginSettings(legacyHome)
check('旧配置缺字段时默认关闭', legacy.autoSync === false, JSON.stringify(legacy))
check('旧配置的远端目录保留', legacy.remoteDir === 'old-dir', JSON.stringify(legacy))

const saved = savePluginSettings(home, { remoteDir: 'my-kb', autoSync: false, provider: 'jianguoyun' })
check('保存返回新值', saved.remoteDir === 'my-kb' && saved.autoSync === false && saved.provider === 'jianguoyun', JSON.stringify(saved))
check('文件已写出', fs.existsSync(path.join(home, 'local-kb', 'settings.json')))

const reloaded = loadPluginSettings(home)
check('读回一致', reloaded.remoteDir === 'my-kb' && reloaded.autoSync === false && reloaded.provider === 'jianguoyun', JSON.stringify(reloaded))

const partial = savePluginSettings(home, { autoSync: true })
check('部分更新保留其他字段', partial.remoteDir === 'my-kb' && partial.provider === 'jianguoyun' && partial.autoSync === true, JSON.stringify(partial))

const bad = savePluginSettings(home, { remoteDir: '../escape' })
check('非法远端目录保留旧值', bad.remoteDir === 'my-kb', JSON.stringify(bad))

const failed = results.filter((r) => !r).length
console.log(`\n---- ${results.length - failed} passed, ${failed} failed ----`)
fs.rmSync(home, { recursive: true, force: true })
fs.rmSync(legacyHome, { recursive: true, force: true })
if (failed > 0) process.exitCode = 1
