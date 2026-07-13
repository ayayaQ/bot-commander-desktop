import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const state = {
    commands: { bcfdCommands: [] as any[], bcfdSlashCommands: [] as any[] },
    interactions: [] as any[],
    settings: { developerPrompt: 'Initial prompt' } as any,
    botState: { count: 1 } as any,
    startupJs: 'const helper = 1'
  }
  return {
    state,
    consoleEntries: [] as any[],
    saveCommands: vi.fn(),
    saveInteractions: vi.fn(),
    saveSettings: vi.fn(),
    saveBotState: vi.fn(),
    restartJsEngine: vi.fn()
  }
})

vi.mock('./botService', () => ({
  getCommands: () => mocks.state.commands,
  setCommands: (value: any) => { mocks.state.commands = value }
}))

vi.mock('./interactionService', () => ({
  getInteractions: () => mocks.state.interactions,
  setInteractions: (value: any[]) => { mocks.state.interactions = value }
}))

vi.mock('./settingsService', () => ({
  getSettings: () => mocks.state.settings,
  setSettings: (value: any) => { mocks.state.settings = value }
}))

vi.mock('./fileService', () => ({
  saveCommands: mocks.saveCommands,
  saveInteractions: mocks.saveInteractions,
  saveSettings: mocks.saveSettings
}))

vi.mock('../utils/virtual', () => ({
  getStartupJs: async () => mocks.state.startupJs,
  setStartupJs: async (value: string) => { mocks.state.startupJs = value },
  restartJsEngine: mocks.restartJsEngine,
  saveBotState: mocks.saveBotState,
  getBotStateContext: () => ({
    getVariable: (name: string) => name === 'botState' ? mocks.state.botState : undefined,
    setVariable: (name: string, value: unknown) => { if (name === 'botState') mocks.state.botState = value }
  })
}))

vi.mock('../utils/rendererConsole', () => ({
  getRendererConsoleEntries: ({ limit = 100, types }: { limit?: number; types?: string[] } = {}) => mocks.consoleEntries
    .filter((entry) => !types?.length || types.includes(entry.type))
    .slice(-limit)
}))

describe('agent resource tools', () => {
  beforeEach(() => {
    mocks.state.commands = { bcfdCommands: [], bcfdSlashCommands: [] }
    mocks.state.interactions = []
    mocks.state.settings = { developerPrompt: 'Initial prompt' }
    mocks.state.botState = { count: 1 }
    mocks.state.startupJs = 'const helper = 1'
    mocks.consoleEntries = []
    vi.clearAllMocks()
  })

  it('searches and reads bundled documentation without a mutation', async () => {
    const { agentToolDefinitions, executeReadTool, mutationToolNames } = await import('./agentTools')
    const names = agentToolDefinitions.map((tool) => tool.function.name)

    expect(names).toContain('search_documentation')
    expect(names).toContain('read_documentation')
    expect(names).toContain('list_memories')
    expect(names).toContain('create_memory')
    expect(names).toContain('edit_memory')
    expect(names).toContain('delete_memory')
    expect(mutationToolNames.has('search_documentation')).toBe(false)
    expect(mutationToolNames.has('read_documentation')).toBe(false)
    expect(mutationToolNames.has('list_memories')).toBe(false)
    expect(mutationToolNames.has('create_memory')).toBe(true)
    expect(mutationToolNames.has('edit_memory')).toBe(true)
    expect(mutationToolNames.has('delete_memory')).toBe(true)

    const result = await executeReadTool('search_documentation', {
      query: '$rollnum',
      category: 'keywords',
      limit: 1
    }) as any
    expect(result.bestMatch.title).toBe('$rollnum(min,max)')
    expect(result.bestMatch.content).toContain('random number')

    await expect(executeReadTool('read_documentation', { id: result.bestMatch.id })).resolves
      .toMatchObject({ title: '$rollnum(min,max)', category: 'keywords' })
  })

  it('reads recent console entries with optional type filtering', async () => {
    mocks.consoleEntries = [
      { id: 1, type: 'info', message: 'Connected', timestamp: '2026-07-12T12:00:00.000Z' },
      { id: 2, type: 'error', message: 'Command failed', timestamp: '2026-07-12T12:01:00.000Z' }
    ]
    const { agentToolDefinitions, executeReadTool, mutationToolNames } = await import('./agentTools')

    expect(agentToolDefinitions.map((tool) => tool.function.name)).toContain('read_console')
    expect(mutationToolNames.has('read_console')).toBe(false)
    await expect(executeReadTool('read_console', { types: ['error'], limit: 10 })).resolves.toEqual([
      mocks.consoleEntries[1]
    ])
  })

  it('resolves stable labels for command and interaction resource tools', async () => {
    mocks.state.commands.bcfdCommands = [
      { id: 'command-1', command: '  ping\nnow ', commandDescription: 'Ping command', type: 0 },
      { id: 'command-2', command: '', commandDescription: 'Join description', type: 2 },
      { id: 'command-3', command: '', commandDescription: 'Description only', type: 0 }
    ]
    mocks.state.interactions = [
      { id: 'interaction-1', commandName: ' status ', commandDescription: 'Status interaction' },
      { id: 'interaction-2', commandName: '', commandDescription: 'Description only' }
    ]
    const { agentToolTargetLabel } = await import('./agentTools')

    for (const name of ['read_command', 'edit_command', 'lint_command']) {
      expect(agentToolTargetLabel(name, { id: 'command-1' })).toBe('ping now')
    }
    expect(agentToolTargetLabel('read_command', { id: 'command-2' })).toBe('Member Join')
    expect(agentToolTargetLabel('read_command', { id: 'command-3' })).toBe('Description only')
    expect(agentToolTargetLabel('create_command', {
      command: { command: 'new-command', commandDescription: 'New command', type: 0 }
    })).toBe('new-command')

    for (const name of ['read_interaction', 'edit_interaction', 'lint_interaction']) {
      expect(agentToolTargetLabel(name, { id: 'interaction-1' })).toBe('status')
    }
    expect(agentToolTargetLabel('read_interaction', { id: 'interaction-2' })).toBe(
      'Description only'
    )
    expect(agentToolTargetLabel('create_interaction', {
      interaction: { commandName: 'new-interaction', commandDescription: 'New interaction' }
    })).toBe('new-interaction')
    expect(agentToolTargetLabel('read_command', { id: 'missing' })).toBeUndefined()
    expect(agentToolTargetLabel('read_bot_state', {})).toBeUndefined()
  })

  it('creates canonical commands and returns automatic lint diagnostics', async () => {
    const { commitMutation, executeReadTool, prepareMutation } = await import('./agentTools')
    const prepared = await prepareMutation('create_command', {
      command: { command: 'ping', commandDescription: 'Ping command', channelMessage: 'Pong' }
    })

    const result = await commitMutation(prepared) as any
    const stored = mocks.state.commands.bcfdCommands[0]

    expect(stored.command).toBe('ping')
    expect(stored.id).toBeTruthy()
    expect(result.success).toBe(true)
    expect(result.diagnostics).toEqual([])
    expect(mocks.saveCommands).toHaveBeenCalledOnce()
    await expect(executeReadTool('read_command', { id: stored.id })).resolves.toMatchObject({
      resource: { command: 'ping' }
    })
  })

  it('rejects stale edits and preserves changes made after a read', async () => {
    const { commitMutation, executeReadTool, prepareMutation } = await import('./agentTools')
    const created = await prepareMutation('create_command', {
      command: { command: 'ping', commandDescription: 'Ping command' }
    })
    await commitMutation(created)
    const command = mocks.state.commands.bcfdCommands[0]
    const read = await executeReadTool('read_command', { id: command.id }) as any
    command.commandDescription = 'Changed elsewhere'

    await expect(prepareMutation('edit_command', {
      id: command.id,
      expectedRevision: read.revision,
      patches: [{ op: 'replace', path: '/commandDescription', value: 'Agent edit' }]
    })).rejects.toThrow('Stale resource revision')
    expect(command.commandDescription).toBe('Changed elsewhere')
  })

  it('patches bot state and verifies startup JavaScript after persistence', async () => {
    const { commitMutation, executeReadTool, prepareMutation } = await import('./agentTools')
    const stateRead = await executeReadTool('read_bot_state', {}) as any
    const stateEdit = await prepareMutation('edit_bot_state', {
      expectedRevision: stateRead.revision,
      patches: [{ op: 'add', path: '/enabled', value: true }]
    })
    await commitMutation(stateEdit)
    expect(mocks.state.botState).toEqual({ count: 1, enabled: true })
    expect(mocks.saveBotState).toHaveBeenCalledOnce()

    const jsRead = await executeReadTool('read_startup_js', {}) as any
    const jsEdit = await prepareMutation('edit_startup_js', {
      expectedRevision: jsRead.revision,
      content: 'const broken ='
    })
    const result = await commitMutation(jsEdit) as any
    expect(result.diagnostics.some((item: any) => item.severity === 'error')).toBe(true)
    expect(mocks.restartJsEngine).toHaveBeenCalledOnce()
  })
})
