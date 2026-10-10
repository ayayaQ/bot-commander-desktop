/** Offline real Svelte agent entries and shared corpus, using fake IPC in headless Chromium.
 * Run: node scripts/test-agent-presentation-ui.mjs
 * Requires installed Chromium. No provider, bot, external server or credentials are used.
 */
import { createServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDir = await mkdtemp(join(root, '.agent-presentation-ui-'))
let vite
let chromium
let socket
const browserErrors = []
const flows = []
let phase = 'fixture preparation'

try {
  await writeFile(
    join(fixtureDir, 'index.html'),
    '<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>Offline shared tool presentation</title></head><body><main id="app" style="height:1000px"></main><script type="module" src="/main.js"></script></body></html>'
  )
  await writeFile(
    join(fixtureDir, 'main.js'),
    `
import { mount, unmount } from 'svelte'
import Panel from '/@fs/${root}/src/renderer/src/components/AgentPanel.svelte'
import Tool from '/@fs/${root}/src/renderer/src/components/AgentToolPresentation.svelte'
import { toolPresentationCorpus, presentationFixture } from '/@fs/${root}/src/renderer/src/utils/fixtures/toolPresentationCorpus.ts'
import { agentSessions, destroyAgentListeners } from '/@fs/${root}/src/renderer/src/stores/agent.ts'
import '/@fs/${root}/src/renderer/app.css'
const clone = (value) => structuredClone(value)
const mcp = { runId: 'offline-run', serverId: 'offline-server', operationDigest: 'offline-digest', catalogKind: 'tools', remoteKey: 'offline-key', outcome: 'pending', requestSent: false, disclosure: 'Exact offline action: change ordinary fixture. Host approval only.' }
const call = { id: 'offline-call', name: 'offline_tool', arguments: { resource: 'fixture', limit: 5 }, status: 'waiting_approval', approvalId: 'offline-approval', createdAt: '2026-10-10T00:00:00.000Z', mcp }
let session = { id: 'offline-session', title: 'Offline agent fixture', model: 'fixture-model', reasoningEffort: 'none', mode: 'manual', status: 'waiting_approval', activeRunId: 'offline-run', messages: [{ id: 'user-1', role: 'user', content: 'User first', timestamp: call.createdAt }, { id: 'assistant-1', role: 'assistant', content: 'Assistant second', timestamp: call.createdAt }, { id: 'tool-1', role: 'tool', content: '', toolCalls: [clone(call)], timestamp: call.createdAt }, { id: 'assistant-2', role: 'assistant', content: 'Assistant last', timestamp: call.createdAt }], createdAt: call.createdAt, updatedAt: call.createdAt, tokenCount: 0, planReady: false }
const listeners = new Map()
const calls = []
const data = () => ({ sessions: [clone(session)], activeSessionId: session.id, modelDefaultsByProvider: {} })
window.electron = { ipcRenderer: {
  on(channel, listener) { const group = listeners.get(channel) || new Set(); group.add(listener); listeners.set(channel, group) },
  removeListener(channel, listener) { listeners.get(channel)?.delete(listener) },
  invoke(channel, ...args) { calls.push({ channel, args: clone(args) });
    if (channel === 'agent:list') return Promise.resolve(data())
    if (channel === 'fetch-ai-models') return Promise.resolve([])
    if (channel === 'get-ai-model-capabilities') return Promise.resolve({})
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
  setCall(patch, runStatus = 'completed') {
    session = { ...session, status: runStatus, messages: session.messages.map(message => message.toolCalls ? { ...message, toolCalls: [{ ...message.toolCalls[0], ...clone(patch) }] } : message) }
    for (const listener of listeners.get('agent:event') || []) listener({ sessionId: session.id, runId: session.activeRunId, type: 'session', session: clone(session) })
  },
  setNewCall() { session = { ...session, status: 'waiting_approval', activeRunId: 'second-run', messages: session.messages.map(message => message.toolCalls ? { ...message, toolCalls: [{ ...clone(call), id: 'second-call', approvalId: 'second-approval', mcp: { ...clone(mcp), runId: 'second-run' } }] } : message) }; agentSessions.set(data()) }
}
let instance
let navigation = Promise.resolve()
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
    server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
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
  const visible = () =>
    evaluate(
      'const node = document.querySelector(\'[aria-label="Shared tool presentation"]\'); return node.innerText'
    )
  const expand = async () => {
    await evaluate(
      'document.querySelector(\'[aria-label="Shared tool presentation"] summary\').focus()'
    )
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
    await wait('document.querySelector(\'[aria-label="Shared tool presentation"] details\').open')
    await wait('!!document.querySelector("[aria-label=\\\"Shared tool presentation\\\"] pre")')
  }
  phase = 'shared semantic corpus'
  await command('Page.navigate', { url: `http://127.0.0.1:${port}/#corpus-0` })
  await wait('!!window.__fixture && !!document.querySelector("details")')
  const corpus = await evaluate('return window.__fixture.corpus')
  for (const [index, fixture] of corpus.entries()) {
    await route('#corpus-' + index)
    let text = await visible()
    assert.ok(text.includes('Status: ' + fixture.status))
    assert.ok(text.includes('Effect: ' + fixture.effect))
    assert.ok(text.includes(fixture.source.reference))
    assert.ok(text.includes(fixture.source.revision))
    assert.equal(await evaluate('return document.querySelector("details").open'), false)
    if (fixture.status === 'approval_required') assert.match(text, /Approval required/)
    if (fixture.status === 'denied') assert.match(text, /request denied/)
    if (fixture.status === 'failed') assert.match(text, /Tool failed/)
    if (fixture.effect === 'unknown') assert.match(text, /Do not retry automatically/)
    if (fixture.progress) assert.ok(text.includes(fixture.progress.text))
    for (const warning of fixture.warnings || []) assert.ok(text.includes(warning))
    await expand()
    text = await visible()
    assert.ok(text.includes('{"limit":5,"resource":"fixture"}'))
    if (fixture.result?.kind === 'future-card') {
      assert.match(text, /unsupported presentation kind/)
      assert.ok(text.includes(fixture.result.text))
      assert.equal(text.includes('Automatically retry this operation'), false)
    }
    await evaluate('document.querySelector("summary").click()')
    await wait('!document.querySelector("details").open')
    assert.ok((await visible()).includes(fixture.source.reference))
  }
  flows.push(
    'All nine common CORE-13 semantic fixtures preserve exact status/effect, source/revision, arguments, result, progress and warnings across keyboard expansion and repeated collapse'
  )
  await route('#long')
  assert.match(await visible(), /unsupported presentation kind/)
  await expand()
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
  await expand()
  assert.equal(await count('agent:approve'), 0)
  // Enter outside the host's deliberate approval button never authorizes a tool.
  await evaluate('document.querySelector("summary").blur(); document.body.focus()')
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
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
    "document.getElementById('app').dataset.route === '#panel' && document.body.innerText.includes('Status: unknown')"
  )
  assert.equal(await count('agent:approve'), 2)
  await evaluate('history.forward()')
  await wait("document.getElementById('app').dataset.route === '#other'")
  await route('#panel')
  await wait("document.body.innerText.includes('Status: unknown')")
  assert.equal(
    await evaluate(
      'return document.querySelector(\'[aria-label="Shared tool presentation"] details\').open'
    ),
    false
  )
  flows.push(
    'Interrupted/unknown host evidence and checkpoint warning survive remount/Back/Forward collapsed; no approval or execution is replayed'
  )
  await evaluate('window.__fixture.setNewCall()')
  await wait('document.body.innerText.includes(\'call "second-call"\')')
  await evaluate(
    "const button = [...document.querySelectorAll('button')].find(node => node.textContent.trim() === 'Reject'); button.focus()"
  )
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
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
  assert.deepEqual(browserErrors, [])
  const report = {
    passed: true,
    engine: await send('Browser.getVersion'),
    flows,
    calls: await evaluate('return window.__fixture.calls'),
    browserErrors,
    limitations: [
      'Actual Svelte AgentPanel/shared component with fake IPC in Linux Chromium; no Electron main or live effects',
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
  throw new Error('Presentation UI phase ' + phase + ': ' + (error.stack || error))
} finally {
  socket?.close()
  chromium?.kill('SIGTERM')
  await vite?.close()
  await rm(fixtureDir, { recursive: true, force: true })
}
