import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({ directory: '', legacy: false }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }))
vi.mock('./settingsService', () => ({
  getSettings: () => ({ useLegacyInterpreter: mocks.legacy })
}))
vi.mock('./botService', () => ({
  getCommands: () => ({ bcfdCommands: [], bcfdSlashCommands: [] })
}))
vi.mock('./aiProviderService', () => ({
  createAiChatCompletion: vi.fn(),
  moderateTextWithOpenAI: vi.fn()
}))
vi.mock('../utils/rendererConsole', () => ({
  rendererConsole: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() }
}))
vi.mock('./atomicPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomicPersistence')>()
  return { ...actual, atomicWrite: vi.fn(actual.atomicWrite) }
})

import { atomicWrite } from './atomicPersistence'
import { stringInfoAdd } from './stringInfo'
import { getBotStateContext, initializeBotState, readBotState, setBotState } from '../utils/virtual'

beforeAll(async () => {
  mocks.directory = await fs.mkdtemp(join(tmpdir(), 'bc-template-checkpoints-'))
  await initializeBotState()
})

afterAll(async () => {
  getBotStateContext().dispose()
  await fs.rm(mocks.directory, { recursive: true, force: true })
})

describe('BCFD shared runtime persistence', () => {
  it('checkpoints concurrent template scripts without lost increments', async () => {
    await setBotState({ count: 0 })
    const template = '$eval\nbotState.count += 1; return botState.count;\n$halt'
    const result = await Promise.all([
      stringInfoAdd({ message: template }),
      stringInfoAdd({ message: template })
    ])
    expect(result).toEqual(['1', '2'])
    expect(await readBotState()).toEqual({ count: 2 })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      count: 2
    })
  })

  it('rolls back the entire template if a later eval block reports an error', async () => {
    await setBotState({ count: 1 })
    const output = await stringInfoAdd({
      message:
        '$eval\nbotState.count = 8; return "first";\n$halt $eval\nbotState.count = 9; throw new Error("template failed");\n$halt'
    })
    expect(output).toContain('template failed')
    expect(await readBotState()).toEqual({ count: 1 })
  })

  it('propagates disk failure after template evaluation and restores durable state', async () => {
    await setBotState({ count: 1 })
    vi.mocked(atomicWrite).mockRejectedValueOnce(new Error('save failed'))
    await expect(
      stringInfoAdd({ message: '$eval\nbotState.count = 8; return "done";\n$halt' })
    ).rejects.toThrow('save failed')
    expect(await readBotState()).toEqual({ count: 1 })
  })

  it('keeps legacy global eval behavior while persisting shared botState safely', async () => {
    mocks.legacy = true
    await setBotState({ count: 1 })
    const output = await stringInfoAdd({
      message: '$eval\nvar legacyGlobal = "kept"; botState.count += 1;\n$halt'
    })
    expect(output).toBe('')
    expect(getBotStateContext().getVariable('legacyGlobal')).toBe('kept')
    expect(await readBotState()).toEqual({ count: 2 })
    mocks.legacy = false
  })

  it('only emits a bot-state resource change after the corresponding disk commit', async () => {
    const { setResourceChangeEventSink } = await import('./resourceChangeService')
    await setBotState({ count: 1 })
    const sink = vi.fn()
    setResourceChangeEventSink(sink)
    await stringInfoAdd({ message: '$eval\nbotState.count = 2; return "done";\n$halt' })
    expect(sink).toHaveBeenCalledOnce()
    expect(sink.mock.calls[0][0]).toMatchObject({ kind: 'bot-state', source: 'system' })
    sink.mockClear()
    vi.mocked(atomicWrite).mockRejectedValueOnce(new Error('save failed'))
    await expect(
      stringInfoAdd({ message: '$eval\nbotState.count = 3; return "done";\n$halt' })
    ).rejects.toThrow('save failed')
    expect(sink).not.toHaveBeenCalled()
    expect(await readBotState()).toEqual({ count: 2 })
    setResourceChangeEventSink(null)
  })
})
