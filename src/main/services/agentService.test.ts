import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  executeReadTool: vi.fn(),
  prepareMutation: vi.fn(),
  commitMutation: vi.fn(),
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

vi.mock('./agentTools', () => ({
  agentToolTargetLabel: mocks.agentToolTargetLabel,
  agentToolDefinitions: [
    'read_bot_state',
    'search_documentation',
    'read_command',
    'edit_command'
  ].map((name) => ({
    type: 'function',
    function: { name, description: name, parameters: { type: 'object', properties: {} } }
  })),
  mutationToolNames: new Set(['edit_command']),
  commitMutation: mocks.commitMutation,
  executeReadTool: mocks.executeReadTool,
  prepareMutation: mocks.prepareMutation
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

describe('desktop agent service shared-provider integration', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.responsesCreate.mockReset()
    mocks.executeReadTool.mockReset()
    mocks.prepareMutation.mockReset()
    mocks.commitMutation.mockReset()
    // Fake HTTP transport only. Keep request/response fixtures independent of SDK internals.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses') {
          throw new Error('Unexpected provider URL in fake transport')
        }
        const request = JSON.parse(init!.body as string)
        const response = {
          status: 'completed',
          ...(await mocks.responsesCreate(request, { signal: init!.signal }))
        }
        if (request.stream) {
          return new Response(
            'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        }
        return new Response(JSON.stringify(response))
      })
    )
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.memories = []
    mocks.prepareMutation.mockResolvedValue({
      name: 'edit_command',
      arguments: {},
      before: { command: 'old' },
      after: { command: 'new' },
      target: { type: 'command', id: 'c1' }
    })
    mocks.commitMutation.mockResolvedValue({ success: true, saved: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('uses the shared OpenAI provider with session reasoning and function tools', async () => {
    mocks.responsesCreate.mockResolvedValue({
      output_text: '',
      output: [
        {
          type: 'function_call',
          id: 'item_1',
          call_id: 'call_1',
          name: 'read_bot_state',
          arguments: '{}',
          status: 'completed'
        }
      ],
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
    const tools = [
      {
        name: 'read_bot_state',
        description: 'Read bot state',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    ] as any

    const turn = await executeAgentProviderTurn(
      { aiProvider: 'openai', openaiApiKey: 'test' },
      session,
      [{ kind: 'message', role: 'user', content: 'Inspect state' }],
      tools,
      new AbortController().signal
    )

    expect(mocks.responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5.6-luna',
        reasoning: { effort: 'low' },
        tools: [
          expect.objectContaining({
            type: 'function',
            name: 'read_bot_state',
            strict: false
          })
        ]
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'read_bot_state', arguments: {} }])
    expect(turn.usage?.inputTokens).toBe(30)
    expect(turn.usage?.outputTokens).toBe(12)
    expect(turn.usage?.totalTokens).toBe(42)
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
        output: [
          {
            type: 'function_call',
            call_id: 'call_docs',
            name: 'search_documentation',
            arguments: '{"query":"$set"}'
          }
        ],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      })
      .mockResolvedValueOnce({
        output_text: 'Created the command.',
        output: [],
        usage: { input_tokens: 180, output_tokens: 10, total_tokens: 190 }
      })

    const service = await import('./agentService')
    const session = await service.createAgentSession({
      aiProvider: 'openai',
      openaiApiKey: 'test',
      selectedAiModel: 'gpt-5.6-luna'
    })
    const completed = new Promise<void>((resolve) => {
      service.setAgentEventSink((event) => {
        if (event.type === 'done' && event.sessionId === session.id) resolve()
      })
    })

    await service.runAgentSession(session.id, 'Create a stateful command', {
      aiProvider: 'openai',
      openaiApiKey: 'test'
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
        output: [
          {
            type: 'function_call',
            call_id: 'call_read',
            name: 'read_command',
            arguments: '{"id":"command-1"}'
          }
        ],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 }
      })
      .mockResolvedValueOnce({
        output_text: 'Read the command.',
        output: [],
        usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 }
      })

    const service = await import('./agentService')
    const session = await service.createAgentSession({
      aiProvider: 'openai',
      openaiApiKey: 'test',
      selectedAiModel: 'gpt-5.6-luna'
    })
    const completed = new Promise<void>((resolve) => {
      service.setAgentEventSink((event) => {
        if (event.type === 'done' && event.sessionId === session.id) resolve()
      })
    })

    await service.runAgentSession(session.id, 'Read ping', {
      aiProvider: 'openai',
      openaiApiKey: 'test'
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
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'Done', tool_calls: [] } }],
              usage: { prompt_tokens: 50, completion_tokens: 8, total_tokens: 58 }
            })
          )
      )
    )
    const { executeAgentProviderTurn } = await import('./agentService')
    const session = {
      id: 'session_openrouter',
      model: 'openai/gpt-5',
      reasoningEffort: 'none'
    } as any

    const turn = await executeAgentProviderTurn(
      { aiProvider: 'openrouter', openaiApiKey: 'moderation-test', openrouterApiKey: 'test' },
      session,
      [{ kind: 'message', role: 'user', content: 'Hello' }],
      [],
      new AbortController().signal
    )

    expect(turn.usage?.inputTokens).toBe(50)
    expect(turn.usage?.outputTokens).toBe(8)
    expect(turn.usage?.totalTokens).toBe(58)
  })

  it('retains matched tool calls/results and native reasoning across user turns and reload', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' }
    mocks.executeReadTool.mockResolvedValue({ revision: 'r1', value: 3 })
    mocks.responsesCreate
      .mockResolvedValueOnce({
        output_text: 'Checking',
        output: [
          reasoning,
          {
            type: 'function_call',
            call_id: 'call_history',
            name: 'read_bot_state',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({ output_text: 'Found 3', output: [] })
      .mockResolvedValueOnce({ output_text: 'Still available', output: [] })
    let service = await import('./agentService')
    const settings = {
      aiProvider: 'openai' as const,
      openaiApiKey: 'test',
      selectedAiModel: 'gpt-test'
    }
    const session = await service.createAgentSession(settings)
    const first = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'done') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Inspect', settings)
    await first
    const firstStored = (await service.loadAgentSessions()).sessions[0]
    expect(firstStored.history?.map((entry) => entry.kind)).toEqual([
      'message',
      'assistant',
      'tool_result',
      'assistant'
    ])
    const saved = mocks.writeFile.mock.calls.at(-1)![1]
    vi.resetModules()
    mocks.readFile.mockResolvedValueOnce(saved)
    service = await import('./agentService')
    const second = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'done') resolve()
      })
    )
    await service.runAgentSession(session.id, 'What did you find?', settings)
    await second
    const input = mocks.responsesCreate.mock.calls[2][0].input
    expect(input).toContainEqual(reasoning)
    expect(input).toContainEqual(
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_history',
        name: 'read_bot_state'
      })
    )
    expect(input).toContainEqual({
      type: 'function_call_output',
      call_id: 'call_history',
      output: JSON.stringify({ revision: 'r1', value: 3 })
    })
    expect(mocks.executeReadTool).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    'resolves immediate manual approval %s without losing the resolver',
    async (approved) => {
      mocks.responsesCreate
        .mockResolvedValueOnce({
          output_text: '',
          output: [
            { type: 'function_call', call_id: 'call_manual', name: 'edit_command', arguments: '{}' }
          ]
        })
        .mockResolvedValueOnce({ output_text: 'Done', output: [] })
      const service = await import('./agentService')
      const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
      const session = await service.createAgentSession(settings)
      let resolution: Promise<boolean> | undefined
      const done = new Promise<void>((resolve) =>
        service.setAgentEventSink((event) => {
          if (event.type === 'approval')
            resolution = service.resolveAgentApproval(session.id, event.toolCall!.id, approved)
          if (event.type === 'done') resolve()
        })
      )
      await service.runAgentSession(session.id, 'Edit', settings)
      await done
      await expect(resolution).resolves.toBe(true)
      expect(mocks.commitMutation).toHaveBeenCalledTimes(approved ? 1 : 0)
      const call = (await service.loadAgentSessions()).sessions[0].messages.flatMap(
        (message) => message.toolCalls || []
      )[0]
      expect(call.status).toBe(approved ? 'completed' : 'rejected')
    }
  )

  it('keeps auto commits and planning execution-time mutation rejection in the host', async () => {
    mocks.responsesCreate
      .mockResolvedValueOnce({
        output_text: '',
        output: [
          { type: 'function_call', call_id: 'call_auto', name: 'edit_command', arguments: '{}' }
        ]
      })
      .mockResolvedValueOnce({ output_text: 'Done', output: [] })
      .mockResolvedValueOnce({
        output_text: '',
        output: [
          { type: 'function_call', call_id: 'call_planning', name: 'edit_command', arguments: '{}' }
        ]
      })
      .mockResolvedValueOnce({ output_text: 'Cannot mutate while planning', output: [] })
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const auto = await service.createAgentSession(settings)
    await service.updateAgentSession(auto.id, { mode: 'auto' }, 'openai')
    let resolveDone!: () => void
    let done = new Promise<void>((resolve) => (resolveDone = resolve))
    service.setAgentEventSink((event) => {
      if (event.type === 'done') resolveDone()
    })
    await service.runAgentSession(auto.id, 'Edit', settings)
    await done
    expect(mocks.commitMutation).toHaveBeenCalledTimes(1)
    const planning = await service.createAgentSession(settings)
    await service.updateAgentSession(planning.id, { mode: 'planning' }, 'openai')
    done = new Promise<void>((resolve) => (resolveDone = resolve))
    await service.runAgentSession(planning.id, 'Inspect', settings)
    await done
    expect(mocks.commitMutation).toHaveBeenCalledTimes(1)
    expect(mocks.prepareMutation).toHaveBeenCalledTimes(1)
    expect(
      mocks.responsesCreate.mock.calls[2][0].tools.map((tool: { name: string }) => tool.name)
    ).not.toContain('edit_command')
    expect(mocks.responsesCreate.mock.calls[3][0].input).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        call_id: 'call_planning',
        output: expect.stringContaining('unavailable_tool')
      })
    )
  })

  it('cancels an approval batch without committing or starting later tools/provider rounds', async () => {
    mocks.responsesCreate.mockResolvedValueOnce({
      output_text: '',
      output: [
        { type: 'function_call', call_id: 'call_cancel_1', name: 'edit_command', arguments: '{}' },
        { type: 'function_call', call_id: 'call_cancel_2', name: 'read_bot_state', arguments: '{}' }
      ]
    })
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'approval') expect(service.cancelAgentRun(session.id)).toBe(true)
        if (event.type === 'done') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Edit then read', settings)
    await done
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    expect(mocks.responsesCreate).toHaveBeenCalledTimes(1)
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('cancelled')
    expect(
      stored.history
        ?.filter((message) => message.kind === 'tool_result')
        .map((message) => message.callId)
    ).toEqual(['call_cancel_1', 'call_cancel_2'])
    expect(stored.messages.flatMap((message) => message.toolCalls || [])[0].status).toBe('error')
  })

  it('does not commit after cancellation during asynchronous mutation preparation', async () => {
    let prepared!: (value: unknown) => void
    mocks.prepareMutation.mockImplementation(() => new Promise((resolve) => (prepared = resolve)))
    mocks.responsesCreate.mockResolvedValueOnce({
      output_text: '',
      output: [
        { type: 'function_call', call_id: 'call_slow', name: 'edit_command', arguments: '{}' }
      ]
    })
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    await service.updateAgentSession(session.id, { mode: 'auto' }, 'openai')
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'done') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Edit', settings)
    await vi.waitFor(() => expect(mocks.prepareMutation).toHaveBeenCalledTimes(1))
    service.cancelAgentRun(session.id)
    await done
    prepared({ before: {}, after: {}, target: { type: 'command' } })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    expect((await service.loadAgentSessions()).sessions[0].status).toBe('cancelled')
  })

  it('ignores a late provider result after cancellation and allows a fresh run', async () => {
    let late!: (value: unknown) => void
    mocks.responsesCreate
      .mockImplementationOnce(() => new Promise((resolve) => (late = resolve)))
      .mockResolvedValueOnce({ output_text: 'Fresh answer', output: [] })
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const events: string[] = []
    let terminal!: () => void
    let done = new Promise<void>((resolve) => (terminal = resolve))
    service.setAgentEventSink((event) => {
      events.push(event.type)
      if (event.type === 'done') terminal()
    })
    await service.runAgentSession(session.id, 'First', settings)
    await vi.waitFor(() => expect(mocks.responsesCreate).toHaveBeenCalledTimes(1))
    service.cancelAgentRun(session.id)
    await done
    const count = events.length
    late({
      output_text: 'Late answer',
      output: [
        { type: 'function_call', call_id: 'late_call', name: 'read_bot_state', arguments: '{}' }
      ]
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toHaveLength(count)
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    done = new Promise<void>((resolve) => (terminal = resolve))
    await service.runAgentSession(session.id, 'Second', settings)
    await done
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('completed')
    expect(stored.messages.at(-1)?.content).toBe('Fresh answer')
    expect(JSON.stringify(stored.history)).not.toContain('late_call')
  })

  it('keeps bounded tool outputs valid JSON with explicit truncation', async () => {
    mocks.executeReadTool.mockResolvedValue({ huge: '\"'.repeat(30_000) })
    mocks.responsesCreate
      .mockResolvedValueOnce({
        output_text: '',
        output: [
          { type: 'function_call', call_id: 'large_call', name: 'read_bot_state', arguments: '{}' }
        ]
      })
      .mockResolvedValueOnce({ output_text: 'Done', output: [] })
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'done') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Read', settings)
    await done
    const result = mocks.responsesCreate.mock.calls[1][0].input.find(
      (item: { type?: string }) => item.type === 'function_call_output'
    ).output
    expect(result.length).toBeLessThanOrEqual(24_000)
    expect(JSON.parse(result)).toMatchObject({ truncated: true })
  })

  it('marks an approved but unfinished commit as interrupted with an unknown outcome', async () => {
    let finishCommit!: (value: unknown) => void
    mocks.commitMutation.mockImplementation(
      () => new Promise((resolve) => (finishCommit = resolve))
    )
    mocks.responsesCreate.mockResolvedValueOnce({
      output_text: '',
      output: [
        { type: 'function_call', call_id: 'commit_pending', name: 'edit_command', arguments: '{}' }
      ]
    })
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'approval')
          void service.resolveAgentApproval(session.id, event.toolCall!.id, true)
        if (event.type === 'done') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Edit', settings)
    await vi.waitFor(() => expect(mocks.commitMutation).toHaveBeenCalledTimes(1))
    service.cancelAgentRun(session.id)
    await done
    const stored = (await service.loadAgentSessions()).sessions[0]
    const tool = stored.messages.find((message) => message.role === 'tool')!
    expect(tool.toolCalls![0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('outcome may be unknown')
    })
    expect(JSON.parse(tool.content)).toMatchObject({ interrupted: true, outcome: 'unknown' })
    expect(stored.history?.find((message) => message.kind === 'tool_result')).toMatchObject({
      callId: 'commit_pending',
      isError: true
    })
    finishCommit({ success: true, saved: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      (await service.loadAgentSessions()).sessions[0].messages.find(
        (message) => message.role === 'tool'
      )!.toolCalls![0].status
    ).toBe('error')
  })

  it('recovers an approved pending commit on reload without replay or a rollback claim', async () => {
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        sessions: [
          {
            id: 'reload_pending',
            title: 'Interrupted',
            mode: 'manual',
            model: 'gpt-test',
            reasoningEffort: 'none',
            status: 'running',
            createdAt: '',
            updatedAt: '',
            tokenCount: 0,
            messages: [
              {
                id: 'm1',
                timestamp: '',
                role: 'tool',
                content: 'edit_command',
                toolCalls: [
                  {
                    id: 'reload_call',
                    name: 'edit_command',
                    arguments: {},
                    status: 'approved',
                    createdAt: ''
                  }
                ]
              }
            ],
            history: [
              {
                kind: 'assistant',
                content: '',
                toolCalls: [{ id: 'reload_call', name: 'edit_command', arguments: {} }]
              }
            ]
          }
        ],
        activeSessionId: 'reload_pending',
        modelDefaultsByProvider: {}
      })
    )
    const service = await import('./agentService')
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('interrupted')
    expect(stored.messages[0].toolCalls![0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('outcome may be unknown')
    })
    expect(JSON.parse(stored.messages[0].content)).toMatchObject({ outcome: 'unknown' })
    expect(stored.history?.at(-1)).toMatchObject({ kind: 'tool_result', isError: true })
    expect(mocks.commitMutation).not.toHaveBeenCalled()
  })

  it.each([
    [{ aiProvider: 'openai', openaiApiKey: '' }, 'OpenAI API key not configured'],
    [
      { aiProvider: 'openrouter', openaiApiKey: 'moderation-key' },
      'OpenRouter API key not configured'
    ],
    [
      { aiProvider: 'openrouter', openaiApiKey: '', openrouterApiKey: 'router-key' },
      'OpenAI API key is required to moderate OpenRouter responses'
    ]
  ] as const)(
    'keeps app configuration and moderation guards before creating a run',
    async (settings, error) => {
      const service = await import('./agentService')
      const session = await service.createAgentSession(settings)
      const events: unknown[] = []
      service.setAgentEventSink((event) => events.push(event))
      await expect(service.runAgentSession(session.id, 'Inspect', settings)).rejects.toThrow(error)
      expect(fetch).not.toHaveBeenCalled()
      expect(mocks.prepareMutation).not.toHaveBeenCalled()
      const stored = (await service.loadAgentSessions()).sessions[0]
      expect(stored).toMatchObject({ status: 'idle', messages: [], history: [] })
      expect(stored.activeRunId).toBeUndefined()
      expect(events).toEqual([])
    }
  )

  it('runs the shared OpenRouter transport with app policy satisfied and never sends the moderation key', async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'data: ' +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Router answer' },
                  finish_reason: null
                }
              ]
            }) +
            '\n\n' +
            'data: ' +
            JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
            '\n\n' +
            'data: [DONE]\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
    )
    vi.stubGlobal('fetch', fetchMock)
    const service = await import('./agentService')
    const settings = {
      aiProvider: 'openrouter' as const,
      openaiApiKey: 'private-moderation-only',
      openrouterApiKey: 'router-key',
      selectedOpenRouterModel: 'provider/router-model'
    }
    const session = await service.createAgentSession(settings)
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'done' || event.type === 'error') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Inspect', settings)
    await done
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('completed')
    expect(stored.messages.at(-1)?.content).toBe('Router answer')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('private-moderation-only')
    expect(JSON.stringify(stored)).not.toContain('private-moderation-only')
  })

  it('surfaces visible progress and clears it after validation without persisting partial output', async () => {
    const response = { status: 'completed', output: [], output_text: 'Accepted final answer' }
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: ' +
              JSON.stringify({
                type: 'response.output_text.delta',
                delta: 'Partial visible answer'
              }) +
              '\n\n' +
              'data: ' +
              JSON.stringify({ type: 'response.completed', response }) +
              '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
    )
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const events: Array<{ type: string; runId?: string; delta?: string }> = []
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        events.push(event)
        if (event.type === 'done' || event.type === 'error') resolve()
      })
    )
    const { runId } = await service.runAgentSession(session.id, 'Inspect', settings)
    await done
    expect(events).toContainEqual({
      sessionId: session.id,
      runId,
      type: 'text_delta',
      delta: 'Partial visible answer'
    })
    expect(events).toContainEqual({ sessionId: session.id, runId, type: 'progress_reset' })
    expect(events.findIndex((event) => event.type === 'progress_reset')).toBeGreaterThan(
      events.findIndex((event) => event.type === 'text_delta')
    )
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('completed')
    expect(stored.messages.at(-1)?.content).toBe('Accepted final answer')
    expect(JSON.stringify(stored)).not.toContain('Partial visible answer')
    expect(
      mocks.writeFile.mock.calls.every((call) => !call[1].includes('Partial visible answer'))
    ).toBe(true)
  })

  it('rejects malformed streamed completion before any tool or history acceptance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: ' +
              JSON.stringify({ type: 'response.output_text.delta', delta: 'Unaccepted partial' }) +
              '\n\n' +
              'data: ' +
              JSON.stringify({
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output: [
                    {
                      type: 'function_call',
                      call_id: 'malformed_call',
                      name: 'edit_command',
                      arguments: '[]'
                    }
                  ]
                }
              }) +
              '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
    )
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'done' || event.type === 'error') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Edit', settings)
    await done
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    expect(mocks.prepareMutation).not.toHaveBeenCalled()
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('error')
    expect(stored.history?.map((entry) => entry.kind)).toEqual(['message'])
    expect(JSON.stringify(stored)).not.toContain('Unaccepted partial')
    expect(JSON.stringify(stored.history)).not.toContain('malformed_call')
  })

  it('cancels during streamed progress without accepting the terminal response or tools', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            'data: ' +
              JSON.stringify({ type: 'response.output_text.delta', delta: 'Cancel this partial' }) +
              '\n\n' +
              'data: ' +
              JSON.stringify({
                type: 'response.completed',
                response: {
                  status: 'completed',
                  output_text: 'Late answer',
                  output: [
                    {
                      type: 'function_call',
                      call_id: 'late_stream_call',
                      name: 'read_bot_state',
                      arguments: '{}'
                    }
                  ]
                }
              }) +
              '\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
      )
    )
    const service = await import('./agentService')
    const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
    const session = await service.createAgentSession(settings)
    const done = new Promise<void>((resolve) =>
      service.setAgentEventSink((event) => {
        if (event.type === 'text_delta') expect(service.cancelAgentRun(session.id)).toBe(true)
        if (event.type === 'done' || event.type === 'error') resolve()
      })
    )
    await service.runAgentSession(session.id, 'Inspect', settings)
    await done
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    const stored = (await service.loadAgentSessions()).sessions[0]
    expect(stored.status).toBe('cancelled')
    expect(stored.history?.map((entry) => entry.kind)).toEqual(['message'])
    expect(JSON.stringify(stored)).not.toContain('Cancel this partial')
    expect(JSON.stringify(stored.history)).not.toContain('late_stream_call')
  })

  it.each([
    [
      'missing native-state provider',
      [{ kind: 'assistant', content: 'Old response', toolCalls: [], providerState: { items: [] } }]
    ],
    ['null canonical history', null],
    ['object canonical history', { damaged: 'keep this record' }],
    ['string canonical history', 'Original damaged transcript'],
    ['malformed array entry', [null]],
    [
      'unmatched canonical tool result',
      [{ kind: 'tool_result', callId: 'orphan', name: 'edit_command', content: 'Original result' }]
    ]
  ])(
    'isolates %s while preserving damaged data and healthy-session operations',
    async (_case, history) => {
      const damaged = {
        id: 'damaged_history',
        title: 'Damaged session',
        mode: 'planning',
        model: 'gpt-test',
        reasoningEffort: 'none',
        status: 'waiting_approval',
        activeRunId: 'old_run',
        planReady: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        tokenCount: 7,
        recoveryMarker: { preserve: 'extra original metadata' },
        messages: [
          {
            id: 'original_display',
            timestamp: '',
            role: 'tool',
            content: 'edit_command',
            toolCalls: [
              {
                id: 'original_approval',
                name: 'edit_command',
                arguments: { revision: 'r1' },
                status: 'approved',
                createdAt: ''
              }
            ]
          }
        ],
        history
      }
      const healthy = {
        ...damaged,
        id: 'healthy_history',
        title: 'Healthy session',
        mode: 'manual',
        status: 'idle',
        activeRunId: undefined,
        planReady: false,
        tokenCount: 0,
        messages: [],
        history: []
      }
      mocks.readFile.mockResolvedValueOnce(
        JSON.stringify({
          sessions: [damaged, healthy],
          activeSessionId: damaged.id,
          modelDefaultsByProvider: {}
        })
      )
      let service = await import('./agentService')
      const settings = { aiProvider: 'openai' as const, openaiApiKey: 'test' }
      const loaded = await service.loadAgentSessions()
      expect(loaded.sessions.map((session) => session.id)).toEqual([damaged.id, healthy.id])
      expect(loaded.activeSessionId).toBe(damaged.id)
      const preserved = loaded.sessions[0]
      expect(preserved).toMatchObject({ status: 'error', planReady: false, tokenCount: 7 })
      expect(preserved.activeRunId).toBeUndefined()
      expect(preserved.error).toContain('Agent history recovery failed:')
      expect(preserved.error).toContain('Saved history was preserved')
      expect(preserved.history).toEqual(history)
      expect(preserved.messages).toEqual(damaged.messages)

      await expect(service.runAgentSession(damaged.id, 'Must not run', settings)).rejects.toThrow(
        'Agent history recovery failed'
      )
      await expect(service.resolveAgentPlan(damaged.id, 'auto', settings)).rejects.toThrow(
        'completed plan'
      )
      expect(await service.resolveAgentApproval(damaged.id, 'original_approval', true)).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
      expect(mocks.executeReadTool).not.toHaveBeenCalled()
      expect(mocks.prepareMutation).not.toHaveBeenCalled()
      expect(mocks.commitMutation).not.toHaveBeenCalled()

      // Metadata edits cannot clear quarantine or replace the canonical transcript.
      await service.updateAgentSession(
        damaged.id,
        { title: 'Still recoverable', model: 'gpt-other' },
        'openai'
      )
      await expect(service.runAgentSession(damaged.id, 'Still blocked', settings)).rejects.toThrow(
        'Agent history recovery failed'
      )
      const created = await service.createAgentSession(settings)
      expect(created.status).toBe('idle')
      expect(await service.deleteAgentSession(created.id)).toBe(true)

      mocks.responsesCreate.mockResolvedValueOnce({ output_text: 'Healthy answer', output: [] })
      const done = new Promise<void>((resolve) =>
        service.setAgentEventSink((event) => {
          if ((event.type === 'done' || event.type === 'error') && event.sessionId === healthy.id)
            resolve()
        })
      )
      await service.runAgentSession(healthy.id, 'Inspect healthy session', settings)
      await done
      const afterRun = await service.loadAgentSessions()
      expect(afterRun.sessions.find((session) => session.id === healthy.id)).toMatchObject({
        status: 'completed'
      })
      expect(
        afterRun.sessions.find((session) => session.id === healthy.id)?.messages.at(-1)?.content
      ).toBe('Healthy answer')
      expect(mocks.responsesCreate).toHaveBeenCalledOnce()
      expect(mocks.commitMutation).not.toHaveBeenCalled()
      for (const [, contents] of mocks.writeFile.mock.calls) {
        const record = JSON.parse(contents).sessions.find((session) => session.id === damaged.id)
        expect(record.history).toEqual(history)
        expect(record.messages).toEqual(damaged.messages)
        expect(record.recoveryMarker).toEqual(damaged.recoveryMarker)
      }

      // Restarting preserves the damaged record and re-establishes its execution guard.
      const saved = mocks.writeFile.mock.calls.at(-1)![1]
      vi.resetModules()
      mocks.readFile.mockResolvedValueOnce(saved)
      vi.mocked(fetch).mockClear()
      service = await import('./agentService')
      const reloaded = await service.loadAgentSessions()
      const stillDamaged = reloaded.sessions.find((session) => session.id === damaged.id)!
      expect(stillDamaged.history).toEqual(history)
      expect(stillDamaged.messages).toEqual(damaged.messages)
      expect(stillDamaged.status).toBe('error')
      await expect(
        service.runAgentSession(damaged.id, 'No replay on restart', settings)
      ).rejects.toThrow('Agent history recovery failed')
      expect(fetch).not.toHaveBeenCalled()
      expect(await service.deleteAgentSession(healthy.id)).toBe(true)
      expect((await service.loadAgentSessions()).sessions.map((session) => session.id)).toEqual([
        damaged.id
      ])
    }
  )

  it('continues migrating a truly absent legacy history alongside a damaged existing field', async () => {
    const common = {
      title: 'Legacy session',
      mode: 'manual',
      model: 'gpt-test',
      reasoningEffort: 'none',
      status: 'idle',
      planReady: false,
      tokenCount: 0,
      createdAt: '',
      updatedAt: '',
      messages: [{ id: 'display_request', timestamp: '', role: 'user', content: 'Legacy request' }]
    }
    mocks.readFile.mockResolvedValueOnce(
      JSON.stringify({
        sessions: [
          { ...common, id: 'damaged_non_array', history: { preserve: true } },
          { ...common, id: 'legacy_absent' }
        ],
        activeSessionId: 'legacy_absent',
        modelDefaultsByProvider: {}
      })
    )
    const service = await import('./agentService')
    const loaded = await service.loadAgentSessions()
    expect(loaded.sessions[0]).toMatchObject({ status: 'error', history: { preserve: true } })
    expect(loaded.sessions[1]).toMatchObject({
      status: 'idle',
      history: [{ kind: 'message', role: 'user', content: 'Legacy request' }]
    })
    const persisted = JSON.parse(mocks.writeFile.mock.calls.at(-1)![1])
    expect(persisted.sessions[0].history).toEqual({ preserve: true })
    expect(persisted.sessions[1].history).toEqual(loaded.sessions[1].history)
  })
})
