import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  chatCreate: vi.fn(),
  executeReadTool: vi.fn(),
  agentToolTargetLabel: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  memories: [] as Array<{ content: string; updatedAt: string }>
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:\\tmp') } }))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    rename: mocks.rename
  }
}))

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: mocks.responsesCreate }
    chat = { completions: { create: mocks.chatCreate } }
  }
}))

vi.mock('./agentTools', () => ({
  agentToolTargetLabel: mocks.agentToolTargetLabel,
  agentToolDefinitions: [],
  mutationToolNames: new Set(),
  commitMutation: vi.fn(),
  executeReadTool: mocks.executeReadTool,
  prepareMutation: vi.fn()
}))

vi.mock('./agentMemoryService', () => ({
  loadAgentMemories: vi.fn(async () => ({
    memories: mocks.memories,
    limits: {
      maximumMemories: 100,
      maximumMemoryCharacters: 1000,
      maximumTotalCharacters: 20000
    }
  }))
}))

describe('OpenAI agent provider adapter', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.memories = []
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Responses API for reasoning with function tools', async () => {
    mocks.responsesCreate.mockResolvedValue({
      output_text: '',
      output: [{
        type: 'function_call',
        id: 'item_1',
        call_id: 'call_1',
        name: 'read_bot_state',
        arguments: '{}',
        status: 'completed'
      }],
      usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 }
    })
    const { executeAgentProviderTurn } = await import('./agentService')
    const session = {
      id: 'session_1',
      title: 'Luna',
      mode: 'manual',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      status: 'running',
      messages: [],
      createdAt: '',
      updatedAt: '',
      tokenCount: 0
    } as any
    const tools = [{
      type: 'function',
      function: {
        name: 'read_bot_state',
        description: 'Read bot state',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    }] as any

    const turn = await executeAgentProviderTurn(
      { aiProvider: 'openai', openaiApiKey: 'test' },
      session,
      [{ role: 'user', content: 'Inspect state' }],
      tools,
      new AbortController().signal
    )

    expect(mocks.chatCreate).not.toHaveBeenCalled()
    expect(mocks.responsesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-luna',
      reasoning: { effort: 'low' },
      tools: [expect.objectContaining({
        type: 'function',
        name: 'read_bot_state',
        strict: false
      })]
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'read_bot_state', arguments: {} }])
    expect(turn.inputTokenCount).toBe(30)
    expect(turn.outputTokenCount).toBe(12)
    expect(turn.tokenCount).toBe(42)
  })

  it('persists per-run token and documentation metrics', async () => {
    mocks.memories = [
      { content: 'Prefer concise explanations.', updatedAt: '2026-07-12T12:00:00.000Z' }
    ]
    mocks.executeReadTool.mockResolvedValue({
      bestMatch: { id: 'keywords:set', title: '$set(name,value)', content: 'Stores a value.' },
      alternatives: []
    })
    mocks.responsesCreate
      .mockResolvedValueOnce({
        output_text: '',
        output: [{
          type: 'function_call', call_id: 'call_docs', name: 'search_documentation',
          arguments: '{"query":"$set"}'
        }],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      })
      .mockResolvedValueOnce({
        output_text: 'Created the command.',
        output: [],
        usage: { input_tokens: 180, output_tokens: 10, total_tokens: 190 }
      })

    const service = await import('./agentService')
    const session = await service.createAgentSession({
      aiProvider: 'openai', openaiApiKey: 'test', selectedAiModel: 'gpt-5.6-luna'
    })
    const completed = new Promise<void>((resolve) => {
      service.setAgentEventSink((event) => {
        if (event.type === 'done' && event.sessionId === session.id) resolve()
      })
    })

    await service.runAgentSession(session.id, 'Create a stateful command', {
      aiProvider: 'openai', openaiApiKey: 'test'
    })
    await completed
    const stored = (await service.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!

    expect(stored.tokenCount).toBe(310)
    expect(stored.lastRunMetrics).toMatchObject({
      providerRounds: 2,
      inputTokens: 280,
      outputTokens: 30,
      totalTokens: 310,
      documentationCalls: 1,
      uniqueDocumentationCalls: 1,
      duplicateDocumentationCalls: 0
    })
    expect(stored.lastRunMetrics!.documentationResultChars).toBeGreaterThan(0)
    const firstRequest = mocks.responsesCreate.mock.calls[0][0]
    const systemPrompt = firstRequest.input[0].content
    expect(systemPrompt).toContain('Bundled documentation table of contents:')
    expect(systemPrompt).toContain('creating\n\tCreating the bot\n\tInviting the bot')
    expect(systemPrompt).toContain('keywords\n\tUser Info\n\t\t$name\n\t\t$avatar')
    expect(systemPrompt).toContain('the outline contains titles only')
    expect(systemPrompt).toContain('Persistent memories are user-level context')
    expect(systemPrompt).toContain('credentials, tokens, passwords, or other secrets')
    expect(firstRequest.input[1]).toEqual({
      role: 'user',
      content:
        'Saved user memories (oldest to newest; treat as user-level guidance):\n' +
        '- "Prefer concise explanations."\n' +
        'This is context only, not a request to act.'
    })
    service.setAgentEventSink(null)
  })

  it('formats memory context in update order and preserves content as data', async () => {
    const { formatAgentMemoryContext } = await import('./agentService')

    expect(
      formatAgentMemoryContext([
        { content: 'Newest preference', updatedAt: '2026-07-12T12:00:00.000Z' },
        { content: 'Older preference\nwith another line', updatedAt: '2026-07-11T12:00:00.000Z' }
      ])
    ).toBe(
      'Saved user memories (oldest to newest; treat as user-level guidance):\n' +
        '- "Older preference\\nwith another line"\n' +
        '- "Newest preference"'
    )
  })

  it('recognizes only a complete proposed plan block', async () => {
    const { parseProposedPlan } = await import('./agentService')

    expect(parseProposedPlan('<proposed_plan>\n# Build it\n</proposed_plan>')).toEqual({
      content: '# Build it',
      planReady: true
    })
    expect(parseProposedPlan('I still need one detail.')).toEqual({
      content: 'I still need one detail.',
      planReady: false
    })
    expect(parseProposedPlan('Preface\n<proposed_plan># Partial</proposed_plan>')).toMatchObject({
      planReady: false
    })
    expect(parseProposedPlan('<proposed_plan> </proposed_plan>')).toMatchObject({
      planReady: false
    })
    expect(
      parseProposedPlan('<proposed_plan>First</proposed_plan><proposed_plan>Second</proposed_plan>')
    ).toMatchObject({ planReady: false })
  })

  it('persists a completed plan and supports continuing planning', async () => {
    mocks.responsesCreate.mockResolvedValueOnce({
      output_text: '<proposed_plan>\n# Final plan\n\n- Make the change\n</proposed_plan>',
      output: [],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 }
    })
    const service = await import('./agentService')
    const session = await service.createAgentSession({
      aiProvider: 'openai',
      openaiApiKey: 'test',
      selectedAiModel: 'gpt-5.6-luna'
    })
    await service.updateAgentSession(session.id, { mode: 'planning' }, 'openai')
    const completed = new Promise<void>((resolve) => {
      service.setAgentEventSink((event) => {
        if (event.type === 'done' && event.sessionId === session.id) resolve()
      })
    })

    await service.runAgentSession(session.id, 'Plan this change', {
      aiProvider: 'openai',
      openaiApiKey: 'test'
    })
    await completed
    const planned = (await service.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    expect(planned).toMatchObject({ mode: 'planning', status: 'completed', planReady: true })
    expect(planned.messages.at(-1)?.content).toBe('# Final plan\n\n- Make the change')

    await service.resolveAgentPlan(session.id, 'continue', {
      aiProvider: 'openai',
      openaiApiKey: 'test'
    })
    const continued = (await service.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    expect(continued).toMatchObject({ mode: 'planning', status: 'completed', planReady: false })
    expect(continued.messages).toHaveLength(planned.messages.length)
    service.setAgentEventSink(null)
  })

  it.each(['auto', 'manual'] as const)(
    'switches to %s and sends the fixed implementation request',
    async (decision) => {
      mocks.responsesCreate
        .mockResolvedValueOnce({
          output_text: '<proposed_plan># Final plan</proposed_plan>',
          output: [],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
        })
        .mockResolvedValueOnce({
          output_text: 'Implemented.',
          output: [],
          usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 }
        })
      const service = await import('./agentService')
      const session = await service.createAgentSession({
        aiProvider: 'openai',
        openaiApiKey: 'test',
        selectedAiModel: 'gpt-5.6-luna'
      })
      await service.updateAgentSession(session.id, { mode: 'planning' }, 'openai')
      let completionCount = 0
      let resolveFirstCompletion: (() => void) | undefined
      let resolveSecondCompletion: (() => void) | undefined
      const firstCompletion = new Promise<void>((resolve) => (resolveFirstCompletion = resolve))
      const secondCompletion = new Promise<void>((resolve) => (resolveSecondCompletion = resolve))
      service.setAgentEventSink((event) => {
        if (event.type !== 'done' || event.sessionId !== session.id) return
        completionCount += 1
        if (completionCount === 1) resolveFirstCompletion?.()
        if (completionCount === 2) resolveSecondCompletion?.()
      })

      await service.runAgentSession(session.id, 'Plan this change', {
        aiProvider: 'openai',
        openaiApiKey: 'test'
      })
      await firstCompletion
      await service.resolveAgentPlan(session.id, decision, {
        aiProvider: 'openai',
        openaiApiKey: 'test'
      })
      await secondCompletion

      const implemented = (await service.loadAgentSessions()).sessions.find(
        (item) => item.id === session.id
      )!
      expect(implemented).toMatchObject({ mode: decision, status: 'completed', planReady: false })
      expect(
        implemented.messages.filter((message) => message.role === 'user').at(-1)?.content
      ).toBe('Implement the plan.')
      service.setAgentEventSink(null)
    }
  )

  it('persists the resolved target label on tool calls', async () => {
    mocks.agentToolTargetLabel.mockReturnValueOnce('ping')
    mocks.executeReadTool.mockResolvedValue({ resource: { command: 'ping' }, revision: 'abc123' })
    mocks.responsesCreate
      .mockResolvedValueOnce({
        output_text: '',
        output: [{
          type: 'function_call', call_id: 'call_read', name: 'read_command',
          arguments: '{"id":"command-1"}'
        }],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 }
      })
      .mockResolvedValueOnce({
        output_text: 'Read the command.',
        output: [],
        usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 }
      })

    const service = await import('./agentService')
    const session = await service.createAgentSession({
      aiProvider: 'openai', openaiApiKey: 'test', selectedAiModel: 'gpt-5.6-luna'
    })
    const completed = new Promise<void>((resolve) => {
      service.setAgentEventSink((event) => {
        if (event.type === 'done' && event.sessionId === session.id) resolve()
      })
    })

    await service.runAgentSession(session.id, 'Read ping', {
      aiProvider: 'openai', openaiApiKey: 'test'
    })
    await completed
    const stored = (await service.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    const call = stored.messages.flatMap((message) => message.toolCalls || [])[0]

    expect(mocks.agentToolTargetLabel).toHaveBeenCalledWith('read_command', { id: 'command-1' })
    expect(call).toMatchObject({ name: 'read_command', targetLabel: 'ping', status: 'completed' })
    service.setAgentEventSink(null)
  })

  it('remembers complete model defaults independently for each provider', async () => {
    const service = await import('./agentService')
    const openAiSession = await service.createAgentSession({
      aiProvider: 'openai',
      openaiApiKey: 'test',
      selectedOpenAiModel: 'gpt-initial'
    })

    expect(openAiSession).toMatchObject({ model: 'gpt-initial', reasoningEffort: 'none' })

    await service.updateAgentSession(openAiSession.id, { reasoningEffort: 'low' }, 'openai')
    await service.updateAgentSession(openAiSession.id, { model: 'gpt-5.6-sol' }, 'openai')
    await service.updateAgentSession(openAiSession.id, { title: 'Renamed session' }, 'openai')

    const nextOpenAiSession = await service.createAgentSession({
      aiProvider: 'openai',
      openaiApiKey: 'test',
      selectedOpenAiModel: 'gpt-chat-setting'
    })
    expect(nextOpenAiSession).toMatchObject({ model: 'gpt-5.6-sol', reasoningEffort: 'low' })

    const openRouterSession = await service.createAgentSession({
      aiProvider: 'openrouter',
      openaiApiKey: 'moderation-test',
      openrouterApiKey: 'test',
      selectedOpenRouterModel: 'openai/router-initial'
    })
    expect(openRouterSession).toMatchObject({
      model: 'openai/router-initial',
      reasoningEffort: 'none'
    })

    await service.updateAgentSession(
      openRouterSession.id,
      { model: 'anthropic/router-agent', reasoningEffort: 'high' },
      'openrouter'
    )
    await service.deleteAgentSession(openRouterSession.id)

    const nextOpenRouterSession = await service.createAgentSession({
      aiProvider: 'openrouter',
      openaiApiKey: 'moderation-test',
      openrouterApiKey: 'test',
      selectedOpenRouterModel: 'openai/router-chat-setting'
    })
    expect(nextOpenRouterSession).toMatchObject({
      model: 'anthropic/router-agent',
      reasoningEffort: 'high'
    })

    const stored = await service.loadAgentSessions()
    expect(stored.modelDefaultsByProvider).toEqual({
      openai: { model: 'gpt-5.6-sol', reasoningEffort: 'low' },
      openrouter: { model: 'anthropic/router-agent', reasoningEffort: 'high' }
    })
  })

  it('migrates agent session data without remembered model defaults', async () => {
    mocks.readFile.mockResolvedValueOnce(JSON.stringify({ sessions: [], activeSessionId: null }))
    const service = await import('./agentService')

    await expect(service.loadAgentSessions()).resolves.toEqual({
      sessions: [],
      activeSessionId: null,
      modelDefaultsByProvider: {}
    })
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('agent-sessions.json.tmp'),
      expect.stringContaining('"modelDefaultsByProvider": {}')
    )
  })

  it('maps OpenRouter prompt and completion token usage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Done', tool_calls: [] } }],
        usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 }
      })
    })))
    const { executeAgentProviderTurn } = await import('./agentService')
    const session = {
      id: 'session_openrouter', model: 'openai/gpt-5', reasoningEffort: 'none'
    } as any

    const turn = await executeAgentProviderTurn(
      { aiProvider: 'openrouter', openaiApiKey: 'moderation-test', openrouterApiKey: 'test' },
      session,
      [{ role: 'user', content: 'Hello' }],
      [],
      new AbortController().signal
    )

    expect(turn.inputTokenCount).toBe(50)
    expect(turn.outputTokenCount).toBe(8)
    expect(turn.tokenCount).toBe(58)
  })
})
