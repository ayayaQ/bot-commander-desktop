/** Offline renderer workflow using real Chromium, the actual Svelte card, and fake IPC only.
 * Run: node scripts/test-agent-mcp-ui.mjs
 * Optional: MCP_UI_REPORT=/absolute/report.json MCP_UI_SCREENSHOT=/absolute/screenshot.png
 * Requires an installed Chromium (CHROMIUM_PATH overrides /usr/bin/chromium).
 * No Electron main, external MCP server, provider, Discord or credentials are used.
 */
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { parse } from 'acorn'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

// Parse literal browser expressions and the generated fake-IPC module before Chromium starts.
// Dynamic helpers additionally validate their final expression before sending it to DevTools.
const expressionSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
const expressionAst = parse(expressionSource, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  locations: true
})
let expressionChecks = 0
let fixtureScriptChecks = 0
const constants = new Map()
function visit(node, callback) {
  if (!node || typeof node !== 'object') return
  if (typeof node.type === 'string') callback(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => visit(child, callback))
    else if (value && typeof value === 'object') visit(value, callback)
  }
}
visit(expressionAst, (node) => {
  if (
    node.type === 'VariableDeclarator' &&
    node.id.type === 'Identifier' &&
    node.init?.type === 'Literal' &&
    typeof node.init.value === 'string'
  )
    constants.set(node.id.name, node.init.value)
})
function browserExpression(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral') {
    let text = node.quasis[0].value.cooked
    for (let index = 0; index < node.expressions.length; index++) {
      const expression = node.expressions[index]
      const value =
        expression.type === 'Identifier' && constants.has(expression.name)
          ? constants.get(expression.name)
          : expression.type === 'CallExpression' &&
              expression.callee.type === 'MemberExpression' &&
              expression.callee.object.name === 'JSON' &&
              expression.callee.property.name === 'stringify'
            ? JSON.stringify('fixture "quoted" value')
            : undefined
      if (value === undefined) return undefined
      text += value + node.quasis[index + 1].value.cooked
    }
    return text
  }
  return undefined
}
function validateBrowserExpression(expression) {
  new Function(`return (async () => { ${expression} })()`)
}
visit(expressionAst, (node) => {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'Identifier' ||
    !['evaluate', 'wait'].includes(node.callee.name)
  )
    return
  const expression = browserExpression(node.arguments[0])
  if (expression === undefined) return
  try {
    validateBrowserExpression(node.callee.name === 'wait' ? `return (${expression})` : expression)
  } catch (error) {
    throw new Error(
      `Invalid browser expression at harness line ${node.loc.start.line}: ${error.message}`
    )
  }
  expressionChecks++
})
visit(expressionAst, (node) => {
  if (
    node.type !== 'CallExpression' ||
    node.callee.type !== 'Identifier' ||
    node.callee.name !== 'writeFile' ||
    node.arguments[0]?.type !== 'CallExpression' ||
    node.arguments[0].arguments[1]?.value !== 'main.js' ||
    node.arguments[1]?.type !== 'TemplateLiteral'
  )
    return
  const fixture = node.arguments[1]
  const source = fixture.quasis.map((part) => part.value.cooked).join('/fixture-root')
  parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  fixtureScriptChecks++
})
if (process.argv.includes('--validate-expressions')) {
  console.log(
    JSON.stringify({
      expressionChecks,
      fixtureScriptChecks,
      syntaxValidated: true,
      browserExecuted: false
    })
  )
  process.exit(0)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..').replaceAll('\\', '/')
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
import ExternalCard from '/@fs/${root}/src/renderer/src/components/McpSettingsCard.svelte'
import Outcome from '/@fs/${root}/src/renderer/src/components/AgentMcpOutcome.svelte'
import '/@fs/${root}/src/renderer/app.css'
const clone = (value) => structuredClone(value)
const baseMcp = { runId: 'fixture-run', operationDigest: 'fixture-operation', serverId: 'fixture', catalogKind: 'tools', remoteKey: 'fixture_tool' }
const outcomeFixtures = {
  confirmedError: { mcp: { ...baseMcp, outcome: 'confirmed', requestSent: true }, result: { success: false, source: 'mcp', untrusted: true, error: { code: 'fixture_server_error', message: 'Confirmed server error <img src=x onerror="window.__mcpInjected=true">' }, content: [{ type: 'text', text: 'x'.repeat(40000) + '<script>window.__mcpInjected=true</script>' }] } },
  unknown: { mcp: { ...baseMcp, outcome: 'unknown', requestSent: true }, result: { success: false, source: 'mcp', untrusted: true, unknownOutcome: true, doNotRetry: true, error: { code: 'mcp_unknown_outcome', message: 'Synthetic unknown external outcome' } } },
  notSent: { mcp: { ...baseMcp, outcome: 'not-sent', requestSent: false }, result: { success: false, source: 'mcp', untrusted: true, requestSent: false, unknownOutcome: false, error: { code: 'mcp_not_attempted', message: 'Synthetic request not attempted' } } },
  checkpoint: { mcp: { ...baseMcp, outcome: 'confirmed', requestSent: true, checkpointUnconfirmed: true }, result: { success: true, source: 'mcp', untrusted: true, requestSent: true, checkpointUnconfirmed: true, content: [{ type: 'text', text: 'Confirmed response with failed local checkpoint' }] } },
  oversized: { mcp: { ...baseMcp, outcome: 'unknown', requestSent: true, checkpointUnconfirmed: true }, result: { success: false, source: 'mcp', untrusted: true, content: [{ type: 'text', text: 'あ'.repeat(70000) }] } }
}
const server = { id: 'fixture', label: 'Installed fixture', executable: '/installed/server', args: ['--stdio'], cwd: '/installed', protocol: 'legacy', environment: ['HOME'] }
const category = (state) => ({ state, count: 1, available: state === 'ready' ? 1 : 0, entries: [{ remoteKey: '<img src=x onerror="window.__mcpInjected=true">', alias: 'fixture_alias', state: state === 'ready' ? 'available' : 'quarantined', reason: state === 'ready' ? undefined : 'Invalid schema', descriptorJson: JSON.stringify({ description: '<script>window.__mcpInjected=true</script>' }) }] })
const catalog = { generation: 1, tools: category('ready'), resources: { ...category('unsupported'), reason: 'Resources unsupported' }, resourceTemplates: { ...category('stale'), reason: 'Explicit refresh needed' } }
let status = { revision: 'fixture-1', servers: [{ server, state: 'disabled', cleanupPending: false }], environmentNames: ['HOME', 'TMPDIR'], paused: false }
const listeners = new Set()
const externalListeners = new Map()
let externalStatus = { enabled: false, running: false, accessMode: 'read-only', port: 43721, endpoint: 'http://127.0.0.1:43721/mcp', tokenConfigured: true, secureStorageAvailable: true, activeRequests: 0 }
const calls = []
const holds = new Set()
const pending = new Map()
const failures = new Map()
const cancelled = new Set()
const oauthClients = new Map()
const oauthEpochs = new Map()
const oauthRevisions = new Map()
const oauthPlans = new Map()
const oauthCompletions = { registrations: 0, signIns: 0 }
let nextOAuthToken = 0
let nextToken = 0
let revision = 1
const emit = (patch = {}) => { status = { ...status, ...patch }; for (const listener of listeners) listener(clone(status)) }
const oauthStatus = (id, state, hasClient = oauthClients.has(id)) => ({ state, hasClient, revision: 'fixture-oauth-' + (oauthRevisions.get(id) || 0) })
const setOAuth = (id, state, advanceRevision = false) => { if (advanceRevision) oauthRevisions.set(id, (oauthRevisions.get(id) || 0) + 1); emit({ servers: status.servers.map((entry) => entry.server.id === id ? { ...entry, oauth: oauthStatus(id, state) } : entry) }) }
const oauthCurrent = (flow) => oauthEpochs.get(flow.serverId) === flow.epoch
const beginOAuth = (channel, args) => {
  if (!['agent-mcp:oauth-prepare-registration', 'agent-mcp:oauth-prepare-sign-in'].includes(channel)) return undefined
  const serverId = args[0]
  const epoch = (oauthEpochs.get(serverId) || 0) + 1
  oauthEpochs.set(serverId, epoch)
  const kind = channel === 'agent-mcp:oauth-prepare-registration' ? 'registration' : 'sign-in'
  const flow = { serverId, epoch, kind, settings: clone(kind === 'registration' ? args[1] : oauthClients.get(serverId)), configRevision: status.revision }
  setOAuth(serverId, kind === 'registration' ? 'preparing-registration' : 'preparing')
  return flow
}
const launchPreparation = (id) => {
    const entry = status.servers.find((entry) => entry.server.id === id)
    const config = entry.server
    const authentication = oauthClients.has(id) && entry.oauth?.state === 'authorized'
      ? 'session-only OAuth bearer\\nAuthentication revision: ' + entry.oauth.revision
      : 'anonymous\\nAuthentication revision: fixture-anonymous-v1'
    const disclosure = config.transport === 'http'
      ? 'Exact HTTP connection\\nEndpoint: ' + config.endpoint + '\\nProtocol: ' + config.protocol + '\\nAuthentication: ' + authentication + '\\nInitialization and discovery contact the endpoint before tool approval; network address and MCP traffic visible to endpoint; metadata to selected provider; approved text to transcript/provider.'
      : 'Exact launch\\nExecutable: /installed/server\\nArguments: ["--stdio"]\\nCWD: /installed\\nEnvironment: HOME\\n<svg onload="window.__mcpInjected=true">\\nOS permissions; not sandboxed; metadata to selected provider; approved text to transcript/provider.'
    return { token: 'fixture-token-' + (++nextToken), serverId: id, disclosure, launchDigest: 'fixture-digest', expiresAt: Date.now() + window.__fixture.launchDuration }
}
const answer = (channel, args, flow) => {
  if (channel === 'agent-mcp:prepare-launch') return launchPreparation(args[0])
  if (channel === 'agent-mcp:oauth-configure-client') {
    oauthClients.set(args[0], clone(args[1]))
    oauthEpochs.set(args[0], (oauthEpochs.get(args[0]) || 0) + 1)
    setOAuth(args[0], 'configured', true)
    return clone(status)
  }
  if (channel === 'agent-mcp:oauth-prepare-registration' || channel === 'agent-mcp:oauth-prepare-sign-in') {
    const token = 'fixture-oauth-review-' + (++nextOAuthToken)
    const entry = status.servers.find((entry) => entry.server.id === flow.serverId)
    const settings = flow.settings
    const disclosure = (flow.kind === 'registration' ? 'Exact public client registration' : 'Exact browser sign-in') + '\\nEndpoint: ' + entry.server.endpoint + '\\nIssuer: ' + settings.issuer + '\\n' + (flow.kind === 'registration' ? 'Registration endpoint: https://auth.example.invalid/register\\nClient name: ' + settings.clientName : 'Authorization endpoint: https://auth.example.invalid/authorize\\nPublic client ID: ' + settings.id) + '\\nLoopback redirect: http://127.0.0.1:' + settings.redirectPort + settings.redirectPath + '\\nRequested scopes: ' + settings.scopes.join(' ') + '\\nConfiguration revision: ' + flow.configRevision + '\\n<svg onload="window.__mcpInjected=true">\\nExplicit one-time approval only; session-only credentials; no MCP connection or metadata discovery.'
    const review = { token, kind: flow.kind, serverId: flow.serverId, configRevision: flow.configRevision, disclosure, expiresAt: Date.now() + window.__fixture.oauthDuration }
    oauthPlans.set(token, { ...flow, review, consumed: false })
    if (oauthCurrent(flow)) setOAuth(flow.serverId, flow.kind === 'registration' ? 'registration-prepared' : 'prepared')
    return clone(review)
  }
  if (channel === 'agent-mcp:oauth-register' || channel === 'agent-mcp:oauth-sign-in') {
    const plan = oauthPlans.get(args[0])
    if (!plan || plan.consumed) throw new Error('Fixture OAuth action is stale or already consumed')
    plan.consumed = true
    if (channel === 'agent-mcp:oauth-register') {
      if (oauthCurrent(plan)) {
        oauthCompletions.registrations++
        oauthClients.set(plan.serverId, { id: 'fixture-registered-public-client', issuer: plan.settings.issuer, redirectPort: plan.settings.redirectPort, redirectPath: plan.settings.redirectPath, scopes: clone(plan.settings.scopes) })
        setOAuth(plan.serverId, 'configured', true)
      }
      return clone(status)
    }
    if (oauthCurrent(plan)) {
      oauthCompletions.signIns++
      setOAuth(plan.serverId, 'authorized', true)
    }
    return { status: clone(status), preparation: launchPreparation(plan.serverId) }
  }
  if (channel === 'agent-mcp:oauth-cancel') {
    oauthEpochs.set(args[0], (oauthEpochs.get(args[0]) || 0) + 1)
    setOAuth(args[0], 'cancelled', true)
    return clone(status)
  }
  if (channel === 'agent-mcp:configure') { const config = clone(args[0]); const entries = status.servers.filter((entry) => entry.server.id !== config.id); emit({ revision: 'fixture-' + (++revision), servers: [...entries, { server: config, state: 'disabled', cleanupPending: false, ...(config.transport === 'http' ? { oauth: oauthStatus(config.id, 'unconfigured', false) } : {}) }] }) }
  if (channel === 'agent-mcp:remove') emit({ revision: 'fixture-' + (++revision), servers: status.servers.filter((entry) => entry.server.id !== args[0]) })
  if (channel === 'agent-mcp:cancel-launch') { cancelled.add(args[0]); emit({ servers: status.servers.map((entry) => ({ ...entry, state: 'disabled' })) }); return undefined }
  if (channel === 'agent-mcp:start') { const started = !cancelled.has(args[0]); emit({ servers: status.servers.map((entry) => ({ ...entry, state: started ? 'connected' : 'disabled', ...(started ? { catalog: clone(catalog) } : {}) })) }); return { started, status: clone(status) } }
  if (channel === 'agent-mcp:disconnect') emit({ servers: status.servers.map((entry) => ({ ...entry, state: 'disabled', catalog: undefined })) })
  if (channel === 'agent-mcp:refresh') emit({ servers: status.servers.map((entry) => ({ ...entry, catalog: { ...entry.catalog, ...Object.fromEntries(args[1].map((kind) => [kind, category('ready')])) } })) })
  return clone(status)
}
window.__fixture = {
  calls, oauthCompletions, launchDuration: 120000, oauthDuration: 120000,
  hold(channel) { holds.add(channel) },
  resolve(channel) { holds.delete(channel); for (const item of pending.get(channel) || []) item.resolve(answer(channel, item.args, item.flow)); pending.delete(channel) },
  failNext(channel, message) { failures.set(channel, message) },
  emit,
  status: () => clone(status),
  listenerCount: () => listeners.size,
  pendingCount: (channel) => (pending.get(channel) || []).length
}
window.electron = { ipcRenderer: {
  on(channel, listener) { if (channel.startsWith('mcp:')) { externalListeners.set(channel, listener); return } if (channel !== 'agent-mcp:status') throw new Error('Unexpected receive channel'); listeners.add(listener) },
  removeListener(channel, listener) { externalListeners.delete(channel); listeners.delete(listener) },
  invoke(channel, ...args) {
    calls.push({ channel, args: clone(args) })
    if (channel === 'mcp:get-status') return Promise.resolve(clone(externalStatus))
    if (channel === 'mcp:get-activity') return Promise.resolve([])
    if (channel === 'mcp:update-config') { externalStatus = { ...externalStatus, ...args[0], running: args[0].enabled ?? externalStatus.running }; externalListeners.get('mcp:status')?.(clone(externalStatus)); return Promise.resolve(clone(externalStatus)) }
    if (failures.has(channel)) { const message = failures.get(channel); failures.delete(channel); return Promise.reject(new Error(message)) }
    if (channel === 'agent-mcp:start') emit({ servers: status.servers.map((entry) => ({ ...entry, state: 'connecting' })) })
    const flow = beginOAuth(channel, args)
    if (channel === 'agent-mcp:oauth-register' || channel === 'agent-mcp:oauth-sign-in') {
      const plan = oauthPlans.get(args[0])
      if (plan && oauthCurrent(plan)) setOAuth(plan.serverId, channel === 'agent-mcp:oauth-register' ? 'registering' : 'awaiting-user')
    }
    if (holds.has(channel)) return new Promise((resolve) => { const list = pending.get(channel) || []; list.push({ resolve, args, flow }); pending.set(channel, list) })
    return Promise.resolve(answer(channel, args, flow))
  }
} }
let instance
let navigation = Promise.resolve()
function render() {
  navigation = navigation.then(async () => {
    if (instance) { await unmount(instance); instance = undefined }
    document.getElementById('app').textContent = ''
    if (location.hash === '#settings') instance = mount(Card, { target: document.getElementById('app') })
    else if (location.hash === '#external') instance = mount(ExternalCard, { target: document.getElementById('app') })
    else if (location.hash.startsWith('#outcome-')) {
      const props = outcomeFixtures[location.hash.slice('#outcome-'.length)]
      if (!props) throw new Error('Unknown outcome fixture')
      instance = mount(Outcome, { target: document.getElementById('app'), props: clone(props) })
    } else document.getElementById('app').textContent = 'Another settings view'
    document.getElementById('app').dataset.route = location.hash
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
    server: {
      host: '127.0.0.1',
      port: 0,
      fs: { allow: [root] },
      watch: { ignored: ['**/chromium-profile/**'] }
    },
    logLevel: 'error'
  })
  await vite.listen()
  const port = vite.httpServer.address().port
  phase = 'fixture compilation'
  await vite.transformRequest('/main.js')
  await vite.transformRequest(
    '/@fs/' + root + '/src/renderer/src/components/AgentMcpSettingsCard.svelte'
  )
  await vite.transformRequest(
    '/@fs/' + root + '/src/renderer/src/components/AgentMcpOutcome.svelte'
  )
  await vite.transformRequest('/@fs/' + root + '/src/renderer/src/utils/agentMcpOutcome.ts')
  await vite.transformRequest('/@fs/' + root + '/src/renderer/app.css')
  phase = 'Chromium startup'
  const profile = join(fixtureDir, 'chromium-profile')
  await mkdir(profile, { recursive: true })
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
          SystemRoot: process.env.SystemRoot,
          TEMP: profile,
          TMP: profile,
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
    validateBrowserExpression(expression)
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
      `const field = [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea,select'); if (!field || field.disabled) throw new Error('Missing or disabled field'); for (let detail = field.closest('details'); detail; detail = detail.parentElement?.closest('details')) { if (!detail.open) detail.querySelector('summary').click() } field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}))`
    )
  const count = (channel) =>
    evaluate(
      `return window.__fixture.calls.filter((item) => item.channel === ${JSON.stringify(channel)}).length`
    )
  const reviewOpen = '!!document.querySelector(\'[aria-label="Review exact MCP launch"]\')'
  const openSection = () =>
    evaluate(
      "const trigger = document.querySelector('button[aria-haspopup=dialog]'); trigger.focus(); trigger.click()"
    )
  const captureSettings = async (name) => {
    if (!process.env.MCP_UI_SCREENSHOT) return
    await wait(
      "!document.querySelector('dialog[open]') || getComputedStyle(document.querySelector('dialog[open] .modal-box')).opacity === '1'"
    )
    const { data } = await command('Page.captureScreenshot', { format: 'png' })
    await writeFile(
      resolve(process.env.MCP_UI_SCREENSHOT.replace(/\.png$/, '') + `-${name}.png`),
      Buffer.from(data, 'base64')
    )
  }
  const checkSmallLayout = async (name) => {
    await command('Emulation.setDeviceMetricsOverride', {
      width: 480,
      height: 640,
      deviceScaleFactor: 1,
      mobile: false
    })
    await captureSettings(name)
    assert.deepEqual(
      await evaluate(
        "const dialog = document.querySelector('dialog[open]'); const box = dialog.querySelector('.modal-box').getBoundingClientRect(); const body = dialog.querySelector('.overflow-y-auto'); const footer = dialog.querySelector('footer').getBoundingClientRect(); return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight, closeVisible: footer.bottom <= innerHeight, scrolls: body.scrollHeight > body.clientHeight, noHorizontalOverflow: body.scrollWidth <= body.clientWidth }"
      ),
      { fits: true, closeVisible: true, scrolls: true, noHorizontalOverflow: true }
    )
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false
    })
  }
  phase = 'actual browser workflow'
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/#external` })
  await wait("!!window.__fixture && !!document.querySelector('button[aria-haspopup=dialog]')")
  assert.equal(await evaluate("return !!document.querySelector('dialog[open]')"), false)
  assert.equal(
    await evaluate(
      "return document.querySelector('button[aria-haspopup=dialog]').getBoundingClientRect().height < 120 && !document.querySelector('dialog input').checkVisibility({ visibilityProperty: true })"
    ),
    true
  )
  await captureSettings('compact')
  assert.equal(await count('mcp:update-config'), 0)
  await openSection()
  await wait("!!document.querySelector('dialog[open]')")
  assert.equal(await evaluate("return document.activeElement.closest('dialog') !== null"), true)
  await evaluate('document.querySelector(\'[aria-label="Enable external agent access"]\').click()')
  await wait("document.querySelector('dialog').textContent.includes('Running')")
  await captureSettings('external-dialog')
  await click('Close')
  await wait("!document.querySelector('dialog[open]')")
  await openSection()

  await checkSmallLayout('external-dialog-small')
  assert.equal(
    await evaluate(
      'return document.querySelector(\'[aria-label="Enable external agent access"]\').checked'
    ),
    true
  )
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27
  })
  await wait("!document.querySelector('dialog[open]')")
  assert.equal(
    await evaluate("return document.activeElement.matches('button[aria-haspopup=dialog]')"),
    true
  )
  flows.push(
    'External access starts as a compact entry; its dialog preserves controls, closes with Close or Escape, and restores focus'
  )

  await command('Page.navigate', { url: `http://127.0.0.1:${port}/#settings` })
  await wait("!!window.__fixture && document.body.textContent.includes('fixture: disabled')")
  assert.equal(await count('agent-mcp:start'), 0)
  assert.equal(await evaluate('return window.__fixture.listenerCount()'), 1)
  flows.push('Initial mount reads local status only; no startup or discovery')
  assert.equal(await evaluate("return !!document.querySelector('dialog[open]')"), false)
  await openSection()
  assert.deepEqual(
    await evaluate(
      "const fields = [...document.querySelectorAll('form label')]; const protocol = fields.find((item) => item.textContent.trim().startsWith('Protocol compatibility')).querySelector('select'); const transport = fields.find((item) => item.textContent.trim().startsWith('Transport')).querySelector('select'); return { transport: transport.value, protocol: protocol.value, advancedOpen: document.querySelector('form details').open, protocolVisible: protocol.checkVisibility({ visibilityProperty: true }) }"
    ),
    { transport: 'http', protocol: 'auto', advancedOpen: false, protocolVisible: false }
  )
  await checkSmallLayout('agent-dialog-small')
  flows.push('Both dialogs fit smaller windows with scrollable content and a visible close action')

  await click('Edit')
  await fill('Label', 'Unsaved dialog draft')
  await click('Close')
  await wait("!document.querySelector('dialog[open]')")
  await openSection()
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith('Label')).querySelector('input').value"
    ),
    'Unsaved dialog draft'
  )
  assert.equal(await count('agent-mcp:start'), 0)
  flows.push(
    'Agent server dialog preserves unsaved drafts across close and reopen without starting servers'
  )

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
  assert.equal(saved.protocol, 'legacy')
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
      `return document.querySelector(${JSON.stringify('[aria-label="Review exact MCP launch"] pre')}).textContent.includes("<svg onload=")`
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
  await openSection()
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

  const httpStartsBefore = await count('agent-mcp:start')
  const httpReviewsBefore = await count('agent-mcp:prepare-launch')
  await click('Remove')
  await wait("document.body.textContent.includes('No agent MCP servers configured')")
  // Earlier Back/Forward remounted the card in new-server mode, so its reset action is Clear.
  await click('Clear')
  await fill('Transport', 'http')
  await fill('Server ID', 'remote')
  await fill('Endpoint URL', 'http://example.invalid/mcp')
  await click('Save configuration')
  await wait("document.body.textContent.includes('Use HTTPS, or explicitly allow HTTP')")
  assert.equal(await evaluate('return window.__fixture.status().servers.length'), 0)
  await fill('Endpoint URL', 'https://user:secret@example.invalid/mcp')
  await click('Save configuration')
  await wait("document.body.textContent.includes('cannot contain credentials')")
  await fill('Endpoint URL', 'https://example.invalid/mcp')
  await click('Save configuration')
  await wait("document.body.textContent.includes('remote: disabled')")
  assert.deepEqual(
    await evaluate(
      "return window.__fixture.calls.findLast((item) => item.channel === 'agent-mcp:configure').args[0]"
    ),
    {
      transport: 'http',
      id: 'remote',
      label: 'remote',
      endpoint: 'https://example.invalid/mcp',
      protocol: 'auto',
      allowLoopbackHttp: false
    }
  )
  assert.equal(await count('agent-mcp:start'), httpStartsBefore)
  flows.push(
    'New HTTP servers need only an ID and URL; optional labels and protocol overrides stay in Advanced, with automatic compatibility by default'
  )
  await fill('Label', 'Anonymous HTTP fixture')
  await fill('Protocol compatibility', '2026-07-28')
  await click('Save configuration')
  await wait("document.body.textContent.includes('remote: disabled')")
  const httpSaved = await evaluate(
    "return window.__fixture.calls.findLast((item) => item.channel === 'agent-mcp:configure').args[0]"
  )
  assert.deepEqual(httpSaved, {
    transport: 'http',
    id: 'remote',
    label: 'Anonymous HTTP fixture',
    endpoint: 'https://example.invalid/mcp',
    protocol: '2026-07-28',
    allowLoopbackHttp: false
  })
  await click('Edit')
  assert.equal(await evaluate("return document.querySelector('form details').open"), false)
  await click('Save configuration')
  await wait(
    "window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:configure').at(-1).args[0].protocol === '2026-07-28'"
  )
  flows.push('Editing existing stdio or HTTP entries preserves explicit protocol overrides')
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('label')].some((item) => /Installed executable|Working directory|Arguments|Optional inherited/.test(item.textContent)) || !!document.querySelector('input[type=password]')"
    ),
    false
  )
  assert.equal(await count('agent-mcp:start'), httpStartsBefore)
  assert.equal(await count('agent-mcp:prepare-launch'), httpReviewsBefore)
  assert.equal(
    await evaluate(
      'return window.__fixture.calls.some((item) => /auth|credential/.test(item.channel))'
    ),
    false
  )
  flows.push(
    'HTTP transport hides stdio/credential fields, rejects remote HTTP and URL credentials, and saves exact anonymous configuration without startup or auth IPC'
  )

  await click('Review startup')
  await wait(reviewOpen)
  assert.equal(
    await evaluate(
      "const text = document.body.textContent.replace(/\\s+/g, ' '); return text.includes('Review exact HTTP connection') && text.includes('https://example.invalid/mcp') && text.includes('Authentication revision: fixture-anonymous-v1') && text.includes('Confirm only if you trust the exact endpoint and authentication revision in this disclosure.') && text.includes('Starting sends initialization and metadata requests over the network before tool approval.') && text.includes('The disclosure identifies the exact authentication state. This Start does not request an OAuth grant.') && text.includes('Its metadata may go to the selected AI provider; approved returned text enters the local transcript and may go to that provider.')"
    ),
    true
  )
  assert.equal(
    await evaluate(
      "return document.querySelector('[aria-label=\"Review exact MCP launch\"]').textContent.includes('installed executable')"
    ),
    false
  )
  await click('Cancel')
  await wait(`!(${reviewOpen})`)
  assert.equal(await count('agent-mcp:start'), httpStartsBefore)
  await click('Review startup')
  await wait(reviewOpen)
  await fill('Endpoint URL', 'http://127.0.0.1:8123/mcp')
  await wait(`!(${reviewOpen})`)
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Review startup').disabled"
    ),
    true
  )
  await click('Save configuration')
  await wait("document.body.textContent.includes('Use HTTPS, or explicitly allow HTTP')")
  await evaluate(
    "const field = [...document.querySelectorAll('label')].find((item) => item.textContent.includes('Allow unencrypted HTTP'))?.querySelector('input'); if (!field || field.disabled) throw new Error('Missing local HTTP opt-in'); field.checked = true; field.dispatchEvent(new Event('change', {bubbles:true}))"
  )
  await click('Save configuration')
  await wait("document.body.textContent.includes('Configuration saved')")
  const localHttpSaved = await evaluate(
    "return window.__fixture.calls.findLast((item) => item.channel === 'agent-mcp:configure').args[0]"
  )
  assert.deepEqual(localHttpSaved, {
    ...httpSaved,
    endpoint: 'http://127.0.0.1:8123/mcp',
    allowLoopbackHttp: true
  })
  await click('Review startup')
  await wait(reviewOpen)
  assert.equal(
    await evaluate(
      "return document.querySelector('[aria-label=\"Review exact MCP launch\"] pre').textContent.includes('Endpoint: http://127.0.0.1:8123/mcp')"
    ),
    true
  )
  await evaluate("location.hash = '#other'")
  await wait('window.__fixture.listenerCount() === 0')
  await evaluate('history.back()')
  await wait(
    "document.body.textContent.includes('remote: disabled') && window.__fixture.listenerCount() === 1"
  )
  assert.equal(await evaluate(`return ${reviewOpen}`), false)
  await openSection()
  await click('Edit')
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith('Transport')).querySelector('select').value"
    ),
    'http'
  )
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith('Endpoint URL')).querySelector('input').value"
    ),
    localHttpSaved.endpoint
  )
  assert.equal(
    await evaluate(
      "return [...document.querySelectorAll('label')].find((item) => item.textContent.includes('Allow unencrypted HTTP')).querySelector('input').checked"
    ),
    true
  )
  assert.equal(await count('agent-mcp:start'), httpStartsBefore)
  flows.push(
    'HTTP review discloses exact endpoint/auth revision, network and provider risks; Cancel, endpoint editing and navigation revoke review; explicit local HTTP opt-in and exact configuration survive reopen without replay'
  )

  const oauthReviewOpen = '!!document.querySelector(\'[aria-label="Review exact OAuth action"]\')'
  const oauthPanel = '[aria-label="OAuth public client settings"]'
  const oauthBefore = {
    registrations: await count('agent-mcp:oauth-register'),
    signIns: await count('agent-mcp:oauth-sign-in'),
    connections: await count('agent-mcp:start'),
    launches: await count('agent-mcp:prepare-launch')
  }
  await fill('Endpoint URL', 'https://example.invalid/mcp')
  await evaluate(
    "const field = [...document.querySelectorAll('label')].find((item) => item.textContent.includes('Allow unencrypted HTTP')).querySelector('input'); field.checked = false; field.dispatchEvent(new Event('change', {bubbles:true}))"
  )
  await click('Save configuration')
  await wait(`!!document.querySelector(${JSON.stringify(oauthPanel)})`)
  assert.deepEqual(
    await evaluate(
      `return Object.fromEntries([...document.querySelector(${JSON.stringify(oauthPanel)}).querySelectorAll('label')].map((label) => [label.textContent.trim(), label.querySelector('input,textarea,select')?.value]))`
    ),
    {
      'Public client ID': '',
      'OAuth issuer': '',
      'Loopback port': '49152',
      'Loopback path': '/oauth/callback',
      'Requested scopes (space-separated)': '',
      'Registration client name': 'Bot Commander Desktop'
    }
  )
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations)
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections)
  assert.equal(await count('agent-mcp:prepare-launch'), oauthBefore.launches)
  assert.equal(await evaluate('return !!document.querySelector("input[type=password]")'), false)
  flows.push(
    'Only a saved HTTPS entry offers public OAuth fields; its blank issuer/default loopback settings neither register, sign in nor connect'
  )

  const oauthButtonReady = (label) =>
    wait(
      `[...document.querySelectorAll('button')].some((item) => item.textContent.trim() === ${JSON.stringify(label)} && !item.disabled)`
    )
  const repeatButton = (label) =>
    evaluate(
      `const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)}); if (!button || button.disabled) throw new Error('Missing repeat fixture button'); button.click(); button.dispatchEvent(new MouseEvent('click', {bubbles:true})); button.dispatchEvent(new MouseEvent('click', {bubbles:true}))`
    )
  const escape = async () => {
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
  }
  const lastCall = (channel) =>
    evaluate(
      `return window.__fixture.calls.findLast((item) => item.channel === ${JSON.stringify(channel)})`
    )
  const registrationSettings = {
    issuer: 'https://auth.example.invalid',
    redirectPort: 49153,
    redirectPath: '/fixture/callback',
    scopes: ['mcp:read', 'mcp:write'],
    clientName: 'Fixture desktop client'
  }
  await fill('OAuth issuer', registrationSettings.issuer)
  await fill('Loopback port', String(registrationSettings.redirectPort))
  await fill('Loopback path', registrationSettings.redirectPath)
  await fill('Requested scopes (space-separated)', registrationSettings.scopes.join(' '))
  await fill('Registration client name', registrationSettings.clientName)
  await click('Review registration')
  await wait(oauthReviewOpen)
  assert.deepEqual((await lastCall('agent-mcp:oauth-prepare-registration')).args, [
    'remote',
    registrationSettings
  ])
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations)
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections)
  assert.equal(
    await evaluate(
      "const text = document.querySelector('[aria-label=\"Review exact OAuth action\"] pre').textContent; return ['https://example.invalid/mcp', 'https://auth.example.invalid', 'https://auth.example.invalid/register', 'http://127.0.0.1:49153/fixture/callback', 'mcp:read mcp:write', 'Fixture desktop client', '<svg onload='].every((value) => text.includes(value))"
    ),
    true
  )
  assert.equal(
    await evaluate('return document.querySelectorAll("svg,img,script:not([type=module])").length'),
    0
  )
  assert.equal(await evaluate('return !!window.__mcpInjected'), false)
  const oauthCancelsBefore = await count('agent-mcp:oauth-cancel')
  await click('Cancel OAuth')
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${oauthCancelsBefore}`
  )
  assert.deepEqual((await lastCall('agent-mcp:oauth-cancel')).args, ['remote'])
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations)
  flows.push(
    'Registration review sends exact public settings only; main disclosure is escaped and cancellation does not register or open a browser'
  )

  await evaluate("window.__fixture.hold('agent-mcp:oauth-prepare-registration')")
  const preparingRegistrationsBefore = await count('agent-mcp:oauth-prepare-registration')
  await oauthButtonReady('Review registration')
  await repeatButton('Review registration')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-prepare-registration') === 1")
  assert.equal(
    await count('agent-mcp:oauth-prepare-registration'),
    preparingRegistrationsBefore + 1
  )
  await click('Cancel OAuth')
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-prepare-registration')")
  await oauthButtonReady('Review registration')
  assert.equal(await evaluate(`return ${oauthReviewOpen}`), false)
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations)
  flows.push(
    'Repeated registration preparation is guarded; cancelled late preparation never reopens an OAuth review'
  )

  await click('Review registration')
  await wait(oauthReviewOpen)
  const draftCancelsBefore = await count('agent-mcp:oauth-cancel')
  await fill('Registration client name', 'Changed fixture client')
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${draftCancelsBefore}`
  )
  await fill('Registration client name', registrationSettings.clientName)
  await oauthButtonReady('Review registration')
  await click('Review registration')
  await wait(oauthReviewOpen)
  const escapeCancelsBefore = await count('agent-mcp:oauth-cancel')
  await escape()
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${escapeCancelsBefore}`
  )
  await evaluate('window.__fixture.oauthDuration = 80')
  const expiryCancelsBefore = await count('agent-mcp:oauth-cancel')
  await oauthButtonReady('Review registration')
  await click('Review registration')
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${expiryCancelsBefore}`
  )
  await evaluate('window.__fixture.oauthDuration = 120000')
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations)
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns)
  flows.push(
    'OAuth public-draft edits, Escape and expiry revoke owned registration reviews without registration or browser launch'
  )

  await oauthButtonReady('Review registration')
  await click('Review registration')
  await wait(oauthReviewOpen)
  await evaluate("window.__fixture.hold('agent-mcp:oauth-register')")
  await repeatButton('Register once')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-register') === 1")
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations + 1)
  assert.equal(await evaluate(`return ${oauthReviewOpen}`), false)
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections)
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-register')")
  await oauthButtonReady('Review sign-in')
  assert.equal(
    await evaluate('return window.__fixture.status().servers[0].oauth.state'),
    'configured'
  )
  assert.deepEqual(await evaluate('return window.__fixture.oauthCompletions'), {
    registrations: 1,
    signIns: 0
  })
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  flows.push(
    'Register once is duplicate-guarded and configures a public client only; browser sign-in and MCP connection each still need separate approval'
  )

  await click('Review sign-in')
  await wait(oauthReviewOpen)
  assert.deepEqual((await lastCall('agent-mcp:oauth-prepare-sign-in')).args, ['remote'])
  assert.equal(
    await evaluate(
      "const text = document.querySelector('[aria-label=\"Review exact OAuth action\"] pre').textContent; return text.includes('https://auth.example.invalid/authorize') && text.includes('fixture-registered-public-client') && text.includes('<svg onload=')"
    ),
    true
  )
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns)
  await evaluate("window.__fixture.hold('agent-mcp:oauth-sign-in')")
  await repeatButton('Open browser once')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-sign-in') === 1")
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns + 1)
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections)
  const signInLaunchesBefore = await count('agent-mcp:prepare-launch')
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-sign-in')")
  await wait(reviewOpen)
  assert.equal(await evaluate(`return ${oauthReviewOpen}`), false)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections)
  assert.equal(await count('agent-mcp:prepare-launch'), signInLaunchesBefore)
  const grantRevision = await evaluate('return window.__fixture.status().servers[0].oauth.revision')
  assert.equal(
    await evaluate(
      `const review = document.querySelector('[aria-label="Review exact MCP launch"]'); return review.textContent.includes('Review exact HTTP connection') && review.querySelector('pre').textContent.includes(${JSON.stringify('Authentication revision: ' + grantRevision)})`
    ),
    true
  )
  assert.deepEqual(await evaluate('return window.__fixture.oauthCompletions'), {
    registrations: 1,
    signIns: 1
  })
  await click('Start once')
  await wait("document.body.textContent.includes('remote: connected')")
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections + 1)
  await click('Disconnect')
  await wait("document.body.textContent.includes('remote: disabled')")
  flows.push(
    'Explicit browser sign-in is duplicate-guarded and returns a fresh HTTP disclosure; OAuth success never initializes MCP until separate Start once approval'
  )

  const configuredBefore = await count('agent-mcp:oauth-configure-client')
  const preregisteredClient = {
    id: 'fixture-preregistered-public-client',
    issuer: registrationSettings.issuer,
    redirectPort: 49154,
    redirectPath: '/preregistered/callback',
    scopes: ['mcp:read']
  }
  await fill('Public client ID', preregisteredClient.id)
  await fill('OAuth issuer', preregisteredClient.issuer)
  await fill('Loopback port', String(preregisteredClient.redirectPort))
  await fill('Loopback path', preregisteredClient.redirectPath)
  await fill('Requested scopes (space-separated)', preregisteredClient.scopes.join(' '))
  await click('Configure public client')
  await oauthButtonReady('Review sign-in')
  assert.equal(await count('agent-mcp:oauth-configure-client'), configuredBefore + 1)
  assert.deepEqual((await lastCall('agent-mcp:oauth-configure-client')).args, [
    'remote',
    preregisteredClient
  ])
  assert.equal(await count('agent-mcp:oauth-register'), oauthBefore.registrations + 1)
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns + 1)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections + 1)
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  flows.push(
    'Preregistered public-client configuration has its own exact IPC and remains inert, without dynamic registration, sign-in, credentials or startup'
  )

  await click('Review sign-in')
  await wait(oauthReviewOpen)
  const signInCancelBefore = await count('agent-mcp:oauth-cancel')
  await click('Cancel OAuth')
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${signInCancelBefore}`
  )
  await evaluate("window.__fixture.hold('agent-mcp:oauth-prepare-sign-in')")
  const pendingSignInBefore = await count('agent-mcp:oauth-prepare-sign-in')
  await oauthButtonReady('Review sign-in')
  await repeatButton('Review sign-in')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-prepare-sign-in') === 1")
  assert.equal(await count('agent-mcp:oauth-prepare-sign-in'), pendingSignInBefore + 1)
  const pendingDraftCancelBefore = await count('agent-mcp:oauth-cancel')
  await fill('Requested scopes (space-separated)', 'mcp:read mcp:inspect')
  await wait(
    `window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${pendingDraftCancelBefore}`
  )
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-prepare-sign-in')")
  await oauthButtonReady('Configure public client')
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  assert.equal(await count('agent-mcp:oauth-sign-in'), oauthBefore.signIns + 1)
  await fill('Requested scopes (space-separated)', 'mcp:read')
  await click('Configure public client')
  await oauthButtonReady('Review sign-in')
  flows.push(
    'Cancelling sign-in review and editing a pending public draft revoke owned flow; repeated preparation and late responses cannot open the browser'
  )

  await click('Review sign-in')
  await wait(oauthReviewOpen)
  await evaluate("window.__fixture.hold('agent-mcp:oauth-sign-in')")
  await click('Open browser once')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-sign-in') === 1")
  const lateLaunchCancelsBefore = await count('agent-mcp:cancel-launch')
  await click('Cancel OAuth')
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-sign-in')")
  await wait(
    `!(${oauthReviewOpen}) && !(${reviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:cancel-launch').length > ${lateLaunchCancelsBefore}`
  )
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections + 1)
  assert.deepEqual(await evaluate('return window.__fixture.oauthCompletions'), {
    registrations: 1,
    signIns: 1
  })
  flows.push(
    'Cancel OAuth remains available during browser sign-in; its late fresh MCP launch token is revoked without a connection review or replay'
  )

  await oauthButtonReady('Review sign-in')
  await click('Review sign-in')
  await wait(oauthReviewOpen)
  const signInEscapeBefore = await count('agent-mcp:oauth-cancel')
  await escape()
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${signInEscapeBefore}`
  )
  await oauthButtonReady('Review sign-in')
  await evaluate('window.__fixture.oauthDuration = 80')
  const signInExpiryBefore = await count('agent-mcp:oauth-cancel')
  await click('Review sign-in')
  await wait(
    `!(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${signInExpiryBefore}`
  )
  await evaluate('window.__fixture.oauthDuration = 120000')
  flows.push('Escape and expiry also revoke sign-in reviews; neither approval is silently retained')

  await oauthButtonReady('Review sign-in')
  await click('Review sign-in')
  await wait(oauthReviewOpen)
  const closeCancelsBefore = await count('agent-mcp:oauth-cancel')
  await click('Close')
  await wait(
    `!document.querySelector('dialog[open]') && !(${oauthReviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${closeCancelsBefore}`
  )
  await openSection()
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  flows.push(
    'Closing the server dialog revokes pending OAuth review; reopening does not restore approval'
  )

  await oauthButtonReady('Review sign-in')
  await click('Review sign-in')
  await wait(oauthReviewOpen)
  await evaluate("window.__fixture.hold('agent-mcp:oauth-sign-in')")
  await click('Open browser once')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-sign-in') === 1")
  const navigationOAuthCalls = await count('agent-mcp:oauth-sign-in')
  const navigationLaunchCancelsBefore = await count('agent-mcp:cancel-launch')
  const navigationOAuthCancelsBefore = await count('agent-mcp:oauth-cancel')
  await evaluate("location.hash = '#other'")
  await wait(
    `window.__fixture.listenerCount() === 0 && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${navigationOAuthCancelsBefore}`
  )
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-sign-in'); history.back()")
  await wait(
    `window.__fixture.listenerCount() === 1 && !(${oauthReviewOpen}) && !(${reviewOpen}) && window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:cancel-launch').length > ${navigationLaunchCancelsBefore}`
  )
  await evaluate('history.forward()')
  await wait('window.__fixture.listenerCount() === 0')
  await evaluate('history.back()')
  await wait('window.__fixture.listenerCount() === 1')
  await openSection()
  assert.equal(await count('agent-mcp:oauth-sign-in'), navigationOAuthCalls)
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections + 1)
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  flows.push(
    'Unmount cancels browser sign-in and revokes its late connection token; Back/Forward remounts one listener without OAuth or MCP replay'
  )

  await fill('OAuth issuer', registrationSettings.issuer)
  await fill('Registration client name', registrationSettings.clientName)
  await click('Review registration')
  await wait(oauthReviewOpen)
  await evaluate("window.__fixture.hold('agent-mcp:oauth-register')")
  await click('Register once')
  await wait("window.__fixture.pendingCount('agent-mcp:oauth-register') === 1")
  const registrationDraftCancelBefore = await count('agent-mcp:oauth-cancel')
  await fill('Registration client name', 'Cancelled in-flight fixture client')
  await wait(
    `window.__fixture.calls.filter((item) => item.channel === 'agent-mcp:oauth-cancel').length > ${registrationDraftCancelBefore}`
  )
  await evaluate("window.__fixture.resolve('agent-mcp:oauth-register')")
  await oauthButtonReady('Review registration')
  assert.equal(await evaluate(`return ${oauthReviewOpen} || ${reviewOpen}`), false)
  assert.deepEqual(await evaluate('return window.__fixture.oauthCompletions'), {
    registrations: 1,
    signIns: 1
  })
  assert.equal(await count('agent-mcp:start'), oauthBefore.connections + 1)
  flows.push(
    'Editing public settings cancels in-flight registration; late registration completion cannot resurrect review, launch sign-in or connect MCP'
  )

  const outcomeRoute = async (name) => {
    await evaluate(`location.hash = ${JSON.stringify('#outcome-' + name)}`)
    await wait(
      `!!document.querySelector('[aria-label="MCP operation outcome"]') && document.getElementById('app').dataset.route === ${JSON.stringify('#outcome-' + name)} && window.__fixture.listenerCount() === 0`
    )
    await evaluate(
      'document.querySelector(\'[aria-label="MCP operation outcome"] details\').open = true'
    )
  }
  await outcomeRoute('confirmedError')
  await wait("document.body.textContent.includes('External error response confirmed')")
  assert.equal(
    await evaluate(
      "return document.querySelector('[aria-label=\"MCP operation outcome\"] pre').textContent.includes('fixture_server_error')"
    ),
    true
  )
  assert.equal(
    await evaluate(
      "return document.querySelector('[aria-label=\"MCP operation outcome\"] pre').textContent.includes('x'.repeat(40000))"
    ),
    true
  )
  assert.equal(
    await evaluate(
      'return document.querySelectorAll(\'[aria-label="MCP operation outcome"] img,[aria-label="MCP operation outcome"] script\').length'
    ),
    0
  )
  assert.equal(await evaluate('return !!window.__mcpInjected'), false)
  assert.equal(
    await evaluate(
      "const pre = document.querySelector('[aria-label=\"MCP operation outcome\"] pre'); const style = getComputedStyle(pre); return style.whiteSpace === 'pre-wrap' && style.overflowY === 'auto' && pre.scrollHeight > pre.clientHeight"
    ),
    true
  )
  flows.push(
    'Confirmed MCP error retains escaped wrapped scrollable result JSON, including returned text beyond 24,000 characters'
  )

  await outcomeRoute('unknown')
  await wait(
    "document.body.textContent.includes('External outcome is unknown') && document.body.textContent.includes('Do not retry automatically')"
  )
  assert.equal(
    await evaluate(
      "return document.body.textContent.includes('External request was not attempted')"
    ),
    false
  )
  await evaluate(
    'document.querySelector(\'[aria-label="MCP operation outcome"] details\').open = false'
  )
  assert.equal(
    await evaluate(
      "const warning = document.querySelector('[aria-label=\"MCP operation outcome\"] [role=status]'); return warning.getBoundingClientRect().height > 0 && warning.textContent.includes('unknown')"
    ),
    true
  )
  flows.push(
    'Unknown-outcome warning remains visible outside collapsed result details and never claims not attempted'
  )

  await outcomeRoute('notSent')
  await wait("document.body.textContent.includes('External request was not attempted')")
  assert.equal(
    await evaluate("return document.body.textContent.includes('External outcome is unknown')"),
    false
  )
  flows.push('Not-sent display distinguishes zero attempted request from unknown external outcome')

  await outcomeRoute('checkpoint')
  await wait(
    "document.body.textContent.includes('Outcome checkpointing is unconfirmed') && document.body.textContent.includes('External response confirmed')"
  )
  assert.equal(
    await evaluate(
      "return document.querySelector('[aria-label=\"MCP operation outcome\"] pre').textContent.includes('Confirmed response with failed local checkpoint')"
    ),
    true
  )
  flows.push(
    'Checkpoint failure preserves confirmed response details and an independent visible recovery warning'
  )

  await outcomeRoute('oversized')
  await wait("document.body.textContent.includes('Result display truncated at 64 KiB')")
  assert.equal(
    await evaluate(
      'return new TextEncoder().encode(document.querySelector(\'[aria-label="MCP operation outcome"] pre\').textContent).length <= 65536'
    ),
    true
  )
  assert.equal(
    await evaluate(
      "return document.body.textContent.includes('External outcome is unknown') && document.body.textContent.includes('Outcome checkpointing is unconfirmed')"
    ),
    true
  )
  flows.push(
    'Oversized multibyte result display is bounded without clipping host-owned unknown/checkpoint warnings'
  )

  const report = {
    passed: true,
    engine: await send('Browser.getVersion'),
    flows,
    calls: await evaluate('return window.__fixture.calls'),
    browserErrors,
    expressionChecks,
    fixtureScriptChecks,
    limitations: [
      'Isolated real Svelte controls/outcome components and app CSS with fake IPC, not the full Electron application',
      'No real MCP executable, HTTP endpoint, provider, Discord, credentials, OAuth or installation',
      'Headless Chromium only; no native platform dialogs'
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
