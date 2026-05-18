import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  openAiListMock: vi.fn(),
  chatCreateMock: vi.fn(),
  moderationCreateMock: vi.fn()
}))

vi.mock('openai', () => ({
  default: vi.fn(function OpenAI() {
    return {
      models: { list: mocks.openAiListMock },
      chat: { completions: { create: mocks.chatCreateMock } },
      moderations: { create: mocks.moderationCreateMock }
    }
  })
}))

describe('aiProviderService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
  })

  it('validates provider-specific API key requirements', async () => {
    const { validateAiConfiguration } = await import('./aiProviderService')

    expect(validateAiConfiguration({ aiProvider: 'openai', openaiApiKey: '' })).toContain(
      'OpenAI API key not configured'
    )
    expect(
      validateAiConfiguration({
        aiProvider: 'openrouter',
        openaiApiKey: '',
        openrouterApiKey: 'or-key'
      })
    ).toContain('OpenAI API key is required')
    expect(
      validateAiConfiguration({
        aiProvider: 'openrouter',
        openaiApiKey: 'oa-key',
        openrouterApiKey: 'or-key'
      })
    ).toBeNull()
  })

  it('filters OpenAI model list to text generation models with reasoning metadata', async () => {
    const { fetchAiModels } = await import('./aiProviderService')
    mocks.openAiListMock.mockResolvedValue({
      data: [
        { id: 'tts-1' },
        { id: 'gpt-image-1' },
        { id: 'gpt-5.4-nano' },
        { id: 'gpt-4.1-mini' }
      ]
    })

    const models = await fetchAiModels('openai', 'oa-key')

    expect(models.map((model) => model.id)).toEqual(['gpt-5.4-nano', 'gpt-4.1-mini'])
    expect(models[0]).toMatchObject({
      supportsReasoning: true,
      supportsStructuredOutputs: true
    })
    expect(models[1].supportsReasoning).toBe(false)
  })

  it('sends OpenRouter chat requests with structured output and reasoning options', async () => {
    const { createAiChatCompletion } = await import('./aiProviderService')
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { total_tokens: 42 }
      })
    } as Response)

    const result = await createAiChatCompletion(
      { aiProvider: 'openrouter', openaiApiKey: 'oa-key', openrouterApiKey: 'or-key' },
      [{ role: 'user', content: 'Hello' }],
      'provider/model',
      {
        responseFormat: { type: 'json_schema' },
        requireStructuredOutputs: true,
        reasoningEffort: 'low'
      }
    )

    expect(result).toEqual({ content: '{"ok":true}', tokenCount: 42 })
    const request = fetchMock.mock.calls[0]
    expect(request[0]).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(JSON.parse((request[1] as RequestInit).body as string)).toMatchObject({
      model: 'provider/model',
      response_format: { type: 'json_schema' },
      reasoning: { effort: 'low', exclude: true },
      provider: { require_parameters: true }
    })
  })

  it('formats OpenRouter API failures with metadata', async () => {
    const { createAiChatCompletion } = await import('./aiProviderService')
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: () => '12' },
      text: async () =>
        JSON.stringify({
          error: {
            code: 'rate_limited',
            message: 'Too many requests',
            metadata: { provider_name: 'Provider A', model_slug: 'model-a' }
          }
        })
    } as unknown as Response)

    await expect(
      createAiChatCompletion(
        { aiProvider: 'openrouter', openaiApiKey: 'oa-key', openrouterApiKey: 'or-key' },
        [{ role: 'user', content: 'Hello' }],
        'provider/model'
      )
    ).rejects.toThrow(
      'Too many requests (Code: rate_limited; Retry after: 12s; Provider: Provider A; Model: model-a)'
    )
  })
})
