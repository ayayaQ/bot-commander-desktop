// Verification tooling only, run by the ORIGINAL Electron binary in ASAR-aware Node mode.
// Never require the application's main entry or launch the packaged executable.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const rawFs = require('original-fs')
const path = require('node:path')
const { createRequire, Module, syncBuiltinESMExports } = require('node:module')
const { pathToFileURL } = require('node:url')
const { Worker } = require('node:worker_threads')
const vm = require('node:vm')

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const inside = (root, file) => file.startsWith(root + path.sep)

async function main() {
  assert.ok(process.versions.electron, 'Use original Electron in Node mode')
  const [resources, checkout] = process.argv.slice(2)
  assert.ok(resources && checkout)
  const root = path.join(resources, 'app.asar')
  const app = readJson(path.join(root, 'package.json'))
  const lock = readJson(path.join(checkout, 'package-lock.json'))
  assert.equal(process.versions.electron, lock.packages['node_modules/electron'].version)
  const entry = path.join(root, app.main)
  assert.ok(inside(root, entry))
  const packedRequire = createRequire(entry)

  // Fixture-local tripwires. No live fetch, socket or DNS call is allowed by this probe.
  let networkAttempts = 0
  const deny = () => {
    networkAttempts++
    throw new Error('Offline package fixture attempted network access')
  }
  for (const [name, methods] of [
    ['node:http', ['request', 'get']],
    ['node:https', ['request', 'get']],
    ['node:net', ['connect', 'createConnection']],
    ['node:tls', ['connect']],
    ['node:dns', ['lookup', 'resolve']],
    ['node:dgram', ['createSocket']]
  ]) {
    const module = require(name)
    for (const method of methods) module[method] = deny
  }
  globalThis.fetch = deny
  globalThis.WebSocket = deny
  syncBuiltinESMExports()

  const baseline = new Set(Object.keys(require.cache))
  const core = readJson(path.join(root, 'node_modules/@ayayaq/vivi/package.json'))
  assert.equal(core.version, lock.packages['node_modules/@ayayaq/vivi'].version)
  const exports = {}
  for (const key of Object.keys(core.exports)) {
    const spec = key === '.' ? '@ayayaq/vivi' : '@ayayaq/vivi/' + key.slice(2)
    const resolved = packedRequire.resolve(spec)
    assert.ok(inside(root, resolved), `Development fallback: ${resolved}`)
    const commonjs = packedRequire(spec)
    // Use the same archive-relative dynamic-import resolution as compiled main.
    const probe = new Module(entry, null)
    probe.filename = entry
    probe.paths = Module._nodeModulePaths(path.dirname(entry))
    probe._compile(`module.exports = import(${JSON.stringify(spec)})`, entry)
    const esm = await probe.exports
    assert.ok(Object.keys(commonjs).length > 0, `Empty CJS export: ${spec}`)
    assert.ok(Object.keys(esm).length > 0, `Empty ESM export: ${spec}`)
    exports[spec] = {
      resolved,
      commonjs: Object.keys(commonjs).length,
      esm: Object.keys(esm).length
    }
  }
  const resolutions = {}
  for (const spec of [
    '@modelcontextprotocol/client',
    '@modelcontextprotocol/client/validators/ajv',
    'url-template',
    'discord.js',
    'quickjs-emscripten'
  ]) {
    resolutions[spec] = packedRequire.resolve(spec)
    assert.ok(inside(root, resolutions[spec]), `Development fallback: ${spec}`)
    packedRequire(spec)
  }
  for (const spec of ['vitest', 'typescript', 'electron-builder']) {
    assert.throws(() => packedRequire.resolve(spec), { code: 'MODULE_NOT_FOUND' })
  }

  let fakeCalls = 0
  const provider = packedRequire('@ayayaq/vivi/providers/openrouter').createOpenRouterProvider({
    apiKey: 'synthetic-offline-key',
    model: 'synthetic/offline-model',
    fetch: async (_url, init) => {
      fakeCalls++
      const request = JSON.parse(init.body)
      assert.equal(request.messages[0].content, 'Offline native package request')
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'Offline native package reply' }
            }
          ]
        })
      )
    }
  })
  const response = await provider.generate(
    {
      messages: [{ kind: 'message', role: 'user', content: 'Offline native package request' }],
      tools: []
    },
    new AbortController().signal
  )
  assert.equal(response.content, 'Offline native package reply')
  assert.equal(fakeCalls, 1)

  const artifacts = {}
  function compare(folder, prefix) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const local = path.join(folder, item.name)
      const relative = path.join(prefix, item.name)
      if (item.isDirectory()) compare(local, relative)
      else if (item.isFile()) {
        const bytes = fs.readFileSync(path.join(root, relative))
        assert.ok(bytes.equals(fs.readFileSync(local)), `Packaged bytes differ: ${relative}`)
        artifacts[relative.split(path.sep).join('/')] = hash(bytes)
      }
    }
  }
  compare(path.join(checkout, 'out'), 'out')
  compare(path.join(checkout, 'resources'), 'resources')
  assert.ok(artifacts['out/main/index.js'])
  assert.ok(artifacts['out/preload/index.js'])
  assert.ok(artifacts['out/renderer/index.html'])

  const workerRelative = 'out/main/agentValidationWorker.mjs'
  const mainSource = fs.readFileSync(entry, 'utf8')
  const resolver = mainSource.match(
    /function agentValidationWorkerEntry\(directory = __dirname\) \{[\s\S]*?\n\}/
  )?.[0]
  assert.ok(resolver, 'Built main has no supported packaged worker resolver')
  // Execute only the emitted pure resolver, never the application startup entry.
  const workerUrl = vm.runInNewContext(
    resolver + '\nagentValidationWorkerEntry()',
    {
      __dirname: path.dirname(entry),
      node_url: { pathToFileURL },
      node_path: path,
      AGENT_VALIDATION_WORKER_FILENAME: 'agentValidationWorker.mjs'
    },
    { timeout: 1000 }
  )
  const worker = require('node:url').fileURLToPath(workerUrl)
  assert.equal(worker, path.join(resources, 'app.asar.unpacked', workerRelative))
  assert.ok(rawFs.existsSync(worker), 'Worker must be physically unpacked')
  const workerBytes = rawFs.readFileSync(worker)
  assert.equal(hash(workerBytes), artifacts[workerRelative])
  const wasm = [
    ...new Set(workerBytes.toString().match(/data:application\/wasm;base64,[A-Za-z0-9+/=]+/g))
  ]
  assert.equal(wasm.length, 1, 'Expected one bundled inline WASM')
  const wasmBytes = Buffer.from(wasm[0].split(',')[1], 'base64')
  assert.equal(wasmBytes.subarray(0, 8).toString('hex'), '0061736d01000000')
  assert.ok(WebAssembly.validate(wasmBytes), 'Invalid bundled WASM')
  const request = readJson(path.join(__dirname, 'native-package-worker.json'))
  const workerReceipt = await new Promise((resolve, reject) => {
    const instance = new Worker(pathToFileURL(worker), {
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 64,
        maxYoungGenerationSizeMb: 8,
        codeRangeSizeMb: 4,
        stackSizeMb: 4
      },
      workerData: { requestId: 'native-package-offline', request }
    })
    let message
    const timeout = setTimeout(() => {
      void instance.terminate().finally(() => reject(new Error('Packaged worker timed out')))
    }, 20_000)
    instance.on('message', (value) => {
      message = value
    })
    instance.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    instance.on('exit', (exitCode) => {
      clearTimeout(timeout)
      try {
        assert.equal(exitCode, 0, 'Worker did not shut down cleanly')
        assert.equal(message?.requestId, 'native-package-offline')
        assert.equal(message?.report?.outcome, 'passed', JSON.stringify(message?.report))
        assert.equal(message.report.coverage.executed, 1)
        assert.equal(message.report.cases[0].steps[0].effects.messages[0].content, '42:offline')
        resolve({ exitCode, outcome: message.report.outcome, coverage: message.report.coverage })
      } catch (error) {
        reject(error)
      }
    })
  })

  const nativeAddons = []
  function scan(folder) {
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, item.name)
      if (item.isDirectory()) scan(file)
      else if (item.name.endsWith('.node')) nativeAddons.push(path.relative(root, file))
    }
  }
  scan(path.join(root, 'node_modules'))
  assert.equal(
    nativeAddons.length,
    0,
    `Native addons require an explicitly assigned load fixture: ${nativeAddons.join(', ')}`
  )
  const loaded = Object.keys(require.cache).filter((file) => !baseline.has(file))
  assert.ok(loaded.length > 0)
  assert.ok(
    loaded.every((file) => inside(root, file)),
    'Runtime module resolved outside packaged application'
  )
  assert.equal(networkAttempts, 0)
  console.log(
    JSON.stringify({
      status: 'passed',
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      coreVersion: core.version,
      coreExports: exports,
      coreExportCount: Object.keys(exports).length,
      resolutions,
      loadedPackagedModules: loaded.length,
      fakeProviderCalls: fakeCalls,
      networkAttempts,
      artifacts,
      worker: {
        path: worker,
        resolver: 'packaged-main-helper',
        sha256: hash(workerBytes),
        ...workerReceipt
      },
      inlineWasm: { bytes: wasmBytes.length, sha256: hash(wasmBytes), validated: true },
      nativeAddons: { status: 'none-present', files: nativeAddons },
      mainExecuted: false,
      packagedExecutableLaunched: false
    })
  )
}

main().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
