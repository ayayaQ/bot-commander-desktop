import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn(),
  copyMcpToken: vi.fn(),
  writeText: vi.fn(),
  settings: vi.fn(),
  provider: vi.fn(),
  capabilities: vi.fn(),
  fetchModels: vi.fn()
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
vi.mock('../services/settingsService', () => ({ getSettings: mocks.settings }))
vi.mock('../services/aiProviderService', () => ({
  getAiProvider: mocks.provider,
  getSelectedModelCapabilities: mocks.capabilities,
  fetchAiModels: mocks.fetchModels
}))
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

describe('selected model capability IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settings.mockReturnValue({ aiProvider: 'openai', openaiApiKey: 'host-only-fixture-key' })
    mocks.provider.mockImplementation((settings) =>
      settings.aiProvider === 'openrouter' ? 'openrouter' : 'openai'
    )
    mocks.capabilities.mockReturnValue({ id: 'gpt-5.1', protocol: 'responses' })
  })

  async function handler(channel: string) {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    return mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  }

  it('uses the current host key and selected exact model without fetching a catalog', async () => {
    const lookup = await handler('get-ai-model-capabilities')
    const result = lookup({}, { model: 'gpt-5.1', provider: 'openai', purpose: 'agent' })
    expect(result).toEqual({ id: 'gpt-5.1', protocol: 'responses' })
    expect(mocks.capabilities).toHaveBeenCalledWith(
      { aiProvider: 'openai', openaiApiKey: 'host-only-fixture-key' },
      'gpt-5.1',
      'responses'
    )
    expect(mocks.fetchModels).not.toHaveBeenCalled()
    lookup({}, { model: 'gpt-5.1', provider: 'openai', purpose: 'chat' })
    expect(mocks.capabilities.mock.calls.at(-1)![2]).toBe('chat-completions')
  })

  it('uses Chat Completions for the current OpenRouter agent and rejects stale provider requests', async () => {
    const lookup = await handler('get-ai-model-capabilities')
    mocks.settings.mockReturnValue({
      aiProvider: 'openrouter',
      openrouterApiKey: 'current-host-only-key'
    })
    lookup({}, { model: 'vendor/custom', provider: 'openrouter', purpose: 'agent' })
    expect(mocks.capabilities).toHaveBeenCalledWith(
      { aiProvider: 'openrouter', openrouterApiKey: 'current-host-only-key' },
      'vendor/custom',
      'chat-completions'
    )
    expect(() => lookup({}, { model: 'gpt-5.1', provider: 'openai', purpose: 'agent' })).toThrow(
      'Provider settings changed'
    )
    expect(() =>
      lookup({}, { model: 'vendor/custom', provider: 'openrouter', purpose: 'future' })
    ).toThrow()
  })

  it('rejects catalog transport results after committed provider/key changes', async () => {
    const fetchModels = await handler('fetch-ai-models')
    let finish!: (models: unknown[]) => void
    mocks.fetchModels.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const result = fetchModels({}, { purpose: 'agent' })
    const rejected = expect(result).rejects.toThrow('Provider settings changed')
    mocks.settings.mockReturnValue({
      aiProvider: 'openai',
      openaiApiKey: 'different-host-only-key'
    })
    finish([])
    await rejected
    expect(mocks.fetchModels).toHaveBeenCalledWith('openai', 'host-only-fixture-key', 'responses')
  })
})
