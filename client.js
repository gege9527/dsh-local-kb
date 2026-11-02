/**
 * Browser half of dsh-local-kb: the "知识库" settings section.
 *
 * Registers into `settings.section` (id 'knowledge-base') so the settings
 * dialog's left nav gains a "知识库" entry and the page renders our panel.
 * Zero-build lazy-CJS via window.__ModuleLoader__.load — same pattern as the
 * dsh-checkpoint-memory / dsh-turn-undo browser halves.
 *
 * The page shows:
 *   - KB root location plus two open buttons. Both reuse DSH's OWN native open
 *     capability through `ctx.remote.session.openWorkspacePath`
 *     (reveal = file manager; open with an application id = VSCode), the exact
 *     same Remote the shipped "open in app" controls use. Nothing is reimplemented.
 *   - WebDAV configuration: url / username / password. Credentials are stored
 *     through `ctx.remote.credentials.set` — the same DSH credential service the
 *     Models page uses for API keys ($DSH_HOME/.credentials.yaml, 0600). The
 *     password field never shows a stored value: if a password is configured
 *     the field renders empty with a "enter to change" hint, identical to the
 *     API-key behavior the user asked to match.
 *   - Test link and Sync now buttons, plus a status area. A failed sync renders
 *     a red banner (--dsw-alias-state-error-primary) with the failure time.
 *
 * All Host data travels over the static-plugin JSON routes
 * /api/local-kb/state, /sync, /test-link (registered by index.js).
 */
window.__ModuleLoader__.load({
  id: 'dsh-local-kb',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var NS = 'dsh-local-kb'
    // factory 级共享：settings.section 槽不支持 inject face（slotInject 为空），
    // 所以 remote 在注册时从 ctx 取好，组件直接引用同一个闭包变量。
    var pluginRemote = null
    var pluginCtx = null
    var pluginRemoteReady = false
    var API_STATE = '/api/local-kb/state'
    var API_SYNC = '/api/local-kb/sync'
    var API_TEST = '/api/local-kb/test-link'
    var API_OVERVIEW = '/api/local-kb/overview'

    var CRED_URL = 'dsh_local_kb_webdav_url'
    var CRED_USER = 'dsh_local_kb_webdav_user'
    var CRED_PASSWORD = 'dsh_local_kb_webdav_password'

    function isZh() {
      var lang = (typeof navigator !== 'undefined' && navigator.language) || 'en'
      return lang.indexOf('zh') === 0
    }
    var T = {
      nav: isZh() ? '知识库' : 'Knowledge Base',
      sectionTitle: isZh() ? '知识库' : 'Knowledge Base',
      sectionDesc: isZh()
        ? '集中管理 local-kb 知识库：位置、打开、WebDAV 同步。写入知识库目录后自动同步。'
        : 'Manage the local-kb knowledge base: location, open, WebDAV sync. Changes under the KB directory sync automatically.',
      kbLocation: isZh() ? '知识库位置' : 'Knowledge base location',
      openFolder: isZh() ? '打开文件夹' : 'Open Folder',
      openVscode: isZh() ? '使用 VSCode 打开' : 'Open in VSCode',
      vscodeMissing: isZh() ? '未找到 VSCode 应用' : 'VSCode application not found',
      desktopUnavailable: isZh() ? '当前环境不支持打开本地文件夹' : 'Opening local folders is unavailable in this environment',
      opened: isZh() ? '已打开' : 'Opened',
      openFailed: isZh() ? '打开失败' : 'Open failed',
      notInstalled: isZh() ? '技能尚未安装到 $DSH_HOME/skills/local-kb' : 'Skill not installed to $DSH_HOME/skills/local-kb',
      webdavTitle: isZh() ? 'WebDAV 同步' : 'WebDAV Sync',
      webdavDesc: isZh()
        ? '配置后，AI 向知识库写入内容会自动同步到远端（异步，失败不阻塞对话）。'
        : 'When configured, KB writes sync to the remote automatically (async; a failure never blocks the conversation).',
      url: isZh() ? 'WebDAV 链接' : 'WebDAV URL',
      urlPh: isZh() ? 'https://dav.example.com/kb' : 'https://dav.example.com/kb',
      user: isZh() ? '用户名' : 'Username',
      password: isZh() ? '密码' : 'Password',
      passwordPh: isZh() ? '已设置：输入新密码以修改' : 'Set: type a new password to change',
      passwordEmptyPh: isZh() ? '输入密码' : 'Enter password',
      save: isZh() ? '保存配置' : 'Save',
      saved: isZh() ? '配置已保存' : 'Saved',
      saveFailed: isZh() ? '保存失败：' : 'Save failed: ',
      test: isZh() ? '测试链接' : 'Test Link',
      testing: isZh() ? '测试中…' : 'Testing…',
      syncNow: isZh() ? '立即同步' : 'Sync Now',
      syncTimeout: isZh() ? '同步超时（30 秒）' : 'Sync timed out (30s)',
      syncing: isZh() ? '同步中…' : 'Syncing…',
      syncOk: isZh() ? '同步完成' : 'Sync complete',
      never: isZh() ? '从未同步' : 'Never synced',
      lastOk: isZh() ? '上次同步成功' : 'Last sync succeeded',
      lastFailed: isZh() ? '上次同步失败' : 'Last sync failed',
      // 校验结果（failed/warn）不在设置页展示，故不保留对应文案。
      pushed: isZh() ? '新增/更新 {n} 个文件' : '{n} file(s) pushed',
      more: isZh() ? '更多打开方式' : 'More open options',
      openWith: isZh() ? '用 {app} 打开' : 'Open with {app}',
      aboutTitle: isZh() ? '插件说明' : 'About this plugin',
      aboutAutoClean: isZh()
        ? 'hooks（写入即同步、KB-first 提醒、定时器、API 路由）随插件禁用/卸载自动清理，无需手动处理。'
        : 'Hooks (write-sync, KB-first reminder, timers, API routes) are auto-cleaned when the plugin is disabled or uninstalled — nothing to do manually.',
      aboutManualClean: isZh()
        ? '不会自动删除：在插件目录运行 node install-skill.js --uninstall 可移除技能副本与 AGENTS.md 常驻块（块外内容保留）；WebDAV 凭据需手动删除。'
        : 'Not auto-removed: run node install-skill.js --uninstall in the plugin directory to remove the skill copy and the KB_LOCAL block (content outside it is kept); WebDAV credentials must be deleted by hand.',
      syncFailedAt: isZh() ? '同步失败（{time}）：{reason}' : 'Sync failed at {time}: {reason}',
      checkPrefix: isZh() ? '知识库体检' : 'KB check',
      checkOk: isZh() ? '通过' : 'passed',
      checkWarn: isZh() ? '有警告' : 'warnings',
      checkFail: isZh() ? '未通过' : 'failed',
      checkNever: isZh() ? '尚未校验（写入知识库后自动运行）' : 'not checked yet (runs after a KB write)',
      overviewTitle: isZh() ? '知识库内容' : 'What is in the KB',
      overviewSummary: isZh() ? '{projects} 个项目 · {docs} 个文档' : '{projects} projects · {docs} docs',
      overviewNoPath: isZh() ? '未登记路径' : 'no path in paths.yaml',
      overviewMissing: isZh() ? '路径不存在' : 'path missing',
      overviewNone: isZh() ? '还没有项目' : 'no projects yet',
      loading: isZh() ? '加载中…' : 'Loading…',
      auto: isZh() ? '自动' : 'auto',
      manual: isZh() ? '手动' : 'manual'
    }

    function fmtTime(iso) {
      if (!iso) return ''
      try {
        var d = new Date(iso)
        var pad = function (n) { return n < 10 ? '0' + n : '' + n }
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
      } catch (e) { return iso }
    }

    // ---- tiny fetch helpers -------------------------------------------------
    function getJson(url) {
      return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() })
    }
    function postJson(url, body) {
      // 30s 超时：WebDAV 大目录首次建链可能慢，但绝不永久卡「同步中」。
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null
      var timer = controller ? setTimeout(function () { controller.abort() }, 30000) : null
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: controller ? controller.signal : undefined,
      }).then(function (r) { return r.json() }).finally(function () { if (timer) clearTimeout(timer) })
    }

    /* =====================================================================
     * Host data (credentials + open path) —— 注入面由 registerSection 提供。
     * =================================================================== */
    /* =====================================================================
     * Section component
     * =================================================================== */
    function KnowledgeBaseSection(props) {
      var React = require('react')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      // 打开能力：官方 open-in-app 通道（web 部署内置、已验证）。
      //  - 应用列表：GET /open-in-app/apps（返回安装的应用 id 目录）
      //  - 打开目录：POST /open-in-app/open { app, path }（path 必须绝对目录路径）
      //  - 应用名/图标：通过 /open-in-app/icon/<id> 与 APPLICATIONS 目录映射。
      // 凭据仍走 remote.credentials（describe/set 在渲染期现取）。
      function currentRemote() {
        // inject 后 apply 阶段已捕获 pluginRemote（proxy 已可访问）。防御性再验一次。
        return pluginRemote
      }
      function describeCredential(ref) {
        var remote = currentRemote()
        if (!remote || !remote.credentials || typeof remote.credentials.describe !== 'function') return Promise.resolve(null)
        return remote.credentials.describe([ref]).then(function (r) { return r.ok ? (r.value || {})[ref] : null }).catch(function () { return null })
      }
      function setCredential(ref, value) {
        var remote = currentRemote()
        if (!remote || !remote.credentials || typeof remote.credentials.set !== 'function') return Promise.reject(new Error('credentials service unavailable'))
        // 官方 models/operations.ts：set 后必须检查 response.ok，失败抛错，不能静默吞
        return remote.credentials.set(ref, value).then(function (r) {
          if (r && r.ok) return r
          var msg = r && r.error && r.error.message ? r.error.message : 'credential set failed'
          throw new Error(msg)
        })
      }
      // ---- open-in-app 应用目录（与官方 APP_LABEL_KEY 一致）----
      var APP_NAMES = {
        'cursor': 'Cursor',
        'vscode': 'VS Code',
        'vscodeinsiders': 'VS Code Insiders',
        'windsurf': 'Windsurf',
        'zed': 'Zed',
        'sublimetext': 'Sublime Text',
        'xcode': 'Xcode',
        'androidstudio': 'Android Studio',
        'intellij': 'IntelliJ IDEA',
        'pycharm': 'PyCharm',
        'webstorm': 'WebStorm',
        'phpstorm': 'PhpStorm',
        'goland': 'GoLand',
        'rider': 'Rider',
        'rustrover': 'RustRover',
        'fork': 'Fork',
        'sourcetree': 'Sourcetree',
        'github': 'GitHub Desktop',
        'tower': 'Tower',
        'gitkraken': 'GitKraken',
        'smartgit': 'SmartGit',
        'sublimemerge': 'Sublime Merge',
        'ghostty': 'Ghostty',
        'warp': 'Warp',
        'iterm': 'iTerm2',
        'kitty': 'kitty',
        'windowsterminal': 'Windows Terminal',
        'gitbash': 'Git Bash',
        'gnometerminal': 'GNOME Terminal',
        'konsole': 'Konsole',
        'finder': '访达',
        'explorer': '文件资源管理器',
        'filemanager': '文件管理器',
        'terminal': '终端'
      }
      function openKbRoot() {
        // 官方 open-in-app/open：用默认应用打开知识库目录（document-relative 路径）
        if (!info || !info.kbRoot) return
        fetch('open-in-app/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app: 'finder', path: info.kbRoot }),
        }).then(function (r) {
          showNotice(r.ok ? 'ok' : 'error', r.ok ? T.opened : T.openFailed)
        }).catch(function () { showNotice('error', T.openFailed) })
      }

      var [info, setInfo] = useState(null)
      var [url, setUrl] = useState('')
      var [user, setUser] = useState('')
      var [pw, setPw] = useState('')
      var [pwConfigured, setPwConfigured] = useState(false)
      var [urlConfigured, setUrlConfigured] = useState(false)
      var [busy, setBusy] = useState('')      // '' | 'test' | 'sync' | 'save'
      var [notice, setNotice] = useState(null) // 瞬态 toast：{ kind, text }，自动消失
      var noticeTimer = null
      function showNotice(kind, text) {
        setNotice({ kind: kind, text: text })
        if (noticeTimer !== null) clearTimeout(noticeTimer)
        noticeTimer = setTimeout(function () { clearNotice(); noticeTimer = null }, 3000)
      }
      function clearNotice() {
        if (noticeTimer !== null) { clearTimeout(noticeTimer); noticeTimer = null }
        setNotice(null)
      }
      var [syncState, setSyncState] = useState({})
      var [overview, setOverview] = useState(null)

      function refreshState() {
        return getJson(API_STATE).then(function (data) {
          if (data && data.kbRoot) {
            setInfo(data); setSyncState(data.state || {})
            // host 回显已存凭据：URL/用户名回填（密码永不回显，describe 不返回值）
            if (typeof data.webdavUrl === 'string' && data.webdavUrl !== '') setUrl(data.webdavUrl)
            if (typeof data.webdavUser === 'string' && data.webdavUser !== '') setUser(data.webdavUser)
          }
          return data
        }).catch(function () { /* 状态读取失败静默降级：不打扰用户，等下次轮询重试 */ })
      }

      function loadCredentials() {
        if (!describeCredential) return
        // describe 只报 configured 不返回值。已配置：URL/用户名回填可见（用户知道配过），
        // 密码留空 + placeholder 提示「输入新密码以修改」。
        describeCredential(CRED_PASSWORD).then(function (p) { setPwConfigured(!!(p && p.configured)) })
        describeCredential(CRED_URL).then(function (u) {
          if (u && u.configured) setUrlConfigured(true)
        })
      }

      useEffect(function () {
        // 状态持久化在 host 的 .kb-sync-state.json：打开设置页拉一次即最新，
        // 无需轮询。操作（保存/测试/同步）后各自 refreshState()。
        refreshState()
        loadCredentials()
        // 只读快照：项目清单、记忆条数、索引行数、文档数。不读任何文档正文。
        getJson(API_OVERVIEW).then(function (data) {
          if (data && data.ok) setOverview(data)
        }).catch(function () { /* 读不到就不显示这一块 */ })
      }, [])

      function saveConfig() {
        setBusy('save')
        clearNotice()
        var urlVal = url.trim()
        var chain = Promise.resolve()
        if (urlVal) chain = chain.then(function () { return setCredential(CRED_URL, urlVal) })
        if (user.trim()) chain = chain.then(function () { return setCredential(CRED_USER, user.trim()) })
        if (pw) chain = chain.then(function () { return setCredential(CRED_PASSWORD, pw) })
        chain.then(function () {
          showNotice('ok', T.saved)
          // 仅清空密码框（安全：密码不回显）；URL/用户名保留 —— 用户能看出已配置。
          setPw('')
          loadCredentials()
          return refreshState()
        }).catch(function (e) {
          // set 失败（response.ok=false 已转 throw）—— 必须如实报错，不能再显示成功
          showNotice('error', T.saveFailed + (e && e.message ? e.message : String(e)))
        }).finally(function () { setBusy('') })
      }

      function doTest() {
        setBusy('test')
        clearNotice()
        postJson(API_TEST, { url: url.trim(), user: user.trim(), password: pw }).then(function (r) {
          if (r && r.ok) showNotice('ok', (r.reason || T.test) )
          else showNotice('error', (r && r.reason) || T.test )
        }).catch(function (e) {
          showNotice('error', e && e.message ? e.message : String(e) )
        }).finally(function () { setBusy('') })
      }

      function doSync() {
        setBusy('sync')
        clearNotice()
        postJson(API_SYNC, {}).then(function (r) {
          if (r && r.ok) {
            showNotice('ok', T.syncOk + (r.pushed ? '（' + T.pushed.replace('{n}', r.pushed) + '）' : ''))
          } else {
            showNotice('error', (r && r.reason) || T.syncOk )
          }
          if (r) setSyncState(r.state || {})
        }).catch(function (e) {
          var msg = e && e.message ? e.message : String(e)
          if (e && e.name === 'AbortError') msg = T.syncTimeout
          showNotice('error', msg)
        }).finally(function () { setBusy('') })
      }

      // ---- styles (scoped) ----
      var css = [
        // 布局
        '.dsh-lkb-section{display:flex;flex-direction:column;gap:20px;padding:4px 2px 16px;color:var(--dsw-alias-label-primary)}',
        '.dsh-lkb-desc{font-size:12px;color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}',
        // 卡片：与设置页 section 同源 —— 无独立卡片背景，只有字段分隔线（官方 settings-form 风格）
        '.dsh-lkb-card{display:flex;flex-direction:column;gap:12px}',
        '.dsh-lkb-split{border-bottom:.5px solid var(--dsw-alias-border-l2);padding-bottom:16px}',
        '.dsh-lkb-label{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);margin:0}',
        '.dsh-lkb-pathrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
        '.dsh-lkb-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-primary);word-break:break-all;flex:1;min-width:120px}',
        // 字段：官方 settings-models 字段布局（fieldLabel 12px label-secondary）
        '.dsh-lkb-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
        '.dsh-lkb-field + .dsh-lkb-field{border-top:.5px solid var(--dsw-alias-border-l2)}',
        // 输入框：官方 settings-models .input（32px / 0.5px l4 / radius-md / bg-layer-1 / focus business / 14px 字）
        '.dsh-lkb-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
        '.dsh-lkb-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
        '.dsh-lkb-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
        '.dsh-lkb-input:disabled{opacity:.6;cursor:default}',
        // 按钮：官方 Button 组件 token（primary/ghost/outline），无白底
        '.dsh-lkb-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-sm);cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 10px;height:28px}',
        '.dsh-lkb-btn:disabled{cursor:not-allowed;opacity:.4}',
        '.dsh-lkb-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
        '.dsh-lkb-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
        '.dsh-lkb-btn-ghost{background:transparent;color:var(--dsw-alias-label-primary)}',
        '.dsh-lkb-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsh-lkb-btn-ghost:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
        '.dsh-lkb-btn-outline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
        '.dsh-lkb-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.dsh-lkb-btn-danger{color:var(--dsw-alias-state-error-primary);border:.5px solid var(--dsw-alias-border-l3);background:transparent}',
        '.dsh-lkb-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        // split 打开按钮：outline 款，无白底
        // 操作行
        '.dsh-lkb-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        // 提示/横幅
        // toast：瞬态浮层（3s 自动消失，不占正文布局）
        '.dsh-lkb-toast{position:fixed;top:16px;right:16px;z-index:9999;max-width:320px;padding:8px 12px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.16);animation:dshLkbToastIn .18s ease-out}',
        '.dsh-lkb-toast-ok{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:.5px solid var(--dsw-alias-border-l3)}',
        '.dsh-lkb-toast-error{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-state-error-primary);border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent)}',
        '@keyframes dshLkbToastIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
        // 状态行
        '.dsh-lkb-status{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dsh-lkb-status-fail{color:var(--dsw-alias-state-error-primary);font-weight:500}',
        '.dsh-lkb-status-warn{color:var(--dsw-alias-state-warn-primary);font-weight:500}',
        '.dsh-lkb-status-ok{color:var(--dsw-alias-state-success-primary)}'
      ].join('\n')

      // 构造 inputs
      var urlInput = h('input', {
        className: 'dsh-lkb-input', type: 'text', value: url, placeholder: T.urlPh,
        onChange: function (e) { setUrl(e.target.value) }
      })
      var userInput = h('input', {
        className: 'dsh-lkb-input', type: 'text', value: user, placeholder: T.user,
        onChange: function (e) { setUser(e.target.value) }
      })
      var pwInput = h('input', {
        className: 'dsh-lkb-input', type: 'password', value: pw, autoComplete: 'new-password',
        placeholder: pwConfigured ? T.passwordPh : T.passwordEmptyPh,
        onChange: function (e) { setPw(e.target.value) }
      })

      // 状态条：只显示同步状态。校验结果（failed/warn）属于知识库内容质量，不在设置页提示。
      var lastStatus = syncState && syncState.lastSyncStatus
      // 状态区：始终显示最新状态 —— 失败红色，成功绿色带时间，从未同步才灰。
      var line = null
      if (lastStatus === 'failed' && syncState.lastSyncAt) {
        line = { text: T.syncFailedAt.replace('{time}', fmtTime(syncState.lastSyncAt)).replace('{reason}', syncState.lastError || ''), cls: 'dsh-lkb-status-fail' }
      } else if (lastStatus === 'ok' && syncState.lastSyncAt) {
        line = { text: T.lastOk + '（' + fmtTime(syncState.lastSyncAt) + '）', cls: 'dsh-lkb-status-ok' }
      }
      // 体检结果：kb-check.py --json 的统计与前几条警告。只读展示，删除/修复由用户决定。
      var stats = syncState && syncState.lastCheckStats
      var checkStatus = syncState && syncState.lastCheckStatus
      var checkLine = null
      if (checkStatus) {
        var checkLabel = checkStatus === 'ok' ? T.checkOk : checkStatus === 'warn' ? T.checkWarn : T.checkFail
        var checkDetail = stats
          ? '（' + (isZh() ? '记忆 ' + stats.memories + ' 条 / 文档 ' + stats.docs + ' 个' : stats.memories + ' notes / ' + stats.docs + ' docs') + '）'
          : ''
        var checkCls = checkStatus === 'ok' ? 'dsh-lkb-status-ok' : checkStatus === 'warn' ? 'dsh-lkb-status-warn' : 'dsh-lkb-status-fail'
        checkLine = h('span', { className: checkCls },
          T.checkPrefix + '：' + checkLabel + checkDetail + (syncState.lastCheckAt ? ' · ' + fmtTime(syncState.lastCheckAt) : ''))
      }
      var warnList = (syncState && syncState.lastCheckWarns) || []
      var warnEls = warnList.slice(0, 3).map(function (w, i) {
        return h('span', { key: 'w' + i, className: 'dsh-lkb-status-warn' }, '· ' + w)
      })
      var statusEl = h('div', { className: 'dsh-lkb-status' },
        line ? h('span', { className: line.cls }, line.text)
          : h('span', null, T.never),
        checkLine || h('span', null, T.checkNever),
        warnEls.length > 0 ? warnEls : null)

      var noticeEl = notice ? h('div', { className: 'dsh-lkb-toast dsh-lkb-toast-' + (notice.kind === 'error' ? 'error' : 'ok'), role: 'status' },
        notice.text) : null

      return h(React.Fragment, null,
        h('style', { dangerouslySetInnerHTML: { __html: css } }),
        h('div', { className: 'dsh-lkb-section' },
          h('p', { className: 'dsh-lkb-desc' }, T.sectionDesc),

          // 知识库内容（只读）：项目、记忆条数、索引行数、文档数
          overview ? h('div', { className: 'dsh-lkb-card' },
            h('div', { className: 'dsh-lkb-label' }, T.overviewTitle),
            h('p', { className: 'dsh-lkb-desc' },
              T.overviewSummary
                .replace('{projects}', String(overview.projects.length))
                .replace('{docs}', String(overview.docs))),
            overview.projects.length === 0
              ? h('p', { className: 'dsh-lkb-desc' }, T.overviewNone)
              : h('div', { className: 'dsh-lkb-status' },
                overview.projects.slice(0, 12).map(function (p) {
                  var mark = p.path === null ? T.overviewNoPath : p.pathExists === false ? T.overviewMissing : ''
                  return h('span', { key: p.id, className: p.pathExists === false ? 'dsh-lkb-status-warn' : '' },
                    p.id + ' · ' + (isZh() ? '记忆 ' : 'notes ') + p.memories +
                    ' · ' + (isZh() ? '索引 ' : 'index ') + p.indexLines + (isZh() ? ' 行' : ' lines') +
                    (mark ? ' · ' + mark : ''))
                }))
          ) : null,

          // 插件说明（关于本插件：卸载行为与手动清理指引）
          h('div', { className: 'dsh-lkb-card' },
            h('div', { className: 'dsh-lkb-label' }, T.aboutTitle),
            h('p', { className: 'dsh-lkb-desc' }, T.aboutAutoClean),
            h('p', { className: 'dsh-lkb-desc' }, T.aboutManualClean)),

          // 位置 + 打开（split 按钮，复刻官方 open-in-app 控件：主按钮=默认应用，chevron=菜单）
          h('div', { className: 'dsh-lkb-card dsh-lkb-split' },
            h('div', { className: 'dsh-lkb-label' }, T.kbLocation),
                          h('div', { className: 'dsh-lkb-pathrow' },
                h('span', { className: 'dsh-lkb-path' }, info ? info.kbRoot : (T.loading)),
                h('button', { type: 'button', className: 'dsh-lkb-btn dsh-lkb-btn-outline', onClick: openKbRoot, disabled: !info }, T.openFolder)
              ),
              !info || info.installed ? null : h('p', { className: 'dsh-lkb-desc' }, T.notInstalled)),

          // WebDAV 配置
          h('div', { className: 'dsh-lkb-card' },
            h('div', { className: 'dsh-lkb-label' }, T.webdavTitle),
            h('p', { className: 'dsh-lkb-desc' }, T.webdavDesc),
            h('div', { className: 'dsh-lkb-field' }, h('label', { className: 'dsh-lkb-label' }, T.url), urlInput),
            h('div', { className: 'dsh-lkb-field' }, h('label', { className: 'dsh-lkb-label' }, T.user), userInput),
            h('div', { className: 'dsh-lkb-field' }, h('label', { className: 'dsh-lkb-label' }, T.password), pwInput),
            h('div', { className: 'dsh-lkb-row' },
              h('button', { type: 'button', className: 'dsh-lkb-btn dsh-lkb-btn-primary', onClick: saveConfig, disabled: busy !== '' }, busy === 'save' ? '…' : T.save),
              h('button', { type: 'button', className: 'dsh-lkb-btn dsh-lkb-btn-ghost', onClick: doTest, disabled: busy !== '' }, busy === 'test' ? T.testing : T.test),
              h('button', { type: 'button', className: 'dsh-lkb-btn dsh-lkb-btn-ghost', onClick: doSync, disabled: busy !== '' }, busy === 'sync' ? T.syncing : T.syncNow)),
            statusEl,
            noticeEl)
        )
      )
    }

    // Register the settings section. `settings.section` owner props only carry
    // `close`; all page data travels through the inject face bound here from the
    // plugin's own context (credentials + native open — the same Remote the
    // shipped "open in app" controls use).
    function registerSection(ctx) {
      // inject 声明了 'remote' / 'remote.credentials'，这里 ctx.remote 可直接访问
      // （不会再被 Proxy 拦截）。捕获到闭包，组件直接引用，不再每次现取。
      pluginCtx = ctx
      try {
        // inject 声明了 'remote'：ctx.remote 直接属性访问（不走 ctx.get 的 Proxy 拦截）。
        pluginRemote = ctx.remote || null
        if (pluginRemote && pluginRemote.credentials) {
          pluginRemoteReady = true
        }
      } catch (e) { pluginRemote = null }
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'knowledge-base',
          order: 30,
          label: function () { return isZh() ? T.nav : 'Knowledge Base' },
        }, KnowledgeBaseSection)
      })
    }

    return {
      // settings.section 渲染期要访问 remote 命名空间；Proxy 无 inject 声明会拒访
      // （cannot get property "remote.credentials" without inject）—— 与官方
      // ui-open-in-app 的 `export const inject = ['remote', 'remote.session']` 同理。
      inject: ['slots', 'remote', 'remote.credentials'],
      apply: function (ctx) {
        registerSection(ctx)
      },
    }
  },
})
