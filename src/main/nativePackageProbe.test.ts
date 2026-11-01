import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import { afterEach, expect, it, vi } from 'vitest'
import { executeNativePackageProbe, readNativeProbeControl } from './nativePackageProbe'
import type { NativeProbeHost } from './nativePackageProbe'

vi.mock('electron', () => ({ app: {} }))
const roots: string[] = []
const archive = Buffer.from('synthetic-archive-bytes')
function fixture() {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'bcfd-native-run-'))
  roots.push(root)
  const control = {
    version: 1,
    runId: randomUUID(),
    asarSha256: createHash('sha256').update(archive).digest('hex'),
    sourceSha256: 'a'.repeat(64)
  }
  fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify(control))
  fs.writeFileSync(path.join(root, 'owner.json'), JSON.stringify({ runId: control.runId }))
  return { root, control, file: path.join(root, 'control.json') }
}

function fakeHost() {
  const events = new EventEmitter()
  const paths = new Map<string, string>()
  const ready = vi.fn(async () => {
    expect(fs.existsSync(paths.get('userData')!)).toBe(true)
    expect(paths.get('sessionData')).toBe(paths.get('userData'))
  })
  const exit = vi.fn()
  const loadProvider = vi.fn(() => createOpenRouterProvider)
  const application = Object.assign(events, {
    isPackaged: true,
    setPath: (name: string, file: string) => {
      paths.set(name, file)
    },
    getPath: (name: string) => paths.get(name),
    whenReady: ready,
    quit: () => {
      events.emit('before-quit', {})
      events.emit('will-quit', {})
      events.emit('quit', {}, 0)
    },
    exit
  })
  const host: NativeProbeHost = {
    app: application as unknown as NativeProbeHost['app'],
    archivePath: 'synthetic-app.asar',
    readArchive: () => archive,
    loadProvider,
    emit: vi.fn()
  }
  return { host, paths, ready, exit, loadProvider, application }
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

it('accepts only a fresh owned synthetic control before profile initialization', () => {
  const run = fixture()
  expect(readNativeProbeControl(run.file)).toEqual({
    root: fs.realpathSync(run.root),
    control: run.control
  })
  fs.mkdirSync(path.join(run.root, 'userData'))
  expect(() => readNativeProbeControl(run.file)).toThrow('Probe run must be fresh')
})

it('isolates data before readiness and emits bound fake-only ready/quit receipts', async () => {
  const run = fixture()
  const { host, ready, exit, paths, loadProvider } = fakeHost()
  await executeNativePackageProbe(run.file, host)
  expect(ready).toHaveBeenCalledOnce()
  expect(loadProvider).toHaveBeenCalledOnce()
  expect(exit).not.toHaveBeenCalled()
  expect(paths.get('userData')).toBe(path.join(fs.realpathSync(run.root), 'userData'))
  const readyReceipt = JSON.parse(fs.readFileSync(path.join(run.root, 'ready.json'), 'utf8'))
  const quitReceipt = JSON.parse(fs.readFileSync(path.join(run.root, 'quit.json'), 'utf8'))
  expect(readyReceipt).toMatchObject({
    ...run.control,
    stage: 'ready',
    status: 'passed',
    fakeProviderCalls: 1,
    windowsCreated: 0,
    normalStartupLoaded: false
  })
  expect(quitReceipt).toMatchObject({
    ...run.control,
    stage: 'quit',
    status: 'passed',
    exitCode: 0,
    beforeQuit: true,
    willQuit: true
  })
})

it('does not load the provider or wait for readiness when artifact identity is wrong', async () => {
  const run = fixture()
  const { host, loadProvider, ready } = fakeHost()
  host.readArchive = () => Buffer.from('different-synthetic-artifact')
  await expect(executeNativePackageProbe(run.file, host)).rejects.toThrow(
    'artifact identity mismatch'
  )
  expect(loadProvider).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
})

it('fails closed before any provider load when the control is incomplete', async () => {
  const run = fixture()
  const { host, loadProvider, ready } = fakeHost()
  fs.writeFileSync(run.file, JSON.stringify({ version: 1 }))
  await expect(executeNativePackageProbe(run.file, host)).rejects.toThrow()
  expect(loadProvider).not.toHaveBeenCalled()
  expect(ready).not.toHaveBeenCalled()
})

it('bounds readiness and reports failure if native quit does not complete', async () => {
  vi.useFakeTimers()
  const run = fixture()
  const { host, exit, application } = fakeHost()
  application.quit = () => undefined
  await executeNativePackageProbe(run.file, host)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(exit).toHaveBeenCalledWith(1)
  expect(fs.existsSync(path.join(run.root, 'quit.json'))).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(run.root, 'failure.json'), 'utf8')).status).toBe(
    'failed'
  )
})
