import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ normalLoads: 0, probe: vi.fn(), exit: vi.fn() }))
vi.mock('electron', () => ({ app: { exit: mocks.exit } }))
vi.mock('./normalStartup', () => {
  mocks.normalLoads++
  return {}
})
vi.mock('./nativePackageProbe', () => ({ runNativePackageProbe: mocks.probe }))
const originalArgv = process.argv

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.normalLoads = 0
})
afterEach(() => {
  process.argv = originalArgv
})

it('loads only the default startup module without a probe flag', async () => {
  process.argv = ['synthetic-executable']
  await (
    await import('./index')
  ).startupDispatch
  expect(mocks.normalLoads).toBe(1)
  expect(mocks.probe).not.toHaveBeenCalled()
  expect(mocks.exit).not.toHaveBeenCalled()
})

it('loads only the synthetic probe with the explicit control path', async () => {
  const control = path.resolve('synthetic/control.json')
  process.argv = ['synthetic-executable', `--bcfd-native-probe=${control}`]
  await (
    await import('./index')
  ).startupDispatch
  expect(mocks.normalLoads).toBe(0)
  expect(mocks.probe).toHaveBeenCalledWith(control)
  expect(mocks.exit).not.toHaveBeenCalled()
})

it('loads neither graph for incomplete probe invocation', async () => {
  process.argv = ['synthetic-executable', '--bcfd-native-probe']
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  try {
    await (
      await import('./index')
    ).startupDispatch
    expect(mocks.normalLoads).toBe(0)
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.exit).toHaveBeenCalledWith(2)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('"status":"failed"'))
  } finally {
    stderr.mockRestore()
  }
})
