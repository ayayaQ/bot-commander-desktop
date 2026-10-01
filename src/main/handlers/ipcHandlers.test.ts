import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  copyMcpToken: vi.fn(),
  writeText: vi.fn()
}))

// Register the real handlers without loading Electron or any live application services.
vi.mock('electron', () => ({ clipboard: { writeText: mocks.writeText } }))
vi.mock('./ipcSecurity', () => ({
  trustedIpcMain: { handle: mocks.handle, on: mocks.on }
}))
vi.mock('discord.js', () => ({}))
vi.mock('../utils/virtual', () => ({}))
vi.mock('../services/botService', () => ({}))
vi.mock('../services/fileService', () => ({}))
vi.mock('../services/interactionService', () => ({ getInteractions: vi.fn() }))
vi.mock('../services/slashCommandRegistry', () => ({ createInteractionPublishBackend: vi.fn() }))
vi.mock('../services/interactionPublisher', () => ({
  InteractionPublisher: class {
    setEventSink() {}
  }
}))
vi.mock('../services/settingsService', () => ({}))
vi.mock('../services/aiProviderService', () => ({}))
vi.mock('../services/statusService', () => ({}))
vi.mock('../utils/stats', () => ({}))
vi.mock('../services/updateService', () => ({}))
vi.mock('./apiAuthHandlers', () => ({ addApiAuthHandlers: vi.fn() }))
vi.mock('./commandRepoHandlers', () => ({ addCommandRepoHandlers: vi.fn() }))
vi.mock('../services/agentService', () => ({ setAgentEventSink: vi.fn() }))
vi.mock('../services/agentMemoryService', () => ({ setAgentMemoryEventSink: vi.fn() }))
vi.mock('../services/mcpServerService', () => ({
  setMcpEventSinks: vi.fn(),
  copyMcpToken: mocks.copyMcpToken
}))
vi.mock('../services/resourceChangeService', () => ({ setResourceChangeEventSink: vi.fn() }))

async function copyTokenHandler(): Promise<() => Promise<boolean>> {
  const { addIPCHandlers } = await import('./ipcHandlers')
  addIPCHandlers()
  const registration = mocks.handle.mock.calls.find(([channel]) => channel === 'mcp:copy-token')
  expect(registration).toBeDefined()
  return registration![1]
}

describe('MCP token clipboard IPC', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.copyMcpToken.mockResolvedValue('fixture-token')
    mocks.writeText.mockResolvedValue(undefined)
  })

  it('waits for the asynchronous clipboard write before reporting success', async () => {
    let finishWrite!: () => void
    const clipboardWrite = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    mocks.writeText.mockReturnValue(clipboardWrite)
    const copyToken = await copyTokenHandler()
    const finished = vi.fn()
    const result = copyToken().then(finished)

    await vi.waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith('fixture-token'))
    expect(finished).not.toHaveBeenCalled()

    finishWrite()
    await result
    expect(finished).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('propagates clipboard write failures to the invoking renderer', async () => {
    const failure = new Error('Clipboard write failed')
    mocks.writeText.mockRejectedValue(failure)
    const copyToken = await copyTokenHandler()

    await expect(copyToken()).rejects.toBe(failure)
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith('fixture-token')
  })

  it('does not write to the clipboard when token retrieval fails', async () => {
    const failure = new Error('Token unavailable')
    mocks.copyMcpToken.mockRejectedValue(failure)
    const copyToken = await copyTokenHandler()

    await expect(copyToken()).rejects.toBe(failure)
    expect(mocks.writeText).not.toHaveBeenCalled()
  })
})
