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

describe('agent resource tools', () => {
  beforeEach(() => {
    mocks.state.commands = { bcfdCommands: [], bcfdSlashCommands: [] }
    mocks.state.interactions = []
    mocks.state.settings = { developerPrompt: 'Initial prompt' }
    mocks.state.botState = { count: 1 }
    mocks.state.startupJs = 'const helper = 1'
    vi.clearAllMocks()
  })

  it('searches and reads bundled documentation without a mutation', async () => {
    const { agentToolDefinitions, executeReadTool, mutationToolNames } = await import('./agentTools')
    const names = agentToolDefinitions.map((tool) => tool.function.name)

    expect(names).toContain('search_documentation')
    expect(names).toContain('read_documentation')
    expect(mutationToolNames.has('search_documentation')).toBe(false)
    expect(mutationToolNames.has('read_documentation')).toBe(false)

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
