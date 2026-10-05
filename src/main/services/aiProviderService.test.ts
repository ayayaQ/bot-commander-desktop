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
      data: [{ id: 'tts-1' }, { id: 'gpt-image-1' }, { id: 'gpt-5.4-nano' }, { id: 'gpt-4.1-mini' }]
    })

    const models = await fetchAiModels('openai', 'oa-key')

    expect(models.map((model) => model.id)).toEqual(['gpt-5.4-nano', 'gpt-4.1-mini'])
    expect(models[0].capabilities).toMatchObject({
      protocol: 'chat-completions',
      reasoning: { support: 'supported', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }
    })
    expect(models[0].supportsStructuredOutputs).toBeUndefined()
    expect(models[1].capabilities.reasoning.support).toBe('unsupported')
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

    const { modelCapabilityCatalog } = await import('./modelCapabilityService')
    const generation = modelCapabilityCatalog.begin('openrouter', 'or-key')
    modelCapabilityCatalog.complete('openrouter', 'or-key', generation, [
      {
        id: 'provider/model',
        supported_parameters: ['reasoning'],
        reasoning: { mandatory: false, supported_efforts: ['low'] }
      }
    ])
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
  it('keeps unknown/future exact IDs selectable without prefix-based assertions', async () => {
    const { parseAiModelCatalog } = await import('./aiProviderService')
    const rows = parseAiModelCatalog('openai', 'chat-completions', [
      { id: 'gpt-5-next-unverified' },
      { id: 'custom/name' },
      { id: 'gpt-5.4-nano-extra' },
      { id: ' gpt-5' },
      { id: 'tts-1' }
    ])
    expect(rows.map((row) => row.id)).toEqual(
      expect.arrayContaining(['gpt-5-next-unverified', 'custom/name', 'gpt-5.4-nano-extra'])
    )
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.capabilities.reasoning.support === 'unknown')).toBe(true)
    expect(rows.every((row) => row.capabilities.tools === 'unknown')).toBe(true)
  })

  it('uses Responses for agent catalogs and preserves the existing $chat endpoint policy', async () => {
    const { fetchAiModels } = await import('./aiProviderService')
    mocks.openAiListMock.mockResolvedValue({
      data: [
        { id: 'gpt-5-pro' },
        { id: 'o3' },
        { id: 'o3-pro' },
        { id: 'gpt-5.4-nano' },
        { id: 'tts-1' }
      ]
    })
    const agent = await fetchAiModels('openai', 'oa-key', 'responses')
    expect(agent.map((row) => row.id)).toEqual(
      expect.arrayContaining(['gpt-5-pro', 'o3-pro', 'o3', 'gpt-5.4-nano'])
    )
    expect(agent).toHaveLength(4)
    const chat = await fetchAiModels('openai', 'oa-key')
    expect(chat.map((row) => row.id)).toEqual(['o3', 'gpt-5.4-nano'])
    expect(chat.every((row) => row.capabilities.protocol === 'chat-completions')).toBe(true)
  })

  it('keeps incomplete/malformed OpenRouter capabilities unknown and filters proven non-text input', async () => {
    const { parseAiModelCatalog } = await import('./aiProviderService')
    const models = parseAiModelCatalog('openrouter', 'chat-completions', [
      { id: 'vendor/output-only', architecture: { output_modalities: ['text'] } },
      {
        id: 'vendor/malformed',
        supported_parameters: { tools: true },
        reasoning: { supported_efforts: 1 }
      },
      {
        id: 'vendor/transcriber',
        architecture: { input_modalities: ['audio'], output_modalities: ['text'] }
      }
    ])
    expect(models).toHaveLength(2)
    for (const model of models)
      expect(model.capabilities).toMatchObject({
        chat: 'unknown',
        tools: 'unknown',
        reasoning: { effortSelection: 'unknown', efforts: [] }
      })
  })

  it('rejects an externally edited unsupported effort before transport without rewriting settings', async () => {
    const { createAiChatCompletion } = await import('./aiProviderService')
    const saved = {
      aiProvider: 'openai' as const,
      openaiApiKey: 'oa-key',
      aiReasoningEffort: 'xhigh' as const
    }
    await expect(
      createAiChatCompletion(saved, [{ role: 'user', content: 'Hello' }], 'gpt-5', {
        reasoningEffort: saved.aiReasoningEffort
      })
    ).rejects.toThrow('Choose Provider default')
    expect(saved.aiReasoningEffort).toBe('xhigh')
    expect(mocks.chatCreateMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    mocks.chatCreateMock.mockResolvedValue({ choices: [{ message: { content: 'Done' } }] })
    await createAiChatCompletion(saved, [{ role: 'user', content: 'Hello' }], 'custom-unknown', {
      reasoningEffort: 'none'
    })
    expect(mocks.chatCreateMock.mock.calls[0][0]).not.toHaveProperty('reasoning_effort')
  })

  it('never echoes provider/catalog credentials on failure or in snapshots', async () => {
    const { fetchAiModels } = await import('./aiProviderService')
    mocks.openAiListMock.mockRejectedValue(new Error('Authorization: oa-key private provider body'))
    await expect(fetchAiModels('openai', 'oa-key')).rejects.not.toThrow('oa-key')
    mocks.openAiListMock.mockResolvedValue({ data: [{ id: 'gpt-5.4-nano', name: 'oa-key' }] })
    await expect(fetchAiModels('openai', 'oa-key')).rejects.toThrow(
      'invalid credential-bearing metadata'
    )
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'vendor/model', api_key: 'or-key', authorization: 'or-key' }]
        })
      )
    )
    const models = await fetchAiModels('openrouter', 'or-key')
    expect(JSON.stringify(models)).not.toContain('or-key')
    expect(JSON.stringify(models)).not.toContain('api_key')
  })

  it('rejects older catalog completions after key changes and keeps current account facts', async () => {
    const { fetchAiModels } = await import('./aiProviderService')
    const { modelCapabilityCatalog } = await import('./modelCapabilityService')
    let finishOld!: (value: Response) => void
    const oldResponse = new Promise<Response>((resolve) => {
      finishOld = resolve
    })
    vi.mocked(fetch)
      .mockImplementationOnce(() => oldResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              {
                id: 'vendor/current',
                supported_parameters: ['tools'],
                architecture: { input_modalities: ['text'], output_modalities: ['text'] }
              }
            ]
          })
        )
      )
    const old = fetchAiModels('openrouter', 'old-fixture-key')
    const rejected = expect(old).rejects.toThrow('superseded')
    const current = await fetchAiModels('openrouter', 'new-fixture-key')
    finishOld(
      new Response(
        JSON.stringify({ data: [{ id: 'vendor/old', supported_parameters: ['tools'] }] })
      )
    )
    await rejected
    expect(current.map((row) => row.id)).toEqual(['vendor/current'])
    expect(
      modelCapabilityCatalog.get('openrouter', 'old-fixture-key', 'chat-completions', 'vendor/old')
        .tools
    ).toBe('unknown')
    expect(
      modelCapabilityCatalog.get(
        'openrouter',
        'new-fixture-key',
        'chat-completions',
        'vendor/current'
      ).tools
    ).toBe('supported')
  })
  it('resolves documented selected IDs absent from any account catalog with no remote fetch', async () => {
    const { getSelectedModelCapabilities } = await import('./aiProviderService')
    const saved = { aiProvider: 'openai' as const, openaiApiKey: 'host-only-fixture-key' }
    const agent = getSelectedModelCapabilities(saved, 'gpt-5.4-nano', 'responses').capabilities
    const chat = getSelectedModelCapabilities(
      saved,
      'gpt-5.4-nano',
      'chat-completions'
    ).capabilities
    expect(agent).toMatchObject({
      protocol: 'responses',
      tools: 'supported',
      reasoning: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }
    })
    expect(chat).toMatchObject({
      protocol: 'chat-completions',
      chat: 'supported',
      reasoning: { efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }
    })
    expect(
      getSelectedModelCapabilities(saved, 'gpt-5.4-nano-future', 'responses').capabilities
    ).toMatchObject({
      tools: 'unknown',
      reasoning: { efforts: [] }
    })
    expect(mocks.openAiListMock).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
    expect(JSON.stringify(agent)).not.toContain('host-only-fixture-key')
  })
})
