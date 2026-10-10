import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire, Module } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

// Use the original Electron binary's ASAR-aware Node mode, never launch the app:
// ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron \
//   scripts/verify-agent-mcp-package.mjs /tmp/mcp-package/linux-unpacked/resources/app.asar
// Keep the package outside the checkout so parent development modules cannot resolve.
assert.ok(process.versions.electron, 'Run this probe with ELECTRON_RUN_AS_NODE=1 and Electron')
assert.ok(process.argv[2], 'Supply the packaged resources/app.asar path')
const root = path.resolve(process.argv[2])
const checkout = fileURLToPath(new URL('../', import.meta.url))
const lock = JSON.parse(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8'))
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const semver = createRequire(import.meta.url)('semver') // Verification tooling, not app resolution
const rawFs = createRequire(import.meta.url)('original-fs') // Read the archive's raw bytes
assert.equal(process.versions.electron, lock.packages['node_modules/electron'].version)

const packages = new Map()
function collect(modules) {
  if (!fs.existsSync(modules)) return
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const folder = path.join(modules, entry.name)
    if (entry.name.startsWith('@')) collect(folder)
    else {
      const manifest = path.join(folder, 'package.json')
      if (!fs.existsSync(manifest)) continue
      packages.set(path.relative(root, folder), readJson(manifest))
      collect(path.join(folder, 'node_modules'))
    }
  }
}
collect(path.join(root, 'node_modules'))
const app = readJson(path.join(root, 'package.json'))
const reachable = new Set()
let edges = 0
function walk(folder, manifest) {
  for (const [name, range] of Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies
  })) {
    const target = Module._nodeModulePaths(path.join(root, folder))
      .map((modules) => path.relative(root, path.join(modules, name)))
      .find((candidate) => packages.has(candidate))
    if (!target && name in (manifest.optionalDependencies || {})) continue
    assert.ok(target, `Missing production dependency ${name} from ${folder || '(app)'}`)
    const child = packages.get(target)
    assert.ok(semver.satisfies(child.version, range), `${name}@${child.version} violates ${range}`)
    edges++
    if (!reachable.has(target)) {
      reachable.add(target)
      walk(target, child)
    }
  }
}
walk('', app)
assert.equal(reachable.size, packages.size, 'Archive contains unreachable production packages')
for (const manifest of packages.values()) {
  assert.ok(
    Object.entries(lock.packages).some(
      ([folder, item]) =>
        folder.split('node_modules/').pop() === manifest.name &&
        item.version === manifest.version &&
        item.dev !== true
    ),
    `${manifest.name}@${manifest.version} has no production lockfile identity`
  )
}

const mainPath = path.join(root, app.main)
const mainBytes = fs.readFileSync(mainPath)
assert.ok(mainBytes.equals(fs.readFileSync(path.join(checkout, app.main))))
const main = mainBytes.toString()
assert.doesNotThrow(() => new vm.Script(main, { filename: mainPath }))
const emitted = main.match(/const requireSdk = [\s\S]*?(?=\nconst kinds = )/)?.[0]
assert.ok(emitted, 'Built main has no captured-schema validator fragment')
assert.match(emitted, /node_module\.createRequire\(typeof __filename/)
const moduleAtMain = (code) => {
  const probe = new Module(mainPath, null)
  probe.filename = mainPath
  probe.paths = Module._nodeModulePaths(path.dirname(mainPath))
  probe._compile(code, mainPath)
  return probe.exports
}
// Execute only the emitted resolver and schema wrapper, not the main application.
const { requireSdk, validateAgentMcpSchema } = moduleAtMain(
  "const node_module = require('node:module');\n" +
    emitted +
    '\nmodule.exports = {requireSdk, validateAgentMcpSchema}'
)
const baseline = new Set(Object.keys(createRequire(import.meta.url).cache))
const resolutions = {}
for (const spec of [
  '@ayayaq/vivi',
  '@ayayaq/vivi/extensions',
  '@ayayaq/vivi/extensions/calculator',
  '@ayayaq/vivi/extensions/mcp',
  '@ayayaq/vivi/events',
  '@ayayaq/vivi/events/stream',
  '@modelcontextprotocol/client',
  '@modelcontextprotocol/client/validators/ajv'
]) {
  resolutions[spec] = requireSdk.resolve(spec)
  assert.ok(resolutions[spec].startsWith(path.join(root, 'node_modules') + path.sep))
}
const versions = {}
for (const name of ['@ayayaq/vivi', '@modelcontextprotocol/client']) {
  versions[name] = readJson(path.join(root, 'node_modules', name, 'package.json')).version
  assert.equal(versions[name], lock.packages[''].dependencies[name])
  assert.equal(app.dependencies[name], versions[name])
}
assert.equal(typeof requireSdk('@ayayaq/vivi/extensions/mcp').createMcpExtension, 'function')
// Installed production-only data replay, without launching Electron main or a provider/tool.
const records = requireSdk('@ayayaq/vivi/events')
const stream = requireSdk('@ayayaq/vivi/events/stream')
assert.match(main, /require\("@ayayaq\/vivi\/events"\)/)
assert.match(main, /require\("@ayayaq\/vivi\/events\/stream"\)/)
assert.match(main, /onAccepted:/)
const source = { reference: 'desktop/package/offline', revision: '1' }
const anchor = records.decodeAgentRecord({
  version: 1,
  sessionId: 'package-session',
  eventId: 'package-anchor',
  sequence: 1,
  previousEventId: null,
  source,
  type: 'session_snapshot',
  reason: 'legacy_import',
  snapshot: {
    history: [],
    outcomes: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  }
})
const base = records.projectAgentRecords('package-session', [anchor])
const input = {
  id: 'original-user-id',
  source,
  message: { kind: 'message', role: 'user', content: 'Offline package' }
}
const assistant = { kind: 'assistant', content: 'Settled offline', toolCalls: [] }
const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 17 }
const envelope = (sequence, previousEventId) => ({
  version: 1,
  scope: 'run',
  sessionId: 'package-session',
  runId: 'package-run',
  eventId: `package-run-${sequence}`,
  sequence,
  previousEventId,
  source
})
const started = stream.createAgentRunStart(envelope(1, null), base, [input])
const accepted = stream.createAgentAcceptedRecord({
  envelope: envelope(2, started.eventId),
  historyId: 'original-assistant-id',
  source,
  update: { type: 'assistant_accepted', message: assistant, round: 1, usage, aggregateUsage: usage }
})
const terminal = records.createRunSettlement({
  envelope: {
    version: 1,
    sessionId: 'package-session',
    eventId: 'package-terminal',
    sequence: 2,
    previousEventId: anchor.eventId,
    source
  },
  runId: 'package-run',
  inputHistoryLength: 1,
  result: {
    status: 'completed',
    content: assistant.content,
    rounds: 1,
    usage,
    history: [input.message, assistant]
  },
  history: [input, accepted.entry],
  outcomes: [],
  sessionUsage: usage
})
const settled = stream.createAgentRunTerminal(envelope(3, accepted.eventId), terminal)
const chain = [started, accepted, settled]
let incremental = stream.createAgentRunProjection(base, 'package-run')
for (const record of chain) incremental = stream.applyAgentRunRecord(incremental, record)
assert.deepEqual(stream.projectAgentRunRecords(base, 'package-run', chain), incremental)
assert.deepEqual(
  records.projectAgentRecords('package-session', [anchor, terminal]),
  incremental.session
)
assert.equal(stream.applyAgentRunRecord(incremental, started), incremental)
assert.equal(incremental.session.usage.totalTokens, 17)
assert.equal(incremental.session.usage.inputTokens + incremental.session.usage.outputTokens, 5)
const { createExtensionScope } = requireSdk('@ayayaq/vivi/extensions')
assert.equal(typeof createExtensionScope, 'function')
assert.match(main, /extensions\.createExtensionScope\(/)
const owner = createExtensionScope({ reservedNames: ['disabled_host_tool'] })
const cleanups = []
owner.defer(async () => {
  await Promise.resolve()
  cleanups.push('drained')
})
owner.register(requireSdk('@ayayaq/vivi/extensions/calculator').calculatorExtension)
const ownedSnapshot = owner.snapshot()
assert.deepEqual(
  await ownedSnapshot.executeTool(
    { id: 'offline-package-calculation', name: 'calculate', arguments: { expression: '2 + 3' } },
    { signal: new AbortController().signal }
  ),
  { content: '{"result":5}' }
)
const disposed = owner.dispose()
assert.equal(disposed, owner.dispose())
assert.equal(owner.signal.aborted, true)
await disposed
assert.deepEqual(cleanups, ['drained'])
assert.equal(owner.state, 'closed')
assert.equal(ownedSnapshot.has('calculate'), true)
await assert.rejects(
  ownedSnapshot.executeTool(
    { id: 'closed-package-calculation', name: 'calculate', arguments: { expression: '1' } },
    { signal: new AbortController().signal }
  )
)
assert.equal(typeof requireSdk('@modelcontextprotocol/client').Client, 'function')
const original = {
  type: 'object',
  properties: { command: { const: 'inspect' }, count: { type: 'integer', minimum: 1, maximum: 3 } },
  required: ['command', 'count'],
  additionalProperties: false
}
const captured = structuredClone(original)
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
}
freeze(captured)
const validate = validateAgentMcpSchema(captured)
original.properties.command.const = 'changed'
assert.doesNotThrow(() => validate({ command: 'inspect', count: 2 }))
for (const invalid of [
  { command: 'inspect' },
  { command: 'changed', count: 2 },
  { command: 'inspect', count: '2' },
  { command: 'inspect', count: 4 },
  { command: 'inspect', count: 2, extra: true }
])
  assert.throws(() => validate(invalid), /MCP arguments do not match the captured schema/)
const loaded = Object.keys(requireSdk.cache).filter((file) => !baseline.has(file))
assert.ok(loaded.length > 0)
assert.ok(
  loaded.every((file) => file.startsWith(root + path.sep)),
  'Runtime used outside packages'
)
for (const spec of ['vitest', 'typescript', 'electron-builder', 'ajv', 'ajv-formats']) {
  assert.throws(() => requireSdk.resolve(spec), { code: 'MODULE_NOT_FOUND' })
}
// Verify the same bare dynamic import used by the compiled client factory, without connecting.
assert.equal(
  typeof (await moduleAtMain("module.exports = import('@modelcontextprotocol/client')")).Client,
  'function'
)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
console.log(
  JSON.stringify({
    result: 'passed',
    electron: process.versions.electron,
    node: process.versions.node,
    mainPath,
    versions,
    productionPackages: reachable.size,
    dependencyEdges: edges,
    resolutions,
    loadedProductionModules: loaded.length,
    schemaChecks: { valid: 1, invalid: 5, capturedSchemaMutation: 'rejected' },
    ownedExtensionScope: 'passed',
    conversationRecordReplay: 'passed',
    bareSdkDynamicImport: 'passed',
    mainSha256: sha256(mainBytes),
    asarSha256: sha256(rawFs.readFileSync(root))
  })
)
