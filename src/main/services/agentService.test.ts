import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  responsesCreate: vi.fn(),
  chatCreate: vi.fn()
}))

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => 'C:\\tmp') } }))

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
  executeReadTool: vi.fn(),
  prepareMutation: vi.fn()
}))

describe('OpenAI agent provider adapter', () => {
  beforeEach(() => vi.clearAllMocks())

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
      usage: { total_tokens: 42 }
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
    expect(turn.tokenCount).toBe(42)
  })
})
