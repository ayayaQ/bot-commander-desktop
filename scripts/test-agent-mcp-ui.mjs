/** Offline renderer workflow using real Chromium, the actual Svelte card, and fake IPC only.
 * Run: node scripts/test-agent-mcp-ui.mjs
 * Optional: MCP_UI_REPORT=/absolute/report.json MCP_UI_SCREENSHOT=/absolute/screenshot.png
 * Requires an installed Chromium (CHROMIUM_PATH overrides /usr/bin/chromium).
 * No Electron main, external MCP server, provider, Discord or credentials are used.
 */
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = await mkdtemp(join(root, '.agent-mcp-ui-'))
let vite
let chromium
let socket
const browserErrors = []
let phase = 'fixture preparation'
const flows = []
try {
  await writeFile(
    join(fixtureDir, 'index.html'),
    '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Offline Agent MCP renderer fixture</title></head><body><main id="app" style="max-width:900px;margin:16px auto"></main><script type="module" src="/main.js"></script></body></html>'
  )
  await writeFile(
    join(fixtureDir, 'main.js'),
    `
import { mount, unmount } from 'svelte'
import Card from '/@fs/${root}/src/renderer/src/components/AgentMcpSettingsCard.svelte'
import '/@fs/${root}/src/renderer/app.css'
const clone = (value) => structuredClone(value)
const server = { id: 'fixture', label: 'Installed fixture', executable: '/installed/server', args: ['--stdio'], cwd: '/installed', protocol: 'legacy', environment: ['HOME'] }
const category = (state) => ({ state, count: 1, available: state === 'ready' ? 1 : 0, entries: [{ remoteKey: '<img src=x onerror="window.__mcpInjected=true">', alias: 'fixture_alias', state: state === 'ready' ? 'available' : 'quarantined', reason: state === 'ready' ? undefined : 'Invalid schema', descriptorJson: JSON.stringify({ description: '<script>window.__mcpInjected=true</script>' }) }] })
const catalog = { generation: 1, tools: category('ready'), resources: { ...category('unsupported'), reason: 'Resources unsupported' }, resourceTemplates: { ...category('stale'), reason: 'Explicit refresh needed' } }
let status = { revision: 'fixture-1', servers: [{ server, state: 'disabled', cleanupPending: false }], environmentNames: ['HOME', 'TMPDIR'], paused: false }
const listeners = new Set()
const calls = []
const holds = new Set()
const pending = new Map()
const failures = new Map()
const cancelled = new Set()
let nextToken = 0
let revision = 1
const emit = (patch = {}) => { status = { ...status, ...patch }; for (const listener of listeners) listener(clone(status)) }
const answer = (channel, args) => {
  if (channel === 'agent-mcp:prepare-launch') return { token: 'fixture-token-' + (++nextToken), serverId: args[0], disclosure: 'Exact launch\\nExecutable: /installed/server\\nArguments: ["--stdio"]\\nCWD: /installed\\nEnvironment: HOME\\n<svg onload="window.__mcpInjected=true">\\nOS permissions; not sandboxed; metadata to selected provider; approved text to transcript/provider.', launchDigest: 'fixture-digest', expiresAt: Date.now() + window.__fixture.launchDuration }
  if (channel === 'agent-mcp:configure') { const config = clone(args[0]); const entries = status.servers.filter((entry) => entry.server.id !== config.id); emit({ revision: 'fixture-' + (++revision), servers: [...entries, { server: config, state: 'disabled', cleanupPending: false }] }) }
  if (channel === 'agent-mcp:remove') emit({ revision: 'fixture-' + (++revision), servers: status.servers.filter((entry) => entry.server.id !== args[0]) })
  if (channel === 'agent-mcp:cancel-launch') { cancelled.add(args[0]); emit({ servers: status.servers.map((entry) => ({ ...entry, state: 'disabled' })) }); return undefined }
  if (channel === 'agent-mcp:start') { const started = !cancelled.has(args[0]); emit({ servers: status.servers.map((entry) => ({ ...entry, state: started ? 'connected' : 'disabled', ...(started ? { catalog: clone(catalog) } : {}) })) }); return { started, status: clone(status) } }
  if (channel === 'agent-mcp:disconnect') emit({ servers: status.servers.map((entry) => ({ ...entry, state: 'disabled', catalog: undefined })) })
  if (channel === 'agent-mcp:refresh') emit({ servers: status.servers.map((entry) => ({ ...entry, catalog: { ...entry.catalog, ...Object.fromEntries(args[1].map((kind) => [kind, category('ready')])) } })) })
  return clone(status)
}
window.__fixture = {
  calls, launchDuration: 120000,
  hold(channel) { holds.add(channel) },
  resolve(channel) { holds.delete(channel); for (const item of pending.get(channel) || []) item.resolve(answer(channel, item.args)); pending.delete(channel) },
  failNext(channel, message) { failures.set(channel, message) },
  emit,
  status: () => clone(status),
  listenerCount: () => listeners.size,
  pendingCount: (channel) => (pending.get(channel) || []).length
}
window.electron = { ipcRenderer: {
  on(channel, listener) { if (channel !== 'agent-mcp:status') throw new Error('Unexpected receive channel'); listeners.add(listener) },
  removeListener(channel, listener) { listeners.delete(listener) },
  invoke(channel, ...args) {
    calls.push({ channel, args: clone(args) })
    if (failures.has(channel)) { const message = failures.get(channel); failures.delete(channel); return Promise.reject(new Error(message)) }
    if (channel === 'agent-mcp:start') emit({ servers: status.servers.map((entry) => ({ ...entry, state: 'connecting' })) })
    if (holds.has(channel)) return new Promise((resolve) => { const list = pending.get(channel) || []; list.push({ resolve, args }); pending.set(channel, list) })
    return Promise.resolve(answer(channel, args))
  }
} }
let instance
let navigation = Promise.resolve()
function render() {
  navigation = navigation.then(async () => {
    if (instance) { await unmount(instance); instance = undefined }
    document.getElementById('app').textContent = ''
    if (location.hash === '#settings') instance = mount(Card, { target: document.getElementById('app') })
    else document.getElementById('app').textContent = 'Another settings view'
  })
}
window.addEventListener('hashchange', render)
render()
`
  )
  vite = await createServer({
    configFile: false,
    root: fixtureDir,
    plugins: [svelte()],
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
    logLevel: 'error'
  })
  await vite.listen()
  const port = vite.httpServer.address().port
  phase = 'fixture compilation'
  await vite.transformRequest('/main.js')
  await vite.transformRequest(
    '/@fs/' + root + '/src/renderer/src/components/AgentMcpSettingsCard.svelte'
  )
  await vite.transformRequest('/@fs/' + root + '/src/renderer/app.css')
  phase = 'Chromium startup'
  const profile = join(fixtureDir, 'chromium-profile')
  const endpoint = new Promise((yes, no) => {
    let diagnostics = ''
    const timeout = setTimeout(() => no(new Error('Chromium DevTools startup timed out')), 10000)
    chromium = spawn(
      process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--user-data-dir=' + profile,
        'about:blank'
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: fixtureDir,
          LANG: process.env.LANG || 'C.UTF-8',
          XDG_CONFIG_HOME: join(fixtureDir, 'config'),
          XDG_CACHE_HOME: join(fixtureDir, 'cache')
        }
      }
    )
    chromium.on('error', (error) => {
      clearTimeout(timeout)
      no(error)
    })
    chromium.stderr.on('data', (data) => {
      diagnostics = (diagnostics + String(data)).slice(-12000)
      const match = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timeout)
        yes(match[1])
      }
    })
    chromium.on('exit', (code, signal) => {
      clearTimeout(timeout)
      no(new Error('Chromium exited: code=' + code + ' signal=' + signal + '\n' + diagnostics))
    })
  })
  socket = new WebSocket(await endpoint)
  await new Promise((yes, no) => {
    socket.addEventListener('open', yes, { once: true })
    socket.addEventListener('error', no, { once: true })
  })
  const pending = new Map()
  let request = 0
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data)
    if (message.id) {
      const callbacks = pending.get(message.id)
      pending.delete(message.id)
      if (!callbacks) return
      clearTimeout(callbacks.timeout)
      message.error
        ? callbacks.no(new Error(JSON.stringify(message.error)))
        : callbacks.yes(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown')
      browserErrors.push(message.params.exceptionDetails)
  })
  const send = (method, params = {}, sessionId) =>
    new Promise((yes, no) => {
      const id = ++request
      const timeout = setTimeout(() => {
        pending.delete(id)
        no(new Error('DevTools command timed out: ' + method))
      }, 10000)
      pending.set(id, { yes, no, timeout })
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const command = (method, params) => send(method, params, sessionId)
  await command('Runtime.enable')
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    })
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      )
    return result.result.value
  }
  const wait = async (expression) => {
    const deadline = Date.now() + 7000
    while (Date.now() < deadline) {
      if (await evaluate(`return (${expression})`)) return
      await new Promise((yes) => setTimeout(yes, 40))
    }
    throw new Error('UI condition timed out: ' + expression)
  }
  const click = async (text) => {
    const location = await evaluate(
      `const element = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(text)}); if (!element || element.disabled) throw new Error('Missing or disabled button: ' + ${JSON.stringify(text)}); element.scrollIntoView({block:'center'}); const box = element.getBoundingClientRect(); return {x:box.x + box.width/2,y:box.y + box.height/2}`
    )
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...location
    })
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...location
    })
  }
  const fill = async (label, value) =>
    evaluate(
      `const field = [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea,select'); if (!field || field.disabled) throw new Error('Missing or disabled field'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}))`
    )
  const count = (channel) =>
    evaluate(
      `return window.__fixture.calls.filter((item) => item.channel === ${JSON.stringify(channel)}).length`
    )
  const reviewOpen = '!!document.querySelector(\'[aria-label="Review exact MCP launch"]\')'
  phase = 'actual browser workflow'
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/#settings` })
  await wait("!!window.__fixture && document.body.textContent.includes('fixture: disabled')")
  assert.equal(await count('agent-mcp:start'), 0)
  assert.equal(await evaluate('return window.__fixture.listenerCount()'), 1)
  flows.push('Initial mount reads local status only; no startup or discovery')

  await click('Edit')
  await fill('Label', 'Edited fixture')
  await fill('Arguments', '["--stdio", "<b>exact</b>"]')
  await click('Save configuration')
  await wait("document.body.textContent.includes('Configuration saved')")
  assert.equal(await count('agent-mcp:start'), 0)
  const saved = await evaluate(
    "return window.__fixture.calls.findLast((item) => item.channel === 'agent-mcp:configure').args[0]"
  )
  assert.deepEqual(saved.args, ['--stdio', '<b>exact</b>'])
  assert.deepEqual(saved.environment, ['HOME'])
  assert.equal(Object.hasOwn(saved, 'environmentValues'), false)
  flows.push('Edit and inert Save preserve exact JSON arguments and names-only environment')

  await click('Review startup')
  await wait(reviewOpen)
  assert.equal(await count('agent-mcp:start'), 0)
  assert.equal(
    await evaluate('return document.querySelectorAll("svg,img,script:not([type=module])").length'),
    0
  )
  assert.equal(await evaluate('return !!window.__mcpInjected'), false)
  assert.equal(
    await evaluate(
      'return document.querySelector("[aria-label=\"Review exact MCP launch\"] pre").textContent.includes("<svg onload=")'
    ),
    true
  )
  await click('Cancel')
  await wait(`!(${reviewOpen})`)
  assert.equal(await count('agent-mcp:start'), 0)
  flows.push('Exact launch disclosure is escaped; Cancel dismisses without startup')

  await evaluate("window.__fixture.hold('agent-mcp:prepare-launch')")
  await click('Review startup')
  await wait("document.body.textContent.includes('Preparing launch review')")
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Review startup').disabled"
    ),
    true
  )
  await click('Cancel Start')
  await evaluate("window.__fixture.resolve('agent-mcp:prepare-launch')")
  await wait(
    `!(${reviewOpen}) && window.__fixture.calls.some((item) => item.channel === 'agent-mcp:cancel-launch' && item.args[0] === 'fixture-token-2')`
  )
  assert.equal(await count('agent-mcp:start'), 0)
  flows.push(
    'Pending preparation is click-guarded; cancellation revokes late token without reopening'
  )

  await click('Review startup')
  await wait(reviewOpen)
  await fill('Label', 'Changed while reviewing')
  await wait(`!(${reviewOpen})`)
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Review startup').disabled"
    ),
    true
  )
  await click('Save configuration')
  await wait("document.body.textContent.includes('Configuration saved')")
  flows.push('Editing an open review cancels its token; unsaved edits cannot start')

  await evaluate('window.__fixture.launchDuration = 80')
  await click('Review startup')
  await wait("document.body.textContent.includes('The Start disclosure expired')")
  assert.equal(await evaluate(`return ${reviewOpen}`), false)
  await evaluate('window.__fixture.launchDuration = 120000')
  flows.push('Token expiry clears review and revokes its token')

  await evaluate("window.__fixture.hold('agent-mcp:start')")
  await click('Review startup')
  await wait(reviewOpen)
  await click('Start once')
  await wait("document.body.textContent.includes('Starting server')")
  const startsBefore = await count('agent-mcp:start')
  assert.equal(startsBefore, 1)
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Start once')"
    ),
    false
  )
  await evaluate("location.hash = '#other'")
  await wait(
    "document.body.textContent.includes('Another settings view') && window.__fixture.listenerCount() === 0"
  )
  await evaluate("window.__fixture.resolve('agent-mcp:start'); history.back()")
  await wait(
    "document.body.textContent.includes('fixture: disabled') && window.__fixture.listenerCount() === 1"
  )
  assert.equal(await count('agent-mcp:start'), startsBefore)
  assert.equal(await evaluate(`return ${reviewOpen}`), false)
  await evaluate('history.forward()')
  await wait('window.__fixture.listenerCount() === 0')
  await evaluate('history.back()')
  await wait('window.__fixture.listenerCount() === 1')
  flows.push(
    'Start once is duplicate-guarded; navigation cancels in-flight token; Back/Forward never replays startup'
  )

  await click('Review startup')
  await wait(reviewOpen)
  await click('Start once')
  await wait("document.body.textContent.includes('fixture: connected')")
  assert.equal(await count('agent-mcp:start'), startsBefore + 1)
  await evaluate("for (const detail of document.querySelectorAll('details')) detail.open = true")
  assert.equal(
    await evaluate(
      'return document.querySelectorAll("article img,article script,article svg").length'
    ),
    0
  )
  assert.equal(await evaluate('return !!window.__mcpInjected'), false)
  await wait(
    "document.body.textContent.includes('quarantined') && document.body.textContent.includes('Resources: unsupported') && document.body.textContent.includes('Resource templates: stale')"
  )
  await click('Refresh resource metadata')
  const refresh = await evaluate(
    "return window.__fixture.calls.findLast((item) => item.channel === 'agent-mcp:refresh').args"
  )
  assert.deepEqual(refresh, ['fixture', ['resources']])
  await evaluate("window.__fixture.failNext('agent-mcp:refresh', 'Fixture capability error')")
  await click('Refresh template metadata')
  await wait("document.body.textContent.includes('Fixture capability error')")
  flows.push(
    'Connected local inspector escapes quarantined metadata; refresh targets one category and exposes capability errors'
  )

  await click('Disconnect')
  await wait("document.body.textContent.includes('fixture: disabled')")
  await evaluate('window.__fixture.emit({paused:true})')
  await wait("document.body.textContent.includes('Agent MCP controls are paused')")
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Review startup').disabled"
    ),
    true
  )
  await evaluate(
    "window.__fixture.emit({paused:false}); window.__fixture.failNext('agent-mcp:prepare-launch', 'Fixture launch unavailable')"
  )
  await click('Review startup')
  await wait("document.body.textContent.includes('Fixture launch unavailable')")
  flows.push(
    'Disconnect requires fresh startup; pause and preparation failures remain visible and do not retry'
  )

  const report = {
    passed: true,
    engine: await send('Browser.getVersion'),
    flows,
    calls: await evaluate('return window.__fixture.calls'),
    browserErrors,
    limitations: [
      'Isolated real Svelte card and app CSS with fake IPC, not the full Electron application',
      'No real MCP executable, provider, Discord, credentials, HTTP/OAuth or installation',
      'Linux Chromium only; no native platform dialogs or Windows/macOS UI coverage'
    ]
  }
  assert.deepEqual(browserErrors, [])
  if (process.env.MCP_UI_REPORT) {
    await mkdir(dirname(resolve(process.env.MCP_UI_REPORT)), { recursive: true })
    await writeFile(resolve(process.env.MCP_UI_REPORT), JSON.stringify(report, null, 2) + '\n')
  }
  if (process.env.MCP_UI_SCREENSHOT) {
    const { data } = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true
    })
    await writeFile(resolve(process.env.MCP_UI_SCREENSHOT), Buffer.from(data, 'base64'))
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        engine: report.engine.product,
        flows,
        browserErrors: browserErrors.length,
        report: process.env.MCP_UI_REPORT || null,
        screenshot: process.env.MCP_UI_SCREENSHOT || null
      },
      null,
      2
    )
  )
} catch (error) {
  const report = {
    passed: false,
    phase,
    flows,
    browserErrors,
    error: error instanceof Error ? error.message : String(error)
  }
  if (process.env.MCP_UI_REPORT) {
    await mkdir(dirname(resolve(process.env.MCP_UI_REPORT)), { recursive: true })
    await writeFile(resolve(process.env.MCP_UI_REPORT), JSON.stringify(report, null, 2) + '\n')
  }
  throw error
} finally {
  socket?.close()
  if (chromium && chromium.exitCode === null) {
    chromium.kill('SIGTERM')
    await Promise.race([
      new Promise((yes) => chromium.once('exit', yes)),
      new Promise((yes) => setTimeout(yes, 3000))
    ])
    if (chromium.exitCode === null) chromium.kill('SIGKILL')
  }
  await vite?.close()
  await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
