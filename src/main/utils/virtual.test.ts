import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  setVariable: vi.fn(),
  run: vi.fn(),
  dispose: vi.fn()
}))

vi.mock('fs/promises', () => ({ default: { readFile: mocks.readFile } }))
vi.mock('electron', () => ({ app: { getPath: () => '/offline-user-data' } }))
vi.mock('./rendererConsole', () => ({ rendererConsole: {} }))
vi.mock('./quickJsScriptContext', () => ({
  createQuickJSScriptContext: async () => ({
    setVariable: mocks.setVariable,
    run: mocks.run,
    dispose: mocks.dispose
  })
}))

describe('owned bot state restoration', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.readFile.mockImplementation(async (path: string) =>
      path.endsWith('startup.js') ? '' : '{"saved":true}'
    )
    const { initializeBotState } = await import('./virtual')
    await initializeBotState()
    mocks.readFile.mockClear()
    mocks.setVariable.mockClear()
  })

  it('skips the read when the login is already obsolete', async () => {
    const { loadBotState } = await import('./virtual')
    await loadBotState(() => false)
    expect(mocks.readFile).not.toHaveBeenCalled()
    expect(mocks.setVariable).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'cannot apply state after its owner changes during a read (missing=%s)',
    async (missing) => {
      let complete!: () => void
      let current = true
      mocks.readFile.mockImplementationOnce(
        () =>
          new Promise<string>((resolve, reject) => {
            complete = () =>
              missing
                ? reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
                : resolve('{"obsolete":true}')
          })
      )
      const { loadBotState } = await import('./virtual')
      const loading = loadBotState(() => current)
      current = false
      complete()
      await loading
      expect(mocks.setVariable).not.toHaveBeenCalled()
    }
  )

  it('restores state normally for the current owner', async () => {
    const { loadBotState } = await import('./virtual')
    await loadBotState(() => true)
    expect(mocks.setVariable).toHaveBeenCalledExactlyOnceWith('botState', { saved: true })
  })
})
