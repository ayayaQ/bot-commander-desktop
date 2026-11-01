/** Hosted headless CLI runner. Connects to a caller-supplied disposable browser only.
 * This script never launches a browser or discovers profiles/executables.
 * Build/serve the fake fixture, then run in the approved hosted environment:
 * node scripts/test-settings-credentials-ui.mjs --fixture-url https://HOST/fixture/ --browser-ws wss://HOST/devtools/browser/ID
 * --check validates fixture JavaScript without opening any connection.
 */
import { readFile } from 'node:fs/promises'
import { parse } from 'acorn'

const expression = 'await window.__settingsCredentialFixture.run()'
new Function(`return (async () => (${expression}))()`)
if (process.argv.includes('--check')) {
  parse(await readFile(new URL('./fixtures/settings-credentials.js', import.meta.url), 'utf8'), {
    ecmaVersion: 'latest',
    sourceType: 'module'
  })
  console.log(JSON.stringify({ syntaxValidated: true, browserExecuted: false }))
  process.exit(0)
}
function argument(name) {
  const index = process.argv.indexOf(name)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`)
  return process.argv[index + 1]
}
const fixture = new URL(argument('--fixture-url'))
const browser = new URL(argument('--browser-ws'))
if (!['http:', 'https:'].includes(fixture.protocol) || !['ws:', 'wss:'].includes(browser.protocol))
  throw new Error('Expected hosted fixture HTTP(S) URL and supplied browser WS(S) URL')
const socket = new WebSocket(browser)
let serial = 0
const pending = new Map()
const runtimeErrors = []
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(String(data))
  if (message.method === 'Runtime.exceptionThrown')
    runtimeErrors.push(
      message.params.exceptionDetails.exception?.description || 'Uncaught fixture exception'
    )
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error')
    runtimeErrors.push('Fixture emitted console.error')
  const item = pending.get(message.id)
  if (!item) return
  pending.delete(message.id)
  clearTimeout(item.timer)
  if (message.error) item.reject(new Error(message.error.message))
  else item.resolve(message.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener(
    'error',
    () => reject(new Error('Could not connect to supplied hosted browser')),
    { once: true }
  )
})
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Hosted command timed out: ${method}`))
    }, 30000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
let targetId
try {
  ;({ targetId } = await command('Target.createTarget', { url: fixture.href }))
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true })
  await command('Runtime.enable', {}, sessionId)
  const ready = await command(
    'Runtime.evaluate',
    {
      expression: `(async () => { const until = Date.now() + 15000; while (!window.__settingsCredentialFixture?.ready) { if (Date.now() > until) throw new Error('Hosted Settings fixture not ready'); await new Promise(done => setTimeout(done, 25)) } return true })()`,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  )
  if (ready.exceptionDetails) throw new Error('Hosted Settings fixture failed to initialize')
  const result = await command(
    'Runtime.evaluate',
    {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  )
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description || 'Hosted Settings UI flow failed'
    )
  if (!result.result?.value?.passed) throw new Error('Hosted UI flow did not confirm success')
  if (runtimeErrors.length) throw new Error(runtimeErrors.join('\n'))
  console.log(JSON.stringify({ ...result.result.value, runtimeErrors: 0 }, null, 2))
} finally {
  if (targetId) await command('Target.closeTarget', { targetId }).catch(() => {})
  for (const item of pending.values()) clearTimeout(item.timer)
  socket.close()
}
