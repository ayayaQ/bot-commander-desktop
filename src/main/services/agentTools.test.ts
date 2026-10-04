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
    contextOverride: undefined as any,
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
  setCommands: (value: any) => {
    mocks.state.commands = value
  }
}))

vi.mock('./interactionService', () => ({
  getInteractions: () => mocks.state.interactions,
  setInteractions: (value: any[]) => {
    mocks.state.interactions = value
  }
}))

vi.mock('./settingsService', () => ({
  getSettings: () => mocks.state.settings,
  setSettings: (value: any) => {
    mocks.state.settings = value
  }
}))

vi.mock('./fileService', () => ({
  saveCommands: mocks.saveCommands,
  saveInteractions: mocks.saveInteractions,
  saveSettings: mocks.saveSettings
}))

vi.mock('../utils/virtual', () => ({
  getStartupJs: async () => mocks.state.startupJs,
  setStartupJs: async (value: string) => {
    mocks.state.startupJs = value
  },
  restartJsEngine: mocks.restartJsEngine,
  updateStartupJsAndRestart: async (value: string) => {
    await mocks.restartJsEngine()
    mocks.state.startupJs = value
  },
  saveBotState: mocks.saveBotState,
  readBotState: async () => mocks.state.botState,
  withBotStateTransaction: async (operation: (context: unknown) => unknown) => {
    const previous = structuredClone(mocks.state.botState)
    try {
      const result = await operation(
        mocks.contextOverride ?? {
          getVariable: () => mocks.state.botState,
          serializeVariable: () => JSON.stringify(mocks.state.botState),
          setVariable: (_name: string, value: unknown) => {
            mocks.state.botState = value
          }
        }
      )
      await mocks.saveBotState()
      return result
    } catch (error) {
      mocks.state.botState = previous
      throw error
    }
  },
  getBotStateContext: () => ({
    getVariable: (name: string) => (name === 'botState' ? mocks.state.botState : undefined),
    setVariable: (name: string, value: unknown) => {
      if (name === 'botState') mocks.state.botState = value
    }
  })
}))

vi.mock('../utils/rendererConsole', () => ({
  getRendererConsoleEntries: ({ limit = 100, types }: { limit?: number; types?: string[] } = {}) =>
    mocks.consoleEntries
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
    mocks.contextOverride = undefined
    vi.clearAllMocks()
    for (const save of [
      mocks.saveCommands,
      mocks.saveInteractions,
      mocks.saveSettings,
      mocks.saveBotState,
      mocks.restartJsEngine
    ])
      save.mockReset()
  })

  it('searches and reads bundled documentation without a mutation', async () => {
    const { agentToolDefinitions, executeReadTool, mutationToolNames } =
      await import('./agentTools')
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

    const documentationTool = agentToolDefinitions.find(
      (tool) => tool.function.name === 'search_documentation'
    )
    expect((documentationTool?.function.parameters as any).properties.category.enum).toContain(
      'interactions'
    )

    const result = (await executeReadTool('search_documentation', {
      query: '$rollnum',
      category: 'keywords',
      limit: 1
    })) as any
    expect(result.bestMatch.title).toBe('$rollnum(min,max)')
    expect(result.bestMatch.content).toContain('random number')

    await expect(
      executeReadTool('read_documentation', { id: result.bestMatch.id })
    ).resolves.toMatchObject({ title: '$rollnum(min,max)', category: 'keywords' })
  })

  it('reads recent console entries with optional type filtering', async () => {
    mocks.consoleEntries = [
      { id: 1, type: 'info', message: 'Connected', timestamp: '2026-07-12T12:00:00.000Z' },
      { id: 2, type: 'error', message: 'Command failed', timestamp: '2026-07-12T12:01:00.000Z' }
    ]
    const { agentToolDefinitions, executeReadTool, mutationToolNames } =
      await import('./agentTools')

    expect(agentToolDefinitions.map((tool) => tool.function.name)).toContain('read_console')
    expect(mutationToolNames.has('read_console')).toBe(false)
    await expect(executeReadTool('read_console', { types: ['error'], limit: 10 })).resolves.toEqual(
      [mocks.consoleEntries[1]]
    )
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
    expect(
      agentToolTargetLabel('create_command', {
        command: { command: 'new-command', commandDescription: 'New command', type: 0 }
      })
    ).toBe('new-command')

    for (const name of ['read_interaction', 'edit_interaction', 'lint_interaction']) {
      expect(agentToolTargetLabel(name, { id: 'interaction-1' })).toBe('status')
    }
    expect(agentToolTargetLabel('read_interaction', { id: 'interaction-2' })).toBe(
      'Description only'
    )
    expect(
      agentToolTargetLabel('create_interaction', {
        interaction: { commandName: 'new-interaction', commandDescription: 'New interaction' }
      })
    ).toBe('new-interaction')
    expect(agentToolTargetLabel('read_command', { id: 'missing' })).toBeUndefined()
    expect(agentToolTargetLabel('read_bot_state', {})).toBeUndefined()
  })

  it('creates canonical commands and returns automatic lint diagnostics', async () => {
    const { commitMutation, executeReadTool, prepareMutation } = await import('./agentTools')
    const prepared = await prepareMutation('create_command', {
      command: { command: 'ping', commandDescription: 'Ping command', channelMessage: 'Pong' }
    })

    const result = (await commitMutation(prepared)) as any
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
    const read = (await executeReadTool('read_command', { id: command.id })) as any
    command.commandDescription = 'Changed elsewhere'

    await expect(
      prepareMutation('edit_command', {
        id: command.id,
        expectedRevision: read.revision,
        patches: [{ op: 'replace', path: '/commandDescription', value: 'Agent edit' }]
      })
    ).rejects.toThrow('Stale resource revision')
    expect(command.commandDescription).toBe('Changed elsewhere')
  })

  it('patches bot state and verifies startup JavaScript after persistence', async () => {
    const { commitMutation, executeReadTool, prepareMutation } = await import('./agentTools')
    const stateRead = (await executeReadTool('read_bot_state', {})) as any
    const stateEdit = await prepareMutation('edit_bot_state', {
      expectedRevision: stateRead.revision,
      patches: [{ op: 'add', path: '/enabled', value: true }]
    })
    await commitMutation(stateEdit)
    expect(mocks.state.botState).toEqual({ count: 1, enabled: true })
    expect(mocks.saveBotState).toHaveBeenCalledOnce()

    const jsRead = (await executeReadTool('read_startup_js', {})) as any
    const jsEdit = await prepareMutation('edit_startup_js', {
      expectedRevision: jsRead.revision,
      content: 'const broken ='
    })
    const result = (await commitMutation(jsEdit)) as any
    expect(result.diagnostics.some((item: any) => item.severity === 'error')).toBe(true)
    expect(mocks.restartJsEngine).toHaveBeenCalledOnce()
  })

  it('leaves commands uncommitted on write failure and retries the same creation without duplicates', async () => {
    const { prepareMutation, commitMutation } = await import('./agentTools')
    const { setResourceChangeEventSink } = await import('./resourceChangeService')
    const sink = vi.fn()
    setResourceChangeEventSink(sink)
    const prepared = await prepareMutation('create_command', {
      command: { command: 'reliable', commandDescription: 'Retry fixture', channelMessage: 'ok' }
    })
    mocks.saveCommands.mockRejectedValueOnce(new Error('Disk full'))
    await expect(commitMutation(prepared)).rejects.toThrow('Disk full')
    expect(mocks.state.commands.bcfdCommands).toEqual([])
    expect(sink).not.toHaveBeenCalled()
    await commitMutation(prepared)
    await commitMutation(prepared)
    expect(mocks.state.commands.bcfdCommands).toHaveLength(1)
    expect(mocks.state.commands.bcfdCommands[0].id).toBe((prepared.after as any).id)
    setResourceChangeEventSink(null)
  })

  it('does not expose an in-flight settings value and preserves it when persistence fails', async () => {
    const { prepareMutation, commitMutation, executeReadTool } = await import('./agentTools')
    const before = (await executeReadTool('read_developer_prompt', {})) as any
    const prepared = await prepareMutation('edit_developer_prompt', {
      expectedRevision: before.revision,
      content: 'Unsaved prompt'
    })
    let reject: (error: Error) => void
    mocks.saveSettings.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        })
    )
    const pending = commitMutation(prepared)
    await vi.waitFor(() => expect(mocks.saveSettings).toHaveBeenCalledOnce())
    expect(mocks.state.settings.developerPrompt).toBe('Initial prompt')
    reject!(new Error('Permission denied'))
    await expect(pending).rejects.toThrow('Permission denied')
    expect(mocks.state.settings.developerPrompt).toBe('Initial prompt')
    await commitMutation(prepared)
    expect(mocks.state.settings.developerPrompt).toBe('Unsaved prompt')
  })

  it('keeps a failed interaction creation retryable and duplicate-safe', async () => {
    const { prepareMutation, commitMutation } = await import('./agentTools')
    const prepared = await prepareMutation('create_interaction', {
      interaction: { commandName: 'status', commandDescription: 'Status', actions: [] }
    })
    mocks.saveInteractions.mockRejectedValueOnce(new Error('Write failed'))
    await expect(commitMutation(prepared)).rejects.toThrow('Write failed')
    expect(mocks.state.interactions).toEqual([])
    await commitMutation(prepared)
    await commitMutation(prepared)
    expect(mocks.state.interactions).toHaveLength(1)
  })

  it('does not publish a new startup source when the replacement engine fails', async () => {
    const { prepareMutation, commitMutation, executeReadTool } = await import('./agentTools')
    const before = (await executeReadTool('read_startup_js', {})) as any
    const prepared = await prepareMutation('edit_startup_js', {
      expectedRevision: before.revision,
      content: 'throw new Error("startup failed")'
    })
    mocks.restartJsEngine.mockRejectedValueOnce(new Error('Startup failed'))
    await expect(commitMutation(prepared)).rejects.toThrow('Startup failed')
    expect(mocks.state.startupJs).toBe('const helper = 1')
  })

  it('commits the exact approved snapshot even if its caller edits the pending retry object', async () => {
    const { prepareMutation, commitMutation } = await import('./agentTools')
    const prepared = await prepareMutation('create_command', {
      command: { command: 'snapshot', commandDescription: 'Approved', channelMessage: 'ok' }
    })
    let resolve: () => void
    mocks.saveCommands.mockImplementationOnce(
      () =>
        new Promise<void>((yes) => {
          resolve = yes
        })
    )
    const pending = commitMutation(prepared)
    await vi.waitFor(() => expect(mocks.saveCommands).toHaveBeenCalledOnce())
    ;(prepared.after as any).commandDescription = 'Changed while saving'
    resolve!()
    await pending
    expect(mocks.state.commands.bcfdCommands[0].commandDescription).toBe('Approved')
  })

  it('uses pristine VM bot-state snapshots for revision checks despite inherited toJSON hooks', async () => {
    const { createQuickJSScriptContext } = await import('../utils/quickJsScriptContext')
    const { prepareMutation, commitMutation, executeReadTool } = await import('./agentTools')
    const vm = await createQuickJSScriptContext({ initialContext: { botState: { count: 1 } } })
    mocks.contextOverride = vm
    try {
      const before = (await executeReadTool('read_bot_state', {})) as any
      const prepared = await prepareMutation('edit_bot_state', {
        expectedRevision: before.revision,
        patches: [{ op: 'replace', path: '/count', value: 7 }]
      })
      vm.run('Object.prototype.toJSON = function () { return { count: 7 } }')
      expect(vm.getVariable('botState')).toEqual({ count: 7 })
      await commitMutation(prepared)
      expect(JSON.parse(vm.serializeVariable('botState'))).toEqual({ count: 7 })
      vm.setVariable('botState', { count: 2 })
      await expect(commitMutation(prepared)).rejects.toThrow('Stale resource revision')
      expect(JSON.parse(vm.serializeVariable('botState'))).toEqual({ count: 2 })
    } finally {
      mocks.contextOverride = undefined
      vm.dispose()
    }
  })

  it('does not start a cancelled mutation after waiting for the resource lock', async () => {
    const { commitMutation, prepareMutation } = await import('./agentTools')
    const { withResourceMutationLock } = await import('./resourceChangeService')
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => entered = resolve)
    const barrier = new Promise<void>((resolve) => release = resolve)
    const holding = withResourceMutationLock('commands', async () => {
      entered()
      await barrier
    })
    await started
    const prepared = await prepareMutation('create_command', {
      command: { command: 'cancelled', channelMessage: 'Do not save' }
    })
    const controller = new AbortController()
    const pending = commitMutation(prepared, 'agent', controller.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled before mutation started')
    controller.abort()
    release()
    await holding
    await rejected
    expect(mocks.saveCommands).not.toHaveBeenCalled()
    expect(mocks.state.commands.bcfdCommands).toEqual([])
    // Existing no-signal callers, including MCP, retain the normal commit path.
    await expect(commitMutation(prepared, 'mcp')).resolves.toMatchObject({ success: true })
    expect(mocks.saveCommands).toHaveBeenCalledOnce()
  })

})
