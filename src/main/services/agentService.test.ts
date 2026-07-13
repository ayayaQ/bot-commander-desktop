import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  chatCreate: vi.fn(),
  executeReadTool: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:\\tmp') } }))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }),
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
  agentToolDefinitions: [],
  mutationToolNames: new Set(),
  commitMutation: vi.fn(),
  executeReadTool: mocks.executeReadTool,
  prepareMutation: vi.fn()
}))

describe('OpenAI agent provider adapter', () => {
  beforeEach(() => vi.clearAllMocks())
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
    service.setAgentEventSink(null)
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
