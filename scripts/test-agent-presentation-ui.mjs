/** Offline real Svelte agent entries and shared corpus, using fake IPC in headless Chromium.
 * Run: node scripts/test-agent-presentation-ui.mjs
 * Requires installed Chromium. No provider, bot, external server or credentials are used.
 */
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { parse } from 'acorn'

// Parse all literal browser expressions before Chromium starts. Dynamic helpers additionally
// validate their final generated expression before sending it to DevTools.
const expressionSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
const expressionAst = parse(expressionSource, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  locations: true
})
let expressionChecks = 0
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
if (process.argv.includes('--validate-expressions')) {
  console.log(JSON.stringify({ expressionChecks, syntaxValidated: true, browserExecuted: false }))
  process.exit(0)
}

// Match Vite's canonical file paths, including directory casing on Windows.
const root = realpathSync
  .native(resolve(dirname(fileURLToPath(import.meta.url)), '..'))
  .replaceAll('\\', '/')
const fixtureDir = await mkdtemp(join(root, '.agent-presentation-ui-'))
let vite
let chromium
let socket
const browserErrors = []
const flows = []
let phase = 'fixture preparation'
let primaryError
let evaluate
let command

async function screenshot(name) {
  if (!process.env.PRESENTATION_UI_SCREENSHOTS) return
  const directory = resolve(process.env.PRESENTATION_UI_SCREENSHOTS)
  await mkdir(directory, { recursive: true })
  await evaluate(
    'await Promise.race([document.fonts.ready, new Promise(done => setTimeout(done, 1000))]); await new Promise(done => setTimeout(done, 350))'
  )
  const { data } = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(directory, name + '.png'), Buffer.from(data, 'base64'))
}

try {
  let iconStyle = ''
  if (process.env.PRESENTATION_UI_ICON_FONT) {
    await writeFile(
      join(fixtureDir, 'icons.ttf'),
      await readFile(process.env.PRESENTATION_UI_ICON_FONT)
    )
    iconStyle =
      '<style>@font-face{font-family:MaterialSymbols;src:url(/icons.ttf)}.material-symbols-outlined{font-family:MaterialSymbols;font-weight:normal;font-style:normal;line-height:1;display:inline-block;white-space:nowrap;font-feature-settings:"liga"}</style>'
  }
  await writeFile(
    join(fixtureDir, 'index.html'),
    '<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title>Offline shared tool presentation</title>' +
      iconStyle +
      '</head><body style="margin:0;overflow:hidden"><main id="app" style="height:100vh"></main><script type="module" src="/main.js"></script></body></html>'
  )
  await writeFile(
    join(fixtureDir, 'main.js'),
    `
import { mount, unmount } from 'svelte'
import { get } from 'svelte/store'
import { loadSettings, settingsStore } from '/@fs/${root}/src/renderer/src/stores/settings.ts'
import Panel from '/@fs/${root}/src/renderer/src/components/AgentPanel.svelte'
import Tool from '/@fs/${root}/src/renderer/src/components/AgentToolPresentation.svelte'
import { toolPresentationCorpus, presentationFixture } from '/@fs/${root}/src/renderer/src/utils/fixtures/toolPresentationCorpus.ts'
import { agentSessions, destroyAgentListeners } from '/@fs/${root}/src/renderer/src/stores/agent.ts'
import { AUTO_REVIEW_POLICY_REVISION } from '/@fs/${root}/src/shared/agentAutoReview.ts'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'
import '/@fs/${root}/src/renderer/app.css'
const clone = (value) => structuredClone(value)
const mcp = { runId: 'offline-run', serverId: 'offline-server', operationDigest: 'offline-digest', catalogKind: 'tools', remoteKey: 'offline-key', outcome: 'pending', requestSent: false, disclosure: 'Exact offline action: change ordinary fixture. Host approval only.' }
const call = { id: 'offline-call', name: 'offline_tool', arguments: { resource: 'fixture', limit: 5 }, status: 'waiting_approval', approvalId: 'offline-approval', createdAt: '2026-10-10T00:00:00.000Z', mcp }
let session = { id: 'offline-session', title: 'Offline agent fixture', model: 'fixture-model', reasoningEffort: 'none', mode: 'manual', status: 'waiting_approval', activeRunId: 'offline-run', messages: [{ id: 'user-1', role: 'user', content: 'User first', timestamp: call.createdAt }, { id: 'assistant-1', role: 'assistant', content: 'Assistant second', timestamp: call.createdAt }, { id: 'tool-1', role: 'tool', content: '', toolCalls: [clone(call)], timestamp: call.createdAt }, { id: 'assistant-2', role: 'assistant', content: 'Assistant last', timestamp: call.createdAt }], createdAt: call.createdAt, updatedAt: call.createdAt, tokenCount: 0, planReady: false }
session.lastRunMetrics = { runId: 'offline-run', status: 'completed', startedAt: call.createdAt, finishedAt: '2026-10-10T00:00:42.000Z', providerRounds: 3, inputTokens: 1200, outputTokens: 340, totalTokens: 1540, cachedInputTokens: 200, documentationCalls: 2, uniqueDocumentationCalls: 1, duplicateDocumentationCalls: 1, documentationResultChars: 640, usageReconciled: true, tools: [{ id: call.id, name: call.name, status: 'completed' }] }
const listeners = new Map()
const calls = []
let auditRows = []
let auditRecoveryRequired = false
let enrollmentFailure = false
let enrollmentDelay = 0
let enrollmentInFlight = false
let capabilitySnapshot
let savedSettings = JSON.parse(sessionStorage.getItem('fixture-settings') || 'null') || { ...get(settingsStore), theme: 'dark' }
const data = () => ({ sessions: [clone(session)], activeSessionId: session.id, modelDefaultsByProvider: {} })
window.electron = { ipcRenderer: {
  on(channel, listener) { const group = listeners.get(channel) || new Set(); group.add(listener); listeners.set(channel, group) },
  removeListener(channel, listener) { listeners.get(channel)?.delete(listener) },
  invoke(channel, ...args) { calls.push({ channel, args: clone(args) });
    if (channel === 'get-settings') return Promise.resolve(clone(savedSettings))
    if (channel === 'save-settings') {
      savedSettings = clone(args[0])
      sessionStorage.setItem('fixture-settings', JSON.stringify(savedSettings))
      return Promise.resolve(clone(savedSettings))
    }
    if (channel === 'agent:list') return Promise.resolve(data())
    if (channel === 'agent:update') {
      session = { ...session, ...clone(args[1]) }
      return Promise.resolve(clone(session))
    }
    if (channel === 'agent:inspect-auto-review-audit') return Promise.resolve({ id: 'offline-inspection', policyRevision: AUTO_REVIEW_POLICY_REVISION, provider: 'openai', accountRevision: savedSettings.agentDecisionAccountRevision, inspectedAt: call.createdAt, recoveryRequired: auditRecoveryRequired, canAcknowledge: true, rows: clone(auditRows) })
    if (channel === 'agent:enroll-auto-review') {
      if (enrollmentFailure) return Promise.reject(new Error('Offline enrollment save failed'))
      const enrollment = args[1]
      enrollmentInFlight = true
      return new Promise(resolve => setTimeout(() => {
        if (enrollment.recoveryInspectionId) auditRecoveryRequired = false
        session = { ...session, ...(enrollment.activate ? { mode: 'auto', planReady: false } : {}), autoReviewEnrollment: { policyRevision: enrollment.policyRevision, provider: enrollment.provider, accountRevision: enrollment.accountRevision, acknowledgedAt: call.createdAt, ...(enrollment.web ? { web: clone(enrollment.web) } : {}) } }
        enrollmentInFlight = false
        resolve(clone(session))
      }, enrollmentDelay))
    }
    if (channel === 'agent:resolve-plan') {
      session = { ...session, mode: args[1], planReady: false }
      agentSessions.set(data())
      return Promise.resolve(clone(session))
    }
    if (channel === 'fetch-ai-models') return Promise.resolve([])
    if (channel === 'skills:list') return Promise.resolve({ skills: [], diagnostics: [], externalRoots: [], ownedRoot: '/offline/skills', saveSupport: { available: false, reason: 'Offline display-only fixture' } })
    if (channel === 'get-ai-model-capabilities') {
      const result = capabilitySnapshot ? clone(capabilitySnapshot) : {}
      return new Promise(resolve => setTimeout(() => resolve(result), capabilitySnapshot ? 150 : 0))
    }
    if (channel === 'agent:approve') return Promise.resolve(false)
    if (channel === 'agent:set-active') return Promise.resolve()
    throw new Error('Unexpected fixture IPC: ' + channel)
  },
  send(channel, ...args) { calls.push({ channel, args: clone(args) }) }
} }
window.__fixture = {
  calls,
  corpus: clone(toolPresentationCorpus),
  snapshot: () => data(),
  pendingEnrollment: () => enrollmentInFlight,
  async configureAutoReview(options = {}) {
    auditRows = options.auditRows || []
    auditRecoveryRequired = options.recoveryRequired ?? (auditRows.length > 0)
    enrollmentFailure = options.failEnrollment || false
    enrollmentDelay = options.enrollmentDelay || 0
    savedSettings = { ...savedSettings, aiProvider: options.noReviewer ? 'deepseek' : 'openai', agentReviewerProvider: undefined, agentDecisionAccountRevision: 'offline-account', webProvider: options.web ? 'deepseek' : 'disabled', agentWebAccountRevision: 'offline-web-account' }
    await loadSettings()
    session = { ...session, mode: options.plan ? 'planning' : 'manual', status: 'completed', planReady: !!options.plan, autoReviewEnrollment: undefined, autoReviewMigrationRequired: false }
    agentSessions.set(data())
  },
  failEnrollment(value) { enrollmentFailure = value },
  setCapabilityModel(model = 'gpt-5.1') {
    capabilitySnapshot = { capabilities: normalizeModelCapabilities({ apiVersion: 1, provider: 'openai', protocol: 'responses', model: { id: model } }) }
    session = { ...session, model, reasoningEffort: 'high' }
    agentSessions.set(data())
  },
  setMetrics(patch) {
    session = { ...session, lastRunMetrics: { ...session.lastRunMetrics, ...clone(patch) } }
    agentSessions.set(data())
  },
  setCall(patch, runStatus = 'completed') {
    session = { ...session, status: runStatus, messages: session.messages.map(message => message.toolCalls ? { ...message, toolCalls: [{ ...message.toolCalls[0], ...clone(patch) }] } : message) }
    for (const listener of listeners.get('agent:event') || []) listener({ sessionId: session.id, runId: session.activeRunId, type: 'session', session: clone(session) })
  },
  setTemplateCall() {
    const uriTemplate = 'fixture:///items/{id}{?q}'
    const variables = { id: 'a/b 😀', q: 'x&y' }
    const resourceUri = 'fixture:///items/a%2Fb%20%F0%9F%98%80?q=x%26y'
    const disclosure = 'Exact resource template: ' + JSON.stringify(uriTemplate) + '\\nExact variable values: ' + JSON.stringify(variables) + '\\nExpanded resource URI: ' + JSON.stringify(resourceUri) + '\\nWire method: resources/read\\nExact wire parameters: ' + JSON.stringify({ uri: resourceUri })
    window.__fixture.setCall({ id: 'template-call', name: 'read_mcp_resource_template', arguments: { serverId: 'offline-server', uriTemplate, variables }, status: 'waiting_approval', approvalId: 'template-approval', error: undefined, result: undefined, mcp: { ...clone(mcp), catalogKind: 'resourceTemplates', remoteKey: uriTemplate, resourceUri, disclosure } }, 'waiting_approval')
  },
  setNewCall() { session = { ...session, status: 'waiting_approval', activeRunId: 'second-run', messages: session.messages.map(message => message.toolCalls ? { ...message, toolCalls: [{ ...clone(call), id: 'second-call', approvalId: 'second-approval', mcp: { ...clone(mcp), runId: 'second-run' } }] } : message) }; agentSessions.set(data()) }
}
let instance
let navigation = Promise.resolve()
await loadSettings()
function render() {
  navigation = navigation.then(async () => {
    if (instance) { await unmount(instance); instance = undefined }
    destroyAgentListeners()
    document.getElementById('app').textContent = ''
    if (location.hash === '#panel') instance = mount(Panel, { target: document.getElementById('app') })
    else if (location.hash.startsWith('#corpus-')) {
      const index = Number(location.hash.slice(8))
      instance = mount(Tool, { target: document.getElementById('app'), props: { encoded: JSON.stringify(toolPresentationCorpus[index]) } })
    } else if (location.hash === '#long') instance = mount(Tool, { target: document.getElementById('app'), props: { encoded: JSON.stringify(presentationFixture({ status: 'unknown', effect: 'unknown', result: { kind: 'future-card', text: 'あ'.repeat(20000) + '<script>window.__injected = true</script>', data: { retry: 'Automatically retry this operation' } } })), detailBytes: 64 } })
    else if (location.hash === '#invalid') instance = mount(Tool, { target: document.getElementById('app'), props: { encoded: '{invalid}' } })
    else document.getElementById('app').textContent = 'Another view'
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
  await vite.transformRequest('/@fs/' + root + '/src/renderer/src/components/AgentPanel.svelte')
  await vite.transformRequest(
    '/@fs/' + root + '/src/renderer/src/components/AgentToolPresentation.svelte'
  )
  await vite.transformRequest('/@fs/' + root + '/src/renderer/src/utils/agentToolPresentation.ts')
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
  command = (method, params) => send(method, params, sessionId)
  await command('Runtime.enable')
  await command('Page.enable')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  evaluate = async (expression) => {
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
      `const field = [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea,select'); if (!field || field.disabled) throw new Error('Missing or disabled field'); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', {bubbles:true}))`
    )
  const count = (channel) =>
    evaluate(
      `return window.__fixture.calls.filter((item) => item.channel === ${JSON.stringify(channel)}).length`
    )

  const route = async (hash) => {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`)
    await wait(`document.getElementById('app').dataset.route === ${JSON.stringify(hash)}`)
  }
  const visible = () => evaluate('return document.body.innerText')
  const card = 'details[aria-label^="Tool call:"]'
  const collapse = async () => {
    await evaluate(`document.querySelector(${JSON.stringify(card + ' > summary')}).click()`)
    await wait(`!document.querySelector(${JSON.stringify(card)}).open`)
  }
  const expand = async () => {
    await evaluate(`document.querySelector(${JSON.stringify(card + ' > summary')}).focus()`)
    await command('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    })
    await command('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ' ',
      code: 'Space',
      windowsVirtualKeyCode: 32
    })
    await wait(`document.querySelector(${JSON.stringify(card)}).open`)
  }
  phase = 'shared semantic corpus'
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/#corpus-0` })
  await wait(
    '!!window.__fixture && !!document.querySelector("[aria-label=\\\"Shared tool presentation\\\"]")'
  )
  const corpus = await evaluate('return window.__fixture.corpus')
  for (const [index, fixture] of corpus.entries()) {
    await route('#corpus-' + index)
    const text = await visible()
    assert.ok(text.includes('Status: ' + fixture.status))
    assert.ok(text.includes('Effect: ' + fixture.effect))
    assert.ok(text.includes(fixture.source.reference))
    assert.ok(text.includes(fixture.source.revision))
    assert.equal(await evaluate('return !!document.querySelector("details")'), false)
    if (fixture.status === 'approval_required') assert.match(text, /Approval required/)
    if (fixture.status === 'denied') assert.match(text, /request denied/)
    if (fixture.status === 'failed') assert.match(text, /Tool failed/)
    if (fixture.effect === 'unknown') assert.match(text, /Do not retry automatically/)
    if (fixture.progress) assert.ok(text.includes(fixture.progress.text))
    for (const warning of fixture.warnings || []) assert.ok(text.includes(warning))
    assert.ok(text.includes('{"limit":5,"resource":"fixture"}'))
    if (fixture.result?.kind === 'future-card') {
      assert.match(text, /unsupported presentation kind/)
      assert.ok(text.includes(fixture.result.text))
      assert.equal(text.includes('Automatically retry this operation'), false)
    }
  }
  flows.push(
    'All nine common CORE-13 semantic fixtures show exact status/effect, source/revision, arguments, result, progress and warnings together without a nested disclosure'
  )
  await route('#long')
  assert.match(await visible(), /unsupported presentation kind/)
  assert.equal(
    await evaluate(
      'return new TextEncoder().encode([...document.querySelectorAll("pre")].map(node => node.textContent).join("")).length <= 64'
    ),
    true
  )
  assert.match(await visible(), /Detail display truncated/)
  assert.match(await visible(), /Do not retry automatically/)
  assert.equal(
    await evaluate(
      'return !!window.__injected || !!document.querySelector("a,img,svg,script:not([type=module])")'
    ),
    false
  )
  flows.push(
    'Long multibyte fallback is clipped only in details; unsupported-kind/unknown warnings and provenance remain visible, without foreign HTML or activation'
  )
  await route('#invalid')
  assert.match(await visible(), /invalid or exceeds/)
  flows.push('Invalid presentation keeps a visible safe fallback rather than dropping the entry')

  phase = 'actual AgentPanel entries and host-owned approval'
  await route('#panel')
  await wait("document.body.innerText.includes('Approval required')")
  await collapse()
  assert.equal((await visible()).includes('Status: approval_required'), false)
  assert.equal((await visible()).includes('Exact offline action:'), false)
  await expand()
  assert.equal(await count('agent:approve'), 0)
  const before = await evaluate('return window.__fixture.snapshot()')
  const order = await evaluate('return document.body.innerText')
  assert.ok(order.indexOf('User first') < order.indexOf('Assistant second'))
  assert.ok(order.indexOf('Assistant second') < order.indexOf('Tool "offline_tool"'))
  assert.ok(order.indexOf('Tool "offline_tool"') < order.indexOf('Assistant last'))
  assert.equal(
    await evaluate(
      'return !![...document.querySelectorAll("div")].find(node => node.textContent.trim() === "User first" && node.classList.contains("bg-primary"))'
    ),
    true
  )
  await collapse()
  await expand()
  assert.equal(await count('agent:approve'), 0)
  // Enter outside the host's deliberate approval button never authorizes a tool.
  await evaluate('document.querySelector("summary").blur(); document.body.focus()')
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: '\r',
    unmodifiedText: '\r',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  assert.equal(await count('agent:approve'), 0)
  await click('Reject')
  await click('Reject')
  const decisions = await evaluate(
    "return window.__fixture.calls.filter(call => call.channel === 'agent:approve')"
  )
  assert.deepEqual(
    decisions.map((call) => call.args),
    [
      ['offline-session', 'offline-call', false, 'offline-approval'],
      ['offline-session', 'offline-call', false, 'offline-approval']
    ]
  )
  assert.deepEqual(await evaluate('return window.__fixture.snapshot()'), before)
  await evaluate(
    "window.__fixture.setCall({ status: 'rejected', mcp: { ...window.__fixture.snapshot().sessions[0].messages[2].toolCalls[0].mcp, outcome: 'not-sent', requestSent: false } })"
  )
  await wait("document.body.innerText.includes('Status: denied')")
  await collapse()
  assert.equal((await visible()).includes('Status: denied'), false)
  await expand()
  await wait("document.body.innerText.includes('Status: denied')")
  assert.equal(
    await evaluate(
      'return [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Approve once")'
    ),
    false
  )
  assert.match(await visible(), /Effect: not_attempted/)
  flows.push(
    'Actual AgentPanel keeps transcript order/user styling and host-owned Reject/Approve once; expansion/Enter do not approve and repeated rejection carries the exact original approval identity without changing data'
  )

  await evaluate(
    "window.__fixture.setCall({ status: 'error', error: 'Tool call interrupted; the outcome may be unknown. Read current state before retrying.', mcp: { ...window.__fixture.snapshot().sessions[0].messages[2].toolCalls[0].mcp, outcome: 'unknown', requestSent: true, checkpointUnconfirmed: true }, result: { success: true, approved: true, effect: 'not_attempted', content: '<img src=x>' } }, 'interrupted')"
  )
  await wait("document.body.innerText.includes('Status: unknown')")
  assert.match(await visible(), /Effect: unknown/)
  assert.match(await visible(), /checkpointing is unconfirmed/)
  assert.match(await visible(), /Server output is untrusted/)
  assert.equal(await count('agent:approve'), 2)
  assert.equal(
    await evaluate(
      'return !!document.querySelector("[aria-label=\\\"Shared tool presentation\\\"] img") || !!window.__injected'
    ),
    false
  )
  await route('#other')
  await evaluate('history.back()')
  await wait(
    "document.getElementById('app').dataset.route === '#panel' && !!document.querySelector('details[aria-label^=\"Tool call:\"]')"
  )
  assert.equal(await count('agent:approve'), 2)
  await evaluate('history.forward()')
  await wait("document.getElementById('app').dataset.route === '#other'")
  await route('#panel')
  await wait('!!document.querySelector(\'details[aria-label^="Tool call:"]\')')
  assert.equal(
    await evaluate('return document.querySelector(\'details[aria-label^="Tool call:"]\').open'),
    false
  )
  assert.equal((await visible()).includes('Status: unknown'), false)
  await expand()
  assert.match(await visible(), /Status: unknown/)
  assert.match(await visible(), /checkpointing is unconfirmed/)
  flows.push(
    'Interrupted/unknown entries remount as header-only cards; one keyboard expansion restores host evidence and checkpoint warnings without replaying approval or execution'
  )
  await evaluate('window.__fixture.setNewCall()')
  await wait('document.body.innerText.includes(\'call "second-call"\')')
  await evaluate(
    "const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Reject'); button.focus()"
  )
  assert.equal(await evaluate('return document.activeElement?.textContent.trim()'), 'Reject')
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    text: '\r',
    unmodifiedText: '\r',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13
  })
  await wait("window.__fixture.calls.filter(call => call.channel === 'agent:approve').length === 3")
  assert.deepEqual(
    await evaluate(
      "return window.__fixture.calls.filter(call => call.channel === 'agent:approve').at(-1).args"
    ),
    ['offline-session', 'second-call', false, 'second-approval']
  )
  await evaluate(
    "window.__fixture.setCall({ status: 'error', error: 'Cancelled offline call; no external request was attempted.', mcp: { ...window.__fixture.snapshot().sessions[0].messages[2].toolCalls[0].mcp, outcome: 'not-sent', requestSent: false } }, 'cancelled')"
  )
  await wait("document.body.innerText.includes('Status: failed')")
  await wait("document.body.innerText.includes('Status: failed')")
  assert.match(await visible(), /Effect: not_attempted/)
  assert.equal(
    await evaluate(
      'return [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Approve once")'
    ),
    false
  )
  flows.push(
    'A fresh call carries a fresh host approval identity; keyboard rejection stays deny-default and cancelled host error preserves not-attempted evidence without retry'
  )
  await evaluate(
    "window.__fixture.setCall({ id: 'host-' + 'a'.repeat(1000), status: 'error', error: 'Unknown offline outcome', mcp: { ...window.__fixture.snapshot().sessions[0].messages[2].toolCalls[0].mcp, outcome: 'unknown', requestSent: true, checkpointUnconfirmed: true } }, 'interrupted')"
  )
  await wait(
    'document.querySelector(\'details[aria-label^="Tool call:"]\')?.getAttribute("aria-label").includes("offline_tool")'
  )
  await expand()
  await wait("document.body.innerText.includes('Tool presentation is invalid')")
  assert.match(await visible(), /Status: unknown/)
  assert.match(await visible(), /Effect: unknown/)
  assert.match(await visible(), /Do not retry automatically/)
  assert.match(await visible(), /checkpointing is unconfirmed/)
  assert.ok((await visible()).includes('host-' + 'a'.repeat(1000)))
  assert.ok((await visible()).includes('offline-digest'))
  assert.equal(await count('agent:approve'), 3)
  flows.push(
    'A legitimate host call ID beyond shared identity bounds leaves exact host provenance and unknown/checkpoint safety visible beside the invalid-display notice, without approval or retry'
  )
  await evaluate('window.__fixture.setTemplateCall()')
  await wait("document.body.innerText.includes('Exact resource template:')")
  // Approval requests open automatically with the exact action and deliberate approval controls.
  const templateText = await evaluate(
    'return [...document.querySelectorAll("pre")].find(node => node.textContent.startsWith("Exact resource template:"))?.innerText'
  )
  assert.ok(templateText.includes('fixture:///items/{id}{?q}'))
  assert.ok(templateText.includes('a/b 😀'))
  assert.ok(templateText.includes('x&y'))
  assert.ok(templateText.includes('fixture:///items/a%2Fb%20%F0%9F%98%80?q=x%26y'))
  assert.match(templateText, /Wire method: resources\/read/)
  assert.equal(await count('agent:approve'), 3)
  await click('Approve once')
  assert.deepEqual(
    await evaluate(
      "return window.__fixture.calls.filter(call => call.channel === 'agent:approve').at(-1).args"
    ),
    ['offline-session', 'template-call', true, 'template-approval']
  )
  await evaluate(
    "window.__fixture.setCall({ status: 'rejected', mcp: { ...window.__fixture.snapshot().sessions[0].messages[2].toolCalls[0].mcp, outcome: 'not-sent', requestSent: false } }, 'completed')"
  )
  await wait("document.body.innerText.includes('Status: denied')")
  await wait("document.body.innerText.includes('Status: denied')")
  await route('#other')
  await evaluate('history.back()')
  await wait(
    "document.getElementById('app').dataset.route === '#panel' && !!document.querySelector('details[aria-label^=\"Tool call:\"]')"
  )
  assert.equal(await count('agent:approve'), 4)
  assert.equal(
    await evaluate(
      'return [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Approve once")'
    ),
    false
  )
  flows.push(
    'Exact template, scalar values, expanded URI and resources/read route appear in existing human approval; approval uses the captured identity and denied remount never replays it'
  )
  phase = 'header-only completed tools and run summary dialog'
  await evaluate(
    "window.__fixture.setCall({ id: 'completed-call', name: 'lint_command', targetLabel: '!whatchaos', arguments: { commandName: '!whatchaos' }, status: 'completed', error: undefined, mcp: undefined, result: [{ severity: 'warning', message: 'Example lint warning' }] })"
  )
  await wait(
    'document.querySelector(\'details[aria-label^="Tool call:"]\')?.innerText.includes("lint_command")'
  )
  assert.equal(
    await evaluate('return document.querySelector(\'details[aria-label^="Tool call:"]\').open'),
    false
  )
  const collapsedText = await visible()
  assert.ok(collapsedText.includes('lint_command'))
  assert.equal(collapsedText.includes('Effect:'), false)
  assert.equal(collapsedText.includes('Details collapsed'), false)
  assert.equal(collapsedText.includes('Example lint warning'), false)
  assert.equal(
    await evaluate(
      'return !!document.querySelector("footer [aria-label=\\\"Open run summary\\\"]")'
    ),
    true
  )
  assert.match(collapsedText, /1,540 recorded tokens/)
  assert.match(collapsedText, /0:42 elapsed/)
  assert.match(collapsedText, /Tools: 1 attempted/)
  await screenshot('tool-collapsed')
  await expand()
  assert.match(await visible(), /Effect: unreported/)
  assert.match(await visible(), /Example lint warning/)
  assert.match(await visible(), /commandName/)
  assert.equal(
    await evaluate(
      'return document.querySelectorAll(\'details[aria-label^="Tool call:"] details\').length'
    ),
    0
  )
  await screenshot('tool-expanded')
  await collapse()
  await evaluate(
    'const button = document.querySelector("[aria-label=\\\"Open run summary\\\"]"); button.focus(); button.click()'
  )
  await wait('!!document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]:modal")')
  assert.match(await visible(), /Recorded input tokens/)
  assert.match(await visible(), /Unreported cache counts are unavailable/)
  await screenshot('run-summary-dialog')
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
  await wait('!document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]").open')
  assert.equal(
    await evaluate('return document.activeElement?.getAttribute("aria-label")'),
    'Open run summary'
  )
  await evaluate('document.querySelector("[aria-label=\\\"Open run summary\\\"]").click()')
  await wait('!!document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]:modal")')
  await evaluate('window.__fixture.setMetrics({ totalTokens: 1600 })')
  await wait(
    'document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]").innerText.includes("1,600")'
  )
  assert.equal(
    await evaluate(
      'return document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]").open'
    ),
    true
  )
  await evaluate('document.querySelector("[aria-label=\\\"Close run summary\\\"]").click()')
  await wait('!document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]").open')
  await evaluate('document.querySelector("[aria-label=\\\"Open run summary\\\"]").click()')
  await wait('!!document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]:modal")')
  await evaluate(
    "window.__fixture.setMetrics({ runId: 'next-run', status: 'running', usageReconciled: false, totalTokens: undefined, tools: undefined })"
  )
  await wait('!document.querySelector("dialog[aria-label=\\\"Agent run summary\\\"]").open')
  assert.match(await visible(), /Current run/)
  assert.match(await visible(), /Partial usage/)
  assert.match(await visible(), /Unavailable recorded tokens/)
  assert.match(await visible(), /Tools: Unavailable/)
  flows.push(
    'Completed tools collapse to only their header; one expansion reveals metadata, warnings, arguments and results. The fixed composer summary shows outcome, elapsed time, tokens and tools, and opens a modal that closes with Escape and restores focus.'
  )
  phase = 'agent sessions resizing and persistence'
  const sidebarWidth = () =>
    evaluate('return document.getElementById("agent-sessions").getBoundingClientRect().width')
  const handleLocation = await evaluate(
    'const box = document.querySelector(".sessions-resize-handle").getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }'
  )
  assert.equal(await sidebarWidth(), 208)
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...handleLocation
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    button: 'left',
    buttons: 1,
    x: handleLocation.x + 120,
    y: handleLocation.y
  })
  await wait('document.getElementById("agent-sessions").clientWidth === 328')
  assert.equal(await count('save-settings'), 0)
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    x: handleLocation.x + 120,
    y: handleLocation.y
  })
  await wait(
    'window.__fixture.calls.some(call => call.channel === "save-settings" && call.args[0].agentSessionsWidth === 328)'
  )
  // Keyboard resizing uses the focused separator, including the minimum and maximum shortcuts.
  for (const [key, code, expected] of [
    ['ArrowLeft', 37, 318],
    ['Home', 36, 200],
    ['End', 35, 480]
  ]) {
    await command('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: code })
    await command('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: code })
    await wait(`document.getElementById("agent-sessions").clientWidth === ${expected}`)
  }
  await evaluate(
    'document.querySelector(".sessions-resize-handle").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))'
  )
  await wait('document.getElementById("agent-sessions").clientWidth === 208')
  // Resize again and verify the chosen width survives both panel remount and renderer reload.
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    button: 'left',
    clickCount: 1,
    ...handleLocation
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    button: 'left',
    buttons: 1,
    x: handleLocation.x + 120,
    y: handleLocation.y
  })
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    button: 'left',
    clickCount: 1,
    x: handleLocation.x + 120,
    y: handleLocation.y
  })
  await wait('document.getElementById("agent-sessions").clientWidth === 328')
  await route('#other')
  await route('#panel')
  assert.equal(await sidebarWidth(), 328)
  await evaluate('window.__fixtureReloadMarker = true')
  await command('Page.reload')
  await wait(
    '!window.__fixtureReloadMarker && document.getElementById("agent-sessions")?.clientWidth === 328'
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 640,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await wait('document.getElementById("agent-sessions").clientWidth === 280')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await wait('document.getElementById("agent-sessions").clientWidth === 328')
  flows.push(
    'Agent sessions resize by dragging and keyboard, save on release, reset on double-click, restore after navigation/reload, and adapt to a smaller window without overwriting the preferred width'
  )
  await screenshot('agent-sessions-resized')
  phase = 'direct Auto review activation'
  await evaluate('await window.__fixture.configureAutoReview({ web: true })')
  await click('Auto review')
  await wait('window.__fixture.snapshot().sessions[0].mode === "auto"')
  assert.equal(await count('agent:enroll-auto-review'), 1)
  assert.equal((await visible()).includes('I consent to'), false)
  assert.equal((await visible()).includes('Acknowledge and enable'), false)
  assert.equal((await visible()).includes('Recover Auto review'), false)
  assert.equal(
    await evaluate('return window.__fixture.snapshot().sessions[0].autoReviewEnrollment.web'),
    undefined
  )
  // Web approval stays separately selectable and survives switching back into Auto review.
  await evaluate('document.querySelector("input[type=checkbox]").click()')
  await wait('!!window.__fixture.snapshot().sessions[0].autoReviewEnrollment.web')
  await click('Manual')
  await wait('window.__fixture.snapshot().sessions[0].mode === "manual"')
  await click('Auto review')
  await wait('window.__fixture.snapshot().sessions[0].mode === "auto"')
  assert.equal(
    await evaluate('return document.querySelector("input[type=checkbox]").checked'),
    true
  )
  // A failed change must leave the checkbox consistent with the saved session.
  await evaluate(
    'window.__fixture.failEnrollment(true); document.querySelector("input[type=checkbox]").click()'
  )
  await wait('document.body.innerText.includes("Offline enrollment save failed")')
  assert.equal(
    await evaluate('return document.querySelector("input[type=checkbox]").checked'),
    true
  )
  await evaluate(
    'window.__fixture.failEnrollment(false); document.querySelector("input[type=checkbox]").click()'
  )
  await wait('!window.__fixture.snapshot().sessions[0].autoReviewEnrollment.web')

  await evaluate('await window.__fixture.configureAutoReview({ plan: true })')
  await click('Implement with Auto review')
  await wait('window.__fixture.calls.some(call => call.channel === "agent:resolve-plan")')
  const planCalls = await evaluate(
    'return window.__fixture.calls.filter(call => ["agent:enroll-auto-review", "agent:resolve-plan"].includes(call.channel)).slice(-2)'
  )
  assert.equal(planCalls[0].channel, 'agent:enroll-auto-review')
  assert.equal(planCalls[0].args[1].activate, false)
  assert.deepEqual(planCalls[1].args, ['offline-session', 'auto', 'assistant-2'])

  const enrollmentsBeforeRecovery = await count('agent:enroll-auto-review')
  await evaluate(
    'await window.__fixture.configureAutoReview({ auditRows: [{ id: "unknown-change", tool: "save_memory", targetType: "memory", targetId: "offline-memory", outcome: "unknown", currentResourceRevision: "resource-1", currentTargetRevision: "target-1", candidateRevision: "candidate-1" }] })'
  )
  await click('Auto review')
  await wait('document.body.innerText.includes("Recover Auto review")')
  assert.equal(await count('agent:enroll-auto-review'), enrollmentsBeforeRecovery)
  assert.equal(
    await evaluate(
      'return [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Recover and enable").disabled'
    ),
    true
  )
  await evaluate('document.querySelector("input[type=checkbox]").click()')
  await click('Recover and enable')
  await wait('window.__fixture.snapshot().sessions[0].mode === "auto"')
  assert.equal(
    await evaluate(
      'return window.__fixture.calls.filter(call => call.channel === "agent:enroll-auto-review").at(-1).args[1].recoveryInspectionId'
    ),
    'offline-inspection'
  )
  // Reconciled rows stay in history, but do not require another recovery acknowledgment.
  await click('Manual')
  await wait('window.__fixture.snapshot().sessions[0].mode === "manual"')
  await click('Auto review')
  await wait('window.__fixture.snapshot().sessions[0].mode === "auto"')
  assert.equal((await visible()).includes('Recover Auto review'), false)
  assert.equal(
    await evaluate(
      'return window.__fixture.calls.filter(call => call.channel === "agent:enroll-auto-review").at(-1).args[1].recoveryInspectionId'
    ),
    undefined
  )

  const enrollmentsBeforeFailure = await count('agent:enroll-auto-review')
  await evaluate('await window.__fixture.configureAutoReview({ noReviewer: true })')
  await click('Auto review')
  await wait('document.body.innerText.includes("Choose OpenAI or OpenRouter")')
  assert.equal(await count('agent:enroll-auto-review'), enrollmentsBeforeFailure)
  assert.equal(await evaluate('return window.__fixture.snapshot().sessions[0].mode'), 'manual')
  flows.push(
    'Auto review and plan implementation activate on one click; optional web authority remains separate, failed changes keep saved UI state, unknown audit outcomes require recovery, and missing reviewers keep Manual active'
  )
  phase = 'stable model controls during mode switches'
  await evaluate(
    'await window.__fixture.configureAutoReview({ enrollmentDelay: 600 }); window.__fixture.setCapabilityModel()'
  )
  await wait(
    'document.querySelector("select[aria-label]")?.value === "high" && !document.getElementById("agent-reasoning-error")'
  )
  const capabilitiesBeforeSwitch = await count('get-ai-model-capabilities')
  await evaluate(
    'const input = document.querySelector(".agent-input"); input.value = "Keep this draft"; input.dispatchEvent(new Event("input", { bubbles: true }))'
  )
  const fieldStyles = () =>
    evaluate(
      'const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1; const context = canvas.getContext("2d"); const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data] }; return [...document.querySelectorAll("header .w-56 > button, header select, .agent-input, button[aria-label=Send]")].map(field => { const style = getComputedStyle(field); return { disabled: field.disabled, color: rgba(style.color), background: rgba(style.backgroundColor), opacity: style.opacity, border: rgba(style.borderColor) } })'
    )
  await evaluate('await new Promise(done => setTimeout(done, 250))')
  const beforeSwitchStyles = await fieldStyles()
  await evaluate(
    'window.__capabilityGlitches = []; window.__capabilityObserver = new MutationObserver(() => { if (document.querySelector("select[aria-label]")?.value !== "high" || document.getElementById("agent-reasoning-error")) window.__capabilityGlitches.push("Reasoning controls reset") }); window.__capabilityObserver.observe(document.querySelector("section > header"), { childList: true, subtree: true, attributes: true })'
  )
  await click('Auto review')
  await wait('window.__fixture.pendingEnrollment()')
  assert.deepEqual(await fieldStyles(), beforeSwitchStyles)
  const enrollmentsWhilePending = await count('agent:enroll-auto-review')
  await click('Auto review')
  await click('arrow_upward')
  await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 10 })
  assert.equal(await count('agent:enroll-auto-review'), enrollmentsWhilePending)
  assert.equal(await count('agent:send'), 0)
  await wait(
    'window.__fixture.snapshot().sessions[0].mode === "auto" && !document.querySelector("section > header").inert'
  )
  await evaluate('await new Promise(done => setTimeout(done, 250))')
  assert.deepEqual(await fieldStyles(), beforeSwitchStyles)
  assert.equal(
    await evaluate('return document.querySelector(".agent-input").value'),
    'Keep this draft'
  )
  assert.equal(await count('get-ai-model-capabilities'), capabilitiesBeforeSwitch)
  assert.deepEqual(await evaluate('return window.__capabilityGlitches'), [])
  await evaluate(
    'window.__capabilityObserver.disconnect(); window.__fixture.setCapabilityModel("gpt-5")'
  )
  await wait(
    'document.querySelector("select[aria-label]")?.value === "high" && !document.getElementById("agent-reasoning-error")'
  )
  assert.equal(await count('get-ai-model-capabilities'), capabilitiesBeforeSwitch + 1)
  flows.push(
    'A delayed Auto switch keeps field colors and enabled appearance stable, preserves the draft, prevents duplicate enrollment and sending during the switch, and avoids capability refetches; selecting a different model still refreshes capabilities'
  )
  assert.deepEqual(browserErrors, [])
  const report = {
    passed: true,
    engine: await send('Browser.getVersion'),
    flows,
    calls: await evaluate('return window.__fixture.calls'),
    browserErrors,
    limitations: [
      'Actual Svelte AgentPanel/shared component with fake IPC in headless Chromium; no Electron main or live effects',
      'Physical GUI, macOS and live provider/bot/external-server acceptance remain separate'
    ]
  }
  if (process.env.PRESENTATION_UI_REPORT) {
    await mkdir(dirname(resolve(process.env.PRESENTATION_UI_REPORT)), { recursive: true })
    await writeFile(
      resolve(process.env.PRESENTATION_UI_REPORT),
      JSON.stringify(report, null, 2) + '\n'
    )
  }
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  primaryError = error
  console.error(JSON.stringify({ phase, completedFlows: flows, browserErrors }))
  if (evaluate) {
    try {
      console.error(await evaluate('return document.body.innerText'))
    } catch {
      /* The primary failure remains authoritative if the browser is unavailable. */
    }
  }
  throw new Error('Presentation UI phase ' + phase + ': ' + (error.stack || error))
} finally {
  socket?.close()
  if (chromium && chromium.exitCode === null && chromium.signalCode === null) {
    await new Promise((done) => {
      const timeout = setTimeout(() => {
        chromium.kill('SIGKILL')
        done()
      }, 3000)
      chromium.once('exit', () => {
        clearTimeout(timeout)
        done()
      })
      chromium.kill('SIGTERM')
    })
  }
  await vite?.close()
  try {
    await rm(fixtureDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    if (!primaryError) throw error
    console.error('Browser profile cleanup also failed:', error)
  }
}
