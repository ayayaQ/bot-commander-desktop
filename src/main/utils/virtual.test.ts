import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

type FakeContext = {
  state: Record<string, unknown>
  disposed: boolean
  getVariable: (name: string) => unknown
  setVariable: (name: string, value: unknown) => void
  run: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  appGetPath: vi.fn(),
  contexts: [] as FakeContext[]
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.appGetPath }
}))

vi.mock('./rendererConsole', () => ({
  rendererConsole: {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn()
  }
}))

vi.mock('./quickJsScriptContext', () => ({
  createQuickJSScriptContext: vi.fn(async ({ initialContext }) => {
    const context: FakeContext = {
      state: structuredClone(initialContext),
      disposed: false,
      getVariable(name) {
        return this.state[name]
      },
      setVariable(name, value) {
        this.state[name] = structuredClone(value)
      },
      run: vi.fn(),
      dispose: vi.fn(function (this: FakeContext) {
        this.disposed = true
      })
    }
    mocks.contexts.push(context)
    return context
  })
}))

describe('virtual bot state persistence', () => {
  let userDataPath: string

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.contexts.length = 0
    userDataPath = await fs.mkdtemp(join(tmpdir(), 'bcfd-virtual-'))
    mocks.appGetPath.mockReturnValue(userDataPath)
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('saves live state before replacing the engine and loads it into the new context', async () => {
    const { getBotStateContext, initializeBotState, restartJsEngine } = await import('./virtual')
    await initializeBotState()
    const previous = getBotStateContext() as unknown as FakeContext
    previous.setVariable('botState', { count: 7 })

    await restartJsEngine()

    expect(previous.dispose).toHaveBeenCalledOnce()
    expect((getBotStateContext() as unknown as FakeContext).getVariable('botState')).toEqual({
      count: 7
    })
    await expect(fs.readFile(join(userDataPath, 'botState.json'), 'utf-8')).resolves.toContain(
      '"count": 7'
    )
  })

  it('keeps the live engine intact when its state cannot be saved', async () => {
    const { getBotStateContext, initializeBotState, restartJsEngine } = await import('./virtual')
    await initializeBotState()
    const previous = getBotStateContext() as unknown as FakeContext
    previous.setVariable('botState', { count: 9 })
    await fs.mkdir(join(userDataPath, 'botState.json'))

    await expect(restartJsEngine()).rejects.toThrow()

    expect(previous.dispose).not.toHaveBeenCalled()
    expect(getBotStateContext()).toBe(previous)
    expect(mocks.contexts).toHaveLength(1)
  })
})
