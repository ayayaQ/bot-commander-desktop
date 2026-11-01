import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  executableArchitecture,
  externalPath,
  fileHash,
  inventory,
  isWithin,
  isolatedEnvironment,
  nativeTarget,
  options,
  runBounded,
  writeReport
} from './native-package-support.mjs'

const checkout = fileURLToPath(new URL('../', import.meta.url))
const input = options(
  process.argv.slice(2),
  ['artifact', 'report', 'portable-only'],
  ['portable-only']
)
assert.ok(
  input.artifact && input.report,
  'Usage: node scripts/verify-native-package.mjs --artifact <win-unpacked or .app> --report <external JSON> [--portable-only]'
)
const artifact = externalPath(checkout, input.artifact)
const reportFile = externalPath(checkout, input.report)
assert.ok(!isWithin(artifact, reportFile), 'Report must be outside the artifact')
const target = nativeTarget()
const resources = path.join(
  artifact,
  target.platform === 'darwin' ? 'Contents/Resources' : 'resources'
)
const executable = path.join(
  artifact,
  target.platform === 'darwin'
    ? 'Contents/MacOS/Bot Commander for Discord'
    : 'Bot Commander for Discord.exe'
)
const electron = path.join(
  checkout,
  'node_modules/electron/dist',
  target.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
)
fs.mkdirSync(path.dirname(reportFile), { recursive: true })
const scratch = fs.mkdtempSync(path.join(path.dirname(reportFile), 'a7-offline-probe-'))
const started = Date.now()
const report = {
  schemaVersion: 1,
  scope: input['portable-only'] ? 'portable-artifact-only' : 'synthetic-native-lifecycle',
  status: 'failed',
  host: { ...target, node: process.versions.node },
  artifact,
  stages: {
    portable: { status: 'not_run' },
    packagedStartup: {
      status: 'not_run',
      scope: 'synthetic-offline-bootstrap',
      reason: 'Not selected in portable-only mode'
    },
    normalStartup: {
      status: 'not_run',
      reason: 'Synthetic bootstrap does not validate normal persistence, provider setup or UI'
    },
    manualVisual: { status: 'not_run', reason: 'Requires a separate human receipt' },
    hostedCI: { status: 'not_run' }
  }
}
try {
  report.executable = {
    path: executable,
    arch: executableArchitecture(executable, target.platform)
  }
  const require = createRequire(import.meta.url)
  const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses')
  const configuredFuses = require('js-yaml').load(
    fs.readFileSync(path.join(checkout, 'electron-builder.yml'), 'utf8')
  ).electronFuses
  const fuseNames = {
    runAsNode: FuseV1Options.RunAsNode,
    enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
    enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
    enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
    loadBrowserProcessSpecificV8Snapshot: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot
  }
  // Read only: never flip fuses or alter an executable to make a probe possible.
  const wire = await getCurrentFuseWire(executable)
  report.executable.fuses = {}
  for (const [name, enabled] of Object.entries(configuredFuses)) {
    assert.ok(name in fuseNames, `Unrecognized configured fuse: ${name}`)
    assert.equal(wire[fuseNames[name]], enabled ? 49 : 48, `Packaged fuse differs: ${name}`)
    report.executable.fuses[name] = enabled
  }
  const before = inventory(artifact)
  report.artifactTree = before
  report.source = {
    inputs: inventory(path.join(checkout, 'src')),
    outputs: inventory(path.join(checkout, 'out')),
    resources: inventory(path.join(checkout, 'resources'))
  }
  const child = runBounded(
    electron,
    [path.join(checkout, 'scripts/fixtures/native-package-probe.cjs'), resources, checkout],
    {
      cwd: scratch,
      env: { ...isolatedEnvironment(scratch), ELECTRON_RUN_AS_NODE: '1' },
      timeout: 60_000
    }
  )
  report.probeProcess = child
  assert.equal(child.error, null, `Probe process error: ${child.error}`)
  assert.equal(child.exitCode, 0, `Offline artifact probe failed: ${child.stderr}`)
  const receipt = JSON.parse(child.stdout.trim())
  assert.equal(receipt.status, 'passed')
  assert.equal(receipt.arch, target.arch)
  assert.equal(receipt.platform, target.platform)
  assert.equal(inventory(artifact).sha256, before.sha256, 'Probe changed the artifact')
  report.stages.portable = { status: 'passed', receipt }
  if (!input['portable-only']) {
    const runRoot = fs.mkdtempSync(path.join(path.dirname(reportFile), 'bcfd-native-run-'))
    try {
      const control = {
        version: 1,
        runId: randomUUID(),
        asarSha256: fileHash(path.join(resources, 'app.asar')),
        sourceSha256: report.source.inputs.sha256
      }
      fs.writeFileSync(path.join(runRoot, 'control.json'), JSON.stringify(control))
      fs.writeFileSync(path.join(runRoot, 'owner.json'), JSON.stringify({ runId: control.runId }))
      const args = [`--bcfd-native-probe=${path.join(runRoot, 'control.json')}`]
      const native = runBounded(executable, args, {
        cwd: runRoot,
        env: isolatedEnvironment(scratch),
        timeout: 30_000
      })
      report.nativeProcess = { command: [executable, ...args], ...native }
      assert.equal(native.error, null, `Native process error: ${native.error}`)
      assert.equal(native.exitCode, 0, `Native process failed: ${native.stderr}`)
      const ready = JSON.parse(fs.readFileSync(path.join(runRoot, 'ready.json'), 'utf8'))
      const quit = JSON.parse(fs.readFileSync(path.join(runRoot, 'quit.json'), 'utf8'))
      for (const value of [ready, quit]) {
        for (const [key, expected] of Object.entries(control))
          assert.equal(value[key], expected, `Native receipt identity mismatch: ${key}`)
        assert.equal(value.status, 'passed')
        assert.equal(value.platform, target.platform)
        assert.equal(value.arch, target.arch)
        assert.equal(value.pid, native.pid)
        assert.equal(value.normalStartupLoaded, false)
        assert.equal(value.windowsCreated, 0)
        assert.equal(value.userData, path.join(runRoot, 'userData'))
      }
      assert.equal(ready.fakeProviderCalls, 1)
      assert.equal(quit.exitCode, 0)
      assert.equal(quit.beforeQuit, true)
      assert.equal(quit.willQuit, true)
      assert.equal(inventory(artifact).sha256, before.sha256, 'Native probe changed the artifact')
      report.stages.packagedStartup = {
        status: 'passed',
        scope: 'synthetic-offline-bootstrap',
        ready,
        quit
      }
    } catch (error) {
      report.stages.packagedStartup = {
        status: 'failed',
        scope: 'synthetic-offline-bootstrap',
        error: error.message
      }
      throw error
    } finally {
      fs.rmSync(runRoot, { recursive: true, force: true })
      report.nativeScratchCleanup = !fs.existsSync(runRoot)
    }
  }
  report.status = 'passed'
} catch (error) {
  if (report.stages.portable.status !== 'passed')
    report.stages.portable = { status: 'failed', error: error.message }
  report.error = error.message
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
  report.scratchCleanup = !fs.existsSync(scratch)
  report.durationMs = Date.now() - started
  writeReport(reportFile, report)
}
process.exitCode = report.status === 'passed' ? 0 : 1
