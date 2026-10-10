import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  listSkills: vi.fn(),
  skillFolder: vi.fn(),
  chooseSkillFolder: vi.fn(),
  on: vi.fn(),
  copyMcpToken: vi.fn(),
  writeText: vi.fn(),
  settings: vi.fn(),
  provider: vi.fn(),
  capabilities: vi.fn(),
  fetchModels: vi.fn(),
  send: vi.fn(),
  listMemories: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  commitMemory: vi.fn(),
  memorySink: null as ((result: unknown) => void) | null
}))

vi.mock('../services/agentSkillService', () => ({
  loadAgentSkills: mocks.listSkills,
  configureAgentSkillFolder: mocks.skillFolder
}))

// Register the real handlers without loading Electron or any live application services.
vi.mock('electron', () => ({
  clipboard: { writeText: mocks.writeText },
  dialog: { showOpenDialog: mocks.chooseSkillFolder },
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: mocks.send } }] }
}))
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
vi.mock('../services/agentMemoryService', () => ({
  setAgentMemoryEventSink: (sink: (result: unknown) => void) => {
    mocks.memorySink = sink
  },
  loadAgentMemories: mocks.listMemories,
  prepareCreateMemory: mocks.createMemory,
  prepareUpdateMemory: mocks.updateMemory,
  prepareDeleteMemory: mocks.deleteMemory,
  commitMemoryMutation: mocks.commitMemory
}))
vi.mock('../services/agentMcpService', () => ({
  agentMcpService: {
    list: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
    prepareLaunch: vi.fn(),
    start: vi.fn(),
    cancelLaunch: vi.fn(),
    refresh: vi.fn(),
    disconnect: vi.fn(),
    onStatusChanged: vi.fn()
  }
}))
vi.mock('../services/mcpServerService', () => ({
  setMcpEventSinks: vi.fn(),
  copyMcpToken: mocks.copyMcpToken
}))

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

describe('persistent memory IPC compatibility', () => {
  const result = {
    memories: [{ id: 'legacy', content: 'Saved preference', revision: '0123456789abcdef' }],
    limits: {
      maximumMemories: 100,
      maximumMemoryCharacters: 1000,
      maximumTotalCharacters: 20000
    }
  }
  const proposal = { kind: 'create', before: null, after: { id: 'legacy' } }

  async function handler(channel: string) {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    return mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.send.mockReset()
    mocks.listMemories.mockResolvedValue(result)
    mocks.createMemory.mockResolvedValue(proposal)
    mocks.updateMemory.mockResolvedValue(proposal)
    mocks.deleteMemory.mockResolvedValue(proposal)
    mocks.commitMemory.mockImplementation(async () => {
      // Model the facade's committed-only, listener-safe notification contract.
      try {
        mocks.memorySink?.(result)
      } catch {}
      return result
    })
  })

  it('keeps list results and direct create/update/delete arguments unchanged', async () => {
    expect(await (await handler('memory:list'))({})).toEqual(result)
    expect(mocks.listMemories).toHaveBeenCalledExactlyOnceWith()
    expect(mocks.send).not.toHaveBeenCalled()
    await (
      await handler('memory:create')
    )({}, 'Preference')
    expect(mocks.createMemory).toHaveBeenCalledExactlyOnceWith('Preference', 'user')
    await (
      await handler('memory:update')
    )({}, 'legacy', 'exact-revision', 'New preference')
    expect(mocks.updateMemory).toHaveBeenCalledExactlyOnceWith(
      'legacy',
      'exact-revision',
      'New preference',
      'user'
    )
    await (
      await handler('memory:delete')
    )({}, 'legacy', 'delete-revision')
    expect(mocks.deleteMemory).toHaveBeenCalledExactlyOnceWith('legacy', 'delete-revision')
    expect(mocks.commitMemory).toHaveBeenCalledTimes(3)
  })

  it.each(['create', 'update', 'delete'])(
    'emits each memory and resource notification once after a direct %s commit',
    async (kind) => {
      const mutation = await handler(`memory:${kind}`)
      const committed = await mutation({}, 'legacy', 'revision', 'Preference')
      expect(committed).toEqual(result)
      expect(mocks.send.mock.calls.map(([channel]) => channel)).toEqual([
        'memory:changed',
        'resource:changed'
      ])
      expect(mocks.send).toHaveBeenCalledWith('memory:changed', result)
      expect(mocks.send).toHaveBeenCalledWith('resource:changed', {
        kind: 'memories',
        source: 'system',
        revision: expect.stringMatching(/^[a-f0-9]{16}$/)
      })
    }
  )

  it('emits no notifications when the memory commit fails', async () => {
    mocks.commitMemory.mockRejectedValueOnce(new Error('Save failed before commit'))
    const create = await handler('memory:create')
    await expect(create({}, 'Preference')).rejects.toThrow('Save failed before commit')
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('returns the committed IPC result when a resource listener and its logger fail', async () => {
    const create = await handler('memory:create')
    mocks.send.mockImplementation((channel: string) => {
      if (channel === 'resource:changed') throw new Error('Window closed')
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('Log unavailable')
    })
    try {
      await expect(create({}, 'Preference')).resolves.toEqual(result)
      expect(mocks.send).toHaveBeenCalledTimes(2)
    } finally {
      log.mockRestore()
    }
  })
})

describe('explicit read-only skills folder IPC', () => {
  beforeEach(() => vi.clearAllMocks())
  async function handler(channel: string) {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    return mocks.handle.mock.calls.find(([name]) => name === channel)![1]
  }
  it('lists skills and adds only the folder returned by the user dialog', async () => {
    const status = {
      ownedRoot: '/app/agent-skills',
      externalRoots: [],
      skills: [],
      diagnostics: []
    }
    mocks.listSkills.mockResolvedValue(status)
    expect(await (await handler('skills:list'))({})).toEqual(status)
    mocks.chooseSkillFolder.mockResolvedValue({ canceled: false, filePaths: ['/selected/skills'] })
    mocks.skillFolder.mockResolvedValue(status)
    expect(await (await handler('skills:choose-root'))({}, '/ignored/model/path')).toEqual(status)
    expect(mocks.skillFolder).toHaveBeenCalledWith('/selected/skills', true)
    await (
      await handler('skills:remove-root')
    )({}, '/selected/skills')
    expect(mocks.skillFolder).toHaveBeenLastCalledWith('/selected/skills', false)
  })
  it('does not change configuration after dialog cancellation', async () => {
    mocks.chooseSkillFolder.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await (await handler('skills:choose-root'))({})).toBeNull()
    expect(mocks.skillFolder).not.toHaveBeenCalled()
  })
})
