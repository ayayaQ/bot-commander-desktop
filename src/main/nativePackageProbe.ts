import { app } from 'electron'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'

export type NativeProbeControl = {
  version: 1
  runId: string
  asarSha256: string
  sourceSha256: string
}

export type NativeProbeHost = {
  app: Pick<
    Electron.App,
    'isPackaged' | 'setPath' | 'getPath' | 'whenReady' | 'on' | 'once' | 'quit' | 'exit'
  >
  archivePath: string
  readArchive: (file: string) => Buffer
  loadProvider: () => typeof createOpenRouterProvider
  normalStartupLoaded?: () => boolean
  emit?: (receipt: object) => void
}

/** Only a newly allocated, caller-owned synthetic run directory is accepted. */
export function readNativeProbeControl(controlPath: string): {
  root: string
  control: NativeProbeControl
} {
  assert.ok(path.isAbsolute(controlPath), 'Probe control must be absolute')
  assert.equal(path.basename(controlPath), 'control.json')
  const root = fs.realpathSync(path.dirname(controlPath))
  assert.ok(
    path.basename(root).startsWith('bcfd-native-run-'),
    'Expected owned probe run directory'
  )
  const control = JSON.parse(
    fs.readFileSync(path.join(root, 'control.json'), 'utf8')
  ) as NativeProbeControl
  assert.equal(control.version, 1)
  assert.match(control.runId, /^[a-f0-9-]{36}$/)
  assert.match(control.asarSha256, /^[a-f0-9]{64}$/)
  assert.match(control.sourceSha256, /^[a-f0-9]{64}$/)
  const owner = JSON.parse(fs.readFileSync(path.join(root, 'owner.json'), 'utf8')) as {
    runId: string
  }
  assert.equal(owner.runId, control.runId, 'Probe ownership receipt does not match')
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    ['control.json', 'owner.json'],
    'Probe run must be fresh'
  )
  return { root, control }
}

/** Synthetic Electron readiness/quit only; never loads normal persistence or settings. */
export async function executeNativePackageProbe(
  controlPath: string,
  host: NativeProbeHost
): Promise<void> {
  const { root, control } = readNativeProbeControl(controlPath)
  assert.equal(host.app.isPackaged, true, 'Native probe requires a packaged application')
  const userData = path.join(root, 'userData')
  const logs = path.join(root, 'logs')
  fs.mkdirSync(userData)
  fs.mkdirSync(logs)
  host.app.setPath('userData', userData)
  host.app.setPath('sessionData', userData)
  host.app.setPath('logs', logs)
  assert.equal(host.app.getPath('userData'), userData)
  const asarSha256 = createHash('sha256').update(host.readArchive(host.archivePath)).digest('hex')
  assert.equal(asarSha256, control.asarSha256, 'Native probe artifact identity mismatch')
  const identity = {
    version: 1,
    runId: control.runId,
    sourceSha256: control.sourceSha256,
    asarSha256,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    pid: process.pid,
    userData,
    listeningPorts: []
  }
  let windowsCreated = 0
  host.app.on('browser-window-created', () => {
    windowsCreated++
  })
  const emit = (stage: string, data: object) => {
    const receipt = {
      ...identity,
      normalStartupLoaded: host.normalStartupLoaded?.() ?? false,
      windowsCreated,
      stage,
      ...data
    }
    fs.writeFileSync(path.join(root, `${stage}.json`), JSON.stringify(receipt) + '\n', {
      flag: 'wx'
    })
    host.emit?.(receipt)
  }
  let beforeQuit = false
  let willQuit = false
  let ready = false
  const timeout = setTimeout(() => {
    emit('failure', { status: 'failed', error: 'Native probe lifecycle deadline exceeded' })
    host.app.exit(1)
  }, 15_000)
  host.app.once('before-quit', () => {
    beforeQuit = true
  })
  host.app.once('will-quit', () => {
    willQuit = true
  })
  host.app.once('quit', (_event, exitCode) => {
    clearTimeout(timeout)
    emit('quit', {
      status: ready && beforeQuit && willQuit && exitCode === 0 ? 'passed' : 'failed',
      exitCode,
      beforeQuit,
      willQuit
    })
  })
  try {
    await host.app.whenReady()
    // This public core provider accepts an in-memory transport. No desktop provider,
    // settings, vault, server, credential service or live network graph is imported.
    let fakeProviderCalls = 0
    const provider = host.loadProvider()({
      apiKey: 'synthetic-offline-key',
      model: 'synthetic/offline-model',
      fetch: async (_url, init) => {
        fakeProviderCalls++
        assert.equal(JSON.parse(String(init.body)).messages[0].content, 'Offline native startup')
        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: { role: 'assistant', content: 'Offline native ready' }
              }
            ]
          })
        )
      }
    })
    const response = await provider.generate(
      {
        messages: [{ kind: 'message', role: 'user', content: 'Offline native startup' }],
        tools: []
      },
      new AbortController().signal
    )
    assert.equal(response.content, 'Offline native ready')
    assert.equal(fakeProviderCalls, 1)
    assert.equal(windowsCreated, 0, 'Synthetic probe must not create a window')
    assert.equal(
      host.normalStartupLoaded?.() ?? false,
      false,
      'Synthetic probe loaded default startup'
    )
    ready = true
    emit('ready', { status: 'passed', fakeProviderCalls })
    host.app.quit()
  } catch (error) {
    clearTimeout(timeout)
    emit('failure', {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Native probe failed'
    })
    host.app.exit(1)
  }
}

export async function runNativePackageProbe(controlPath: string): Promise<void> {
  const require = createRequire(__filename)
  await executeNativePackageProbe(controlPath, {
    app,
    archivePath: app.getAppPath(),
    readArchive: (file) => require('original-fs').readFileSync(file),
    normalStartupLoaded: () =>
      Boolean(require.cache[path.join(app.getAppPath(), 'out/main/normalStartup.js')]),
    loadProvider: () =>
      createRequire(path.join(app.getAppPath(), 'out/main/index.js'))(
        '@ayayaq/vivi/providers/openrouter'
      ).createOpenRouterProvider,
    emit: (receipt) => process.stdout.write(JSON.stringify(receipt) + '\n')
  })
}
