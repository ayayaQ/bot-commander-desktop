import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: { botState: { count: 1 } } as Record<string, any>,
  interpret: vi.fn(),
  saveBotState: vi.fn(),
  rendererError: vi.fn()
}))

vi.mock('./botService', () => ({
  getContext: () => ({
    getVariable: (name: string) => mocks.state[name],
    setVariable: (name: string, value: unknown) => {
      mocks.state[name] = structuredClone(value)
    }
  })
}))

vi.mock('./settingsService', () => ({
  getSettings: () => ({ useLegacyInterpreter: false })
}))

vi.mock('./bcfdLang', () => ({
  interpret: mocks.interpret
}))

vi.mock('../utils/virtual', () => ({
  saveBotState: mocks.saveBotState
}))

vi.mock('../utils/rendererConsole', () => ({
  rendererConsole: {
    error: mocks.rendererError
  }
}))

describe('stringInfoAdd bot state checkpoints', () => {
  beforeEach(() => {
    mocks.state = { botState: { count: 1 } }
    mocks.interpret.mockReset()
    mocks.saveBotState.mockReset().mockResolvedValue(undefined)
    mocks.rendererError.mockReset()
  })

  it('checkpoints bot state changed by normal command execution', async () => {
    mocks.interpret.mockImplementation(async (_message, context) => {
      context.vmContext.setVariable('botState', { count: 2 })
      return { output: 'Count: 2', errors: [] }
    })
    const { stringInfoAdd } = await import('./stringInfo')

    await expect(stringInfoAdd({ message: 'increment' })).resolves.toBe('Count: 2')
    expect(mocks.saveBotState).toHaveBeenCalledWith({ count: 2 })
  })

  it('rolls runtime state back and reports the failure when checkpointing fails', async () => {
    mocks.interpret.mockImplementation(async (_message, context) => {
      context.vmContext.setVariable('botState', { count: 2 })
      return { output: 'Count: 2', errors: [] }
    })
    mocks.saveBotState.mockRejectedValue(new Error('disk full'))
    const { stringInfoAdd } = await import('./stringInfo')

    await expect(stringInfoAdd({ message: 'increment' })).rejects.toThrow('disk full')
    expect(mocks.state.botState).toEqual({ count: 1 })
    expect(mocks.rendererError).toHaveBeenCalledWith(expect.stringContaining('rolled back'))
  })

  it('finishes a failed rollback before a newer command mutation can checkpoint', async () => {
    let rejectFirstSave: (error: Error) => void = () => undefined
    mocks.state = { botState: { count: 0 } }
    mocks.interpret.mockImplementation(async (_message, context) => {
      const current = context.vmContext.getVariable('botState') as { count: number }
      const next = { count: current.count + 1 }
      context.vmContext.setVariable('botState', next)
      return { output: `Count: ${next.count}`, errors: [] }
    })
    mocks.saveBotState
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirstSave = reject
          })
      )
      .mockResolvedValueOnce(undefined)
    const { stringInfoAdd } = await import('./stringInfo')

    const first = stringInfoAdd({ message: 'first' })
    await vi.waitFor(() => expect(mocks.saveBotState).toHaveBeenCalledTimes(1))
    const second = stringInfoAdd({ message: 'second' })

    expect(mocks.interpret).toHaveBeenCalledTimes(1)
    rejectFirstSave(new Error('first save failed'))
    await expect(first).rejects.toThrow('first save failed')
    await expect(second).resolves.toBe('Count: 1')

    expect(mocks.state.botState).toEqual({ count: 1 })
    expect(mocks.saveBotState).toHaveBeenNthCalledWith(1, { count: 1 })
    expect(mocks.saveBotState).toHaveBeenNthCalledWith(2, { count: 1 })
  })
})
