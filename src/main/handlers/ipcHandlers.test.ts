import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentMcpLaunchPreparation, AgentMcpStatus } from '../../shared/agentMcpTypes'
import type {
  AgentMcpOAuthPublicClient,
  AgentMcpOAuthRegistrationSettings,
  AgentMcpOAuthReview,
  AgentMcpOAuthStatus
} from '../../shared/agentMcpOAuthTypes'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  runAgent: vi.fn(),
  steerAgent: vi.fn(),
  compactAgent: vi.fn(),
  cancelAgent: vi.fn(),
  activeAgent: vi.fn(),
  approveAgent: vi.fn(),
  listSkills: vi.fn(),
  skillFolder: vi.fn(),
  chooseSkillFolder: vi.fn(),
  on: vi.fn(),
  copyMcpToken: vi.fn(),
  writeText: vi.fn(),
  settings: vi.fn(),
  saveSettings: vi.fn(),
  normalizeSettings: vi.fn(),
  setSettings: vi.fn(),
  publicSettings: vi.fn(),
  provider: vi.fn(),
  capabilities: vi.fn(),
  fetchModels: vi.fn(),
  send: vi.fn(),
  listMemories: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  deleteMemory: vi.fn(),
  agentMcp: {
    list: vi.fn(),
    configure: vi.fn(),
    remove: vi.fn(),
    prepareLaunch: vi.fn(),
    start: vi.fn(),
    cancelLaunch: vi.fn(),
    refresh: vi.fn(),
    disconnect: vi.fn(),
    onStatusChanged: vi.fn()
  },
  agentMcpOAuth: {
    configureClient: vi.fn(),
    prepareRegistration: vi.fn(),
    register: vi.fn(),
    prepareSignIn: vi.fn(),
    signIn: vi.fn(),
    cancel: vi.fn()
  },
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
vi.mock('../services/fileService', () => ({ saveSettings: mocks.saveSettings }))
vi.mock('../services/interactionService', () => ({ getInteractions: vi.fn() }))
vi.mock('../services/slashCommandRegistry', () => ({ createInteractionPublishBackend: vi.fn() }))
vi.mock('../services/interactionPublisher', () => ({
  InteractionPublisher: class {
    setEventSink() {}
  }
}))
vi.mock('../services/settingsService', () => ({
  getSettings: mocks.settings,
  normalizeSettings: mocks.normalizeSettings,
  setSettings: mocks.setSettings,
  publicSettings: mocks.publicSettings
}))
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
vi.mock('../services/agentService', () => ({
  setAgentEventSink: vi.fn(),
  runAgentSession: mocks.runAgent,
  steerAgentSession: mocks.steerAgent,
  compactAgentSession: mocks.compactAgent,
  cancelAgentRun: mocks.cancelAgent,
  setActiveAgentSession: mocks.activeAgent,
  resolveAgentApproval: mocks.approveAgent
}))
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
  agentMcpService: mocks.agentMcp,
  agentMcpOAuthService: mocks.agentMcpOAuth
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

describe('explicit agent MCP client IPC', () => {
  beforeEach(() => vi.clearAllMocks())
  const routes = [
    ['list', 'list', []],
    ['configure', 'configure', [{ id: 'fixture', command: '/installed/fixture' }]],
    ['remove', 'remove', ['fixture']],
    ['prepare-launch', 'prepareLaunch', ['fixture']],
    ['start', 'start', ['one-use-review-token']],
    ['cancel-launch', 'cancelLaunch', ['one-use-review-token']],
    ['refresh', 'refresh', ['fixture', ['tools', 'resources']]],
    ['disconnect', 'disconnect', ['fixture']]
  ] as const
  it.each(routes)(
    'forwards only the explicit %s action arguments',
    async (channel, method, args) => {
      const { addIPCHandlers } = await import('./ipcHandlers')
      const result = { revision: 'host-status', servers: [], environmentNames: [], paused: false }
      mocks.agentMcp[method].mockResolvedValueOnce(result)
      addIPCHandlers()
      const registered = mocks.handle.mock.calls.find(([name]) => name === `agent-mcp:${channel}`)
      expect(registered).toBeDefined()
      expect(await registered![1]({ sender: 'trusted-wrapper-fixture' }, ...args)).toEqual(result)
      expect(mocks.agentMcp[method]).toHaveBeenCalledExactlyOnceWith(...args)
      expect(mocks.agentMcp.start).toHaveBeenCalledTimes(method === 'start' ? 1 : 0)
    }
  )
  it('publishes only host-captured status without starting or refreshing a server', async () => {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    const status = { revision: 'captured-status', servers: [], environmentNames: [], paused: false }
    mocks.agentMcp.onStatusChanged.mock.calls[0][0](status)
    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('agent-mcp:status', status)
    expect(mocks.agentMcp.start).not.toHaveBeenCalled()
    expect(mocks.agentMcp.refresh).not.toHaveBeenCalled()
  })
})

describe('public agent MCP OAuth IPC', () => {
  const client: AgentMcpOAuthPublicClient = {
    id: 'public-fixture-client',
    issuer: 'https://issuer.example',
    redirectPort: 53211,
    redirectPath: '/oauth/callback',
    scopes: ['mcp:read']
  }
  const settings: AgentMcpOAuthRegistrationSettings = {
    issuer: client.issuer,
    redirectPort: client.redirectPort,
    redirectPath: client.redirectPath,
    scopes: client.scopes,
    clientName: 'Fixture desktop client'
  }
  const serverStatus = {
    server: {
      transport: 'http' as const,
      id: 'fixture',
      label: 'Fixture MCP',
      endpoint: 'https://mcp.example/rpc',
      protocol: 'legacy' as const,
      allowLoopbackHttp: false
    },
    state: 'disabled' as const,
    cleanupPending: false,
    oauth: {
      state: 'authorized',
      hasClient: true,
      revision: 'public-session-revision'
    } satisfies AgentMcpOAuthStatus
  }
  const status: AgentMcpStatus = {
    revision: 'host-status',
    servers: [serverStatus],
    environmentNames: [],
    paused: false
  }
  const review: AgentMcpOAuthReview = {
    token: 'one-use-oauth-review',
    kind: 'sign-in',
    serverId: 'fixture',
    configRevision: 'fixture-config-revision',
    disclosure: 'Open the fixture issuer in the browser',
    expiresAt: 2000
  }
  const preparation: AgentMcpLaunchPreparation = {
    token: 'separate-connection-review',
    serverId: 'fixture',
    disclosure: 'Connect to the fixture MCP server',
    launchDigest: 'fixture-fresh-launch-digest',
    expiresAt: 3000
  }
  const routes = [
    ['configure-client', 'configureClient', ['fixture', client], status],
    [
      'prepare-registration',
      'prepareRegistration',
      ['fixture', settings],
      { ...review, kind: 'registration' }
    ],
    ['register', 'register', ['one-use-registration-review'], status],
    ['prepare-sign-in', 'prepareSignIn', ['fixture'], review],
    ['sign-in', 'signIn', ['one-use-oauth-review'], { status, preparation }],
    ['cancel', 'cancel', ['fixture'], status]
  ] as const

  beforeEach(() => vi.clearAllMocks())

  it.each(routes)(
    'routes the public %s arguments and returns the host result unchanged',
    async (channel, method, args, result) => {
      const { addIPCHandlers } = await import('./ipcHandlers')
      mocks.agentMcpOAuth[method].mockResolvedValueOnce(result)
      addIPCHandlers()
      const registered = mocks.handle.mock.calls.find(
        ([name]) => name === `agent-mcp:oauth-${channel}`
      )

      expect(registered).toBeDefined()
      expect(await registered![1]({ sender: 'trusted-wrapper-fixture' }, ...args)).toBe(result)
      expect(mocks.agentMcpOAuth[method]).toHaveBeenCalledExactlyOnceWith(...args)
      expect(mocks.agentMcp.start).not.toHaveBeenCalled()
      expect(mocks.agentMcp.refresh).not.toHaveBeenCalled()
      expect(mocks.copyMcpToken).not.toHaveBeenCalled()
    }
  )

  it('registers only the six explicit OAuth actions on the trusted invoke wrapper', async () => {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()

    expect(
      mocks.handle.mock.calls
        .map(([channel]) => channel)
        .filter((channel) => channel.startsWith('agent-mcp:oauth'))
    ).toEqual(routes.map(([channel]) => `agent-mcp:oauth-${channel}`))
    expect(mocks.on.mock.calls.some(([channel]) => channel.startsWith('agent-mcp:oauth'))).toBe(
      false
    )
  })

  it('keeps public OAuth state on the existing host-captured status channel', async () => {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    mocks.agentMcp.onStatusChanged.mock.calls[0][0](status)

    expect(mocks.send).toHaveBeenCalledExactlyOnceWith('agent-mcp:status', status)
    expect(mocks.agentMcpOAuth.signIn).not.toHaveBeenCalled()
    expect(mocks.agentMcp.start).not.toHaveBeenCalled()
  })

  it('propagates an expired review error without starting a connection', async () => {
    const { addIPCHandlers } = await import('./ipcHandlers')
    const failure = new Error('OAuth review expired')
    mocks.agentMcpOAuth.signIn.mockRejectedValueOnce(failure)
    addIPCHandlers()
    const registered = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'agent-mcp:oauth-sign-in'
    )

    await expect(registered![1]({}, 'expired-review')).rejects.toBe(failure)
    expect(mocks.agentMcpOAuth.signIn).toHaveBeenCalledExactlyOnceWith('expired-review')
    expect(mocks.agentMcp.start).not.toHaveBeenCalled()
  })
})

describe('owned agent run IPC routing', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  async function handlers() {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    return new Map(mocks.handle.mock.calls.map(([channel, callback]) => [channel, callback]))
  }

  it('awaits the admitted send and forwards only the selected session and current host settings', async () => {
    const current = { aiProvider: 'openai', openaiApiKey: 'offline-fixture-only' }
    mocks.settings.mockReturnValue(current)
    let resolve!: (result: { runId: string }) => void
    mocks.runAgent.mockReturnValue(
      new Promise((yes) => {
        resolve = yes
      })
    )
    const routes = await handlers()
    let settled = false
    const result = routes.get('agent:send')!({}, 'selected-session', 'Calculate')
    void result.then(() => {
      settled = true
    })
    expect(mocks.runAgent).toHaveBeenCalledWith('selected-session', 'Calculate', current)
    expect(settled).toBe(false)
    resolve({ runId: 'owned-run' })
    expect(await result).toEqual({ runId: 'owned-run' })
  })

  it('routes compaction to the selected session with current host settings', async () => {
    const current = { aiProvider: 'openai', openaiApiKey: 'offline-fixture-only' }
    mocks.settings.mockReturnValue(current)
    mocks.compactAgent.mockResolvedValue({ runId: 'compact-owned-run' })
    const routes = await handlers()
    expect(await routes.get('agent:compact')!({}, 'selected-session')).toEqual({
      runId: 'compact-owned-run'
    })
    expect(mocks.compactAgent).toHaveBeenCalledExactlyOnceWith('selected-session', current)
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })

  it.each(['queue', 'interrupt'])(
    'routes %s steering with the captured run and only current host settings',
    async (mode) => {
      const current = { aiProvider: 'openai', openaiApiKey: 'offline-fixture-only' }
      mocks.settings.mockReturnValue(current)
      mocks.steerAgent.mockResolvedValue({ runId: 'owned-run' })
      const routes = await handlers()
      expect(
        await routes.get('agent:steer')!({}, 'selected-session', 'captured-run', 'Direction', mode)
      ).toEqual({ runId: 'owned-run' })
      expect(mocks.steerAgent).toHaveBeenCalledExactlyOnceWith(
        'selected-session',
        'captured-run',
        'Direction',
        mode,
        current
      )
      expect(mocks.approveAgent).not.toHaveBeenCalled()
      expect(mocks.cancelAgent).not.toHaveBeenCalled()
    }
  )

  it('keeps session switching distinct from cancellation and preserves the exact human approval identity', async () => {
    const routes = await handlers()
    mocks.activeAgent.mockResolvedValue(undefined)
    mocks.cancelAgent.mockReturnValue(true)
    mocks.approveAgent.mockResolvedValue(false)
    expect(await routes.get('agent:set-active')!({}, 'next-session')).toBe(true)
    expect(mocks.cancelAgent).not.toHaveBeenCalled()
    expect(await routes.get('agent:cancel')!({}, 'prior-session')).toBe(true)
    expect(mocks.cancelAgent).toHaveBeenCalledExactlyOnceWith('prior-session')
    expect(
      await routes.get('agent:approve')!({}, 'prior-session', 'call', true, 'exact-approval')
    ).toBe(false)
    expect(mocks.approveAgent).toHaveBeenCalledExactlyOnceWith(
      'prior-session',
      'call',
      true,
      'exact-approval'
    )
  })
})

describe('write-only DeepSeek credential IPC', () => {
  async function handlers() {
    const { addIPCHandlers } = await import('./ipcHandlers')
    addIPCHandlers()
    return new Map(mocks.handle.mock.calls.map(([channel, handler]) => [channel, handler]))
  }
  let current: Record<string, unknown>
  beforeEach(() => {
    vi.clearAllMocks()
    current = {
      aiProvider: 'deepseek',
      openaiApiKey: '',
      deepseekApiKey: 'saved-chat-fixture',
      deepseekWebApiKey: 'saved-web-fixture',
      deepseekChatAccountRevision: 'chat-revision',
      agentWebAccountRevision: 'web-revision'
    }
    mocks.settings.mockImplementation(() => current)
    mocks.normalizeSettings.mockImplementation((value) => ({
      ...value,
      deepseekChatAccountRevision:
        value.deepseekApiKey === current.deepseekApiKey ? 'chat-revision' : 'new-chat-revision'
    }))
    mocks.setSettings.mockImplementation((value) => {
      current = value
    })
    mocks.publicSettings.mockImplementation(() => {
      const { deepseekApiKey, deepseekWebApiKey, ...rest } = current
      return {
        ...rest,
        deepseekKeyConfigured: !!deepseekApiKey,
        deepseekWebKeyConfigured: !!deepseekWebApiKey
      }
    })
    mocks.saveSettings.mockResolvedValue(undefined)
  })
  it('returns flags/nonces only and ordinary settings saves preserve host credentials', async () => {
    const routes = await handlers()
    expect(routes.get('get-settings')!({})).not.toHaveProperty('deepseekApiKey')
    const saved = await routes.get('save-settings')!(
      {},
      { ...current, theme: 'dark', deepseekApiKey: 'forged-chat', deepseekWebApiKey: 'forged-web' }
    )
    expect(current.deepseekApiKey).toBe('saved-chat-fixture')
    expect(current.deepseekWebApiKey).toBe('saved-web-fixture')
    expect(saved).not.toHaveProperty('deepseekApiKey')
    expect(saved).not.toHaveProperty('deepseekWebApiKey')
  })
  it.each([
    { purpose: 'chat', value: 'replacement', expectedRevision: 'stale' },
    { purpose: 'web', value: 'replacement', expectedRevision: 'stale' },
    { purpose: 'other', value: 'replacement', expectedRevision: 'chat-revision' },
    {
      purpose: 'chat',
      value: 'replacement',
      expectedRevision: 'chat-revision',
      endpoint: 'https://evil.invalid'
    },
    { purpose: 'chat', value: 'bad\nkey', expectedRevision: 'chat-revision' }
  ])('rejects stale or forged credential payload %# without persistence', async (request) => {
    const routes = await handlers()
    await expect(routes.get('save-deepseek-key')!({}, request)).rejects.toThrow()
    expect(mocks.saveSettings).not.toHaveBeenCalled()
    expect(mocks.setSettings).not.toHaveBeenCalled()
  })
  it('saves and clears only the exact chosen secret without returning it', async () => {
    const routes = await handlers()
    const result = await routes.get('save-deepseek-key')!(
      {},
      { purpose: 'chat', value: 'new-chat-fixture', expectedRevision: 'chat-revision' }
    )
    expect(current.deepseekApiKey).toBe('new-chat-fixture')
    expect(current.deepseekWebApiKey).toBe('saved-web-fixture')
    expect(result).toMatchObject({
      deepseekKeyConfigured: true,
      deepseekChatAccountRevision: 'new-chat-revision'
    })
    expect(JSON.stringify(result)).not.toContain('new-chat-fixture')
    await routes.get('save-deepseek-key')!(
      {},
      { purpose: 'web', value: '', expectedRevision: 'web-revision' }
    )
    expect(current.deepseekWebApiKey).toBe('')
    expect(current.deepseekApiKey).toBe('new-chat-fixture')
  })
  it('leaves the saved key active on persistence failure and sanitizes the error', async () => {
    const routes = await handlers()
    mocks.saveSettings.mockRejectedValueOnce(new Error('raw replacement-secret provider detail'))
    await expect(
      routes.get('save-deepseek-key')!(
        {},
        { purpose: 'chat', value: 'replacement-secret', expectedRevision: 'chat-revision' }
      )
    ).rejects.toThrow('existing key remains active')
    expect(current.deepseekApiKey).toBe('saved-chat-fixture')
    expect(mocks.setSettings).not.toHaveBeenCalled()
  })
})
