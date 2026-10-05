import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryMessage, ProviderProgress, ToolDefinition } from '@ayayaq/vivi'
import type { AgentSession } from '../../shared/agentTypes'
import type { AiRuntimeSettings } from './aiProviderService'
import { modelCapabilityCatalog } from './modelCapabilityService'
import { createAgentProvider, executeAgentProviderTurn } from './agentProviderAdapter'

const settings: AiRuntimeSettings = { aiProvider: 'openai', openaiApiKey: 'fake-openai-key' }
const routerSettings: AiRuntimeSettings = {
  aiProvider: 'openrouter',
  openaiApiKey: '',
  openrouterApiKey: 'fake-router-key'
}
const session: Pick<AgentSession, 'model' | 'reasoningEffort'> = {
  model: 'gpt-5.4-nano',
  reasoningEffort: 'low'
}
const tools: ToolDefinition[] = [
  {
    name: 'read_bot_state',
    description: 'Read bot state',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
]
const messages: HistoryMessage[] = [
  { kind: 'message', role: 'system', content: 'Inspect carefully' },
  { kind: 'message', role: 'user', content: 'Inspect state' }
]
const fetchMock = vi.fn<typeof fetch>()

function run(runtime = settings, model = session, signal = new AbortController().signal) {
  return executeAgentProviderTurn(runtime, model, messages, tools, signal)
}

function request() {
  const [url, init] = fetchMock.mock.calls.at(-1)!
  return { url: String(url), init, body: JSON.parse(init!.body as string) }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify({ status: 'completed', output: [], output_text: 'Done' }))
  )
  vi.stubGlobal('fetch', fetchMock)
  const generation = modelCapabilityCatalog.begin('openrouter', routerSettings.openrouterApiKey)
  modelCapabilityCatalog.complete('openrouter', routerSettings.openrouterApiKey, generation, [
    {
      id: 'anthropic/session-model',
      supported_parameters: ['tools', 'reasoning'],
      reasoning: { mandatory: false, supported_efforts: ['low', 'medium', 'high'] },
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }
    },
    {
      id: session.model,
      supported_parameters: ['tools', 'reasoning'],
      reasoning: { mandatory: false, supported_efforts: ['low'] }
    }
  ])
})
afterEach(() => vi.unstubAllGlobals())

describe('desktop shared-provider settings bridge', () => {
  it('defaults to OpenAI and keeps the active session model instead of chat defaults', async () => {
    const original = structuredClone(messages)
    await run({ openaiApiKey: 'fake-openai-key', selectedOpenAiModel: 'gpt-chat-default' })
    const { url, init, body } = request()
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer fake-openai-key')
    expect(body).toMatchObject({
      model: 'gpt-5.4-nano',
      input: [
        { role: 'system', content: 'Inspect carefully' },
        { role: 'user', content: 'Inspect state' }
      ],
      tools: [{ type: 'function', ...tools[0], strict: false }],
      reasoning: { effort: 'low' },
      store: false
    })
    expect(messages).toEqual(original)
    expect(JSON.stringify(body)).not.toContain('fake-openai-key')
  })

  it('keeps OpenRouter independent of the app moderation key and supplies app attribution', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }]
        })
      )
    )
    await run(routerSettings, { model: 'anthropic/session-model', reasoningEffort: 'high' })
    const { url, init, body } = request()
    const headers = new Headers(init!.headers)
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(headers.get('Authorization')).toBe('Bearer fake-router-key')
    expect(headers.get('HTTP-Referer')).toBe('https://github.com/ayayaQ/bot-commander-desktop')
    expect(headers.get('X-Title') || headers.get('X-OpenRouter-Title')).toBe(
      'Bot Commander for Discord'
    )
    expect(body).toMatchObject({
      model: 'anthropic/session-model',
      messages: messages.map(({ kind: _, ...message }) => message),
      reasoning: { effort: 'high', exclude: false }
    })
    expect(JSON.stringify(body)).not.toContain('fake-router-key')
  })

  it.each(['openai', 'openrouter'] as const)(
    'preserves legacy %s none as provider-default reasoning, without sending disable',
    async (provider) => {
      if (provider === 'openrouter') {
        fetchMock.mockResolvedValue(
          new Response(
            JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] })
          )
        )
      }
      await run(provider === 'openai' ? settings : routerSettings, {
        ...session,
        reasoningEffort: 'none'
      })
      expect(request().body).not.toHaveProperty('reasoning')
    }
  )

  it.each(['minimal', 'low', 'medium', 'high', 'xhigh'] as const)(
    'sends the documented %s effort selection',
    async (reasoningEffort) => {
      await run(settings, {
        model: reasoningEffort === 'minimal' ? 'gpt-5' : 'gpt-5.4-nano',
        reasoningEffort
      })
      expect(request().body.reasoning).toEqual({ effort: reasoningEffort })
    }
  )

  it.each([
    [{ aiProvider: 'openai', openaiApiKey: '' }, 'OpenAI API key not configured'],
    [{ aiProvider: 'openai', openaiApiKey: '  ' }, 'OpenAI API key not configured'],
    [
      { aiProvider: 'openrouter', openaiApiKey: 'moderation-only' },
      'OpenRouter API key not configured'
    ],
    [
      { aiProvider: 'openrouter', openaiApiKey: '', openrouterApiKey: ' ' },
      'OpenRouter API key not configured'
    ]
  ] as const)(
    'checks only the selected provider key before transport',
    async (runtime, message) => {
      await expect(run(runtime)).rejects.toThrow(message)
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each(['openai', 'openrouter'] as const)(
    'maps the finite desktop 10-minute timeout to the %s transport',
    async (provider) => {
      if (provider === 'openrouter') {
        fetchMock.mockResolvedValue(
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: 'stop', message: { content: 'Done' } }]
            })
          )
        )
      }
      const timer = vi.spyOn(globalThis, 'setTimeout')
      try {
        await run(provider === 'openai' ? settings : routerSettings)
        expect(timer).toHaveBeenCalledWith(expect.any(Function), 600_000)
      } finally {
        timer.mockRestore()
      }
    }
  )

  it('forwards cancellation to the shared transport', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
      })
    })
    const pending = run(settings, session, controller.signal)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort(new Error('cancelled by desktop'))
    await expect(pending).rejects.toThrow()
    expect(request().init!.signal!.aborted).toBe(true)
  })

  it('forwards visible streaming progress without adding partial text to input history', async () => {
    const completed = {
      type: 'response.completed',
      response: { status: 'completed', output: [], output_text: 'Visible answer' }
    }
    fetchMock.mockResolvedValue(
      new Response(
        'data: ' +
          JSON.stringify({ type: 'response.output_text.delta', delta: 'Visible ' }) +
          '\n\n' +
          'data: ' +
          JSON.stringify(completed) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    )
    const original = structuredClone(messages)
    const progress: ProviderProgress[] = []
    const result = await createAgentProvider(settings, session, { stream: true }).generate(
      { messages, tools },
      new AbortController().signal,
      {
        onProgress: (event) => {
          progress.push(event)
        }
      }
    )
    expect(progress).toEqual([{ type: 'text_delta', text: 'Visible ' }])
    expect(result.content).toBe('Visible answer')
    expect(request().body.stream).toBe(true)
    expect(messages).toEqual(original)
  })
  it('maps explicit OpenAI disable separately from legacy provider-default omission', async () => {
    await run(settings, { model: 'gpt-5.1', reasoningEffort: 'disabled' })
    expect(request().body.reasoning).toEqual({ effort: 'none' })
    await run(settings, { model: 'gpt-5.1', reasoningEffort: 'none' })
    expect(request().body).not.toHaveProperty('reasoning')
  })

  it('supports optional OpenRouter disable without inventing an effort selector', async () => {
    const generation = modelCapabilityCatalog.begin('openrouter', routerSettings.openrouterApiKey)
    modelCapabilityCatalog.complete('openrouter', routerSettings.openrouterApiKey, generation, [
      {
        id: 'vendor/token-budget',
        supported_parameters: ['reasoning'],
        reasoning: { mandatory: false, supports_max_tokens: true }
      }
    ])
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] })
      )
    )
    await run(routerSettings, { model: 'vendor/token-budget', reasoningEffort: 'disabled' })
    expect(request().body.reasoning).toEqual({ enabled: false })
    expect(request().body).not.toHaveProperty('tools')
    await expect(
      run(routerSettings, { model: 'vendor/token-budget', reasoningEffort: 'high' })
    ).rejects.toThrow('unsupported')
  })

  it.each([
    ['gpt-5', 'disabled', 'unsupported'],
    ['gpt-5', 'xhigh', 'unsupported'],
    ['gpt-5-next-unverified', 'high', 'unverified'],
    ['o3-pro', 'low', 'unverified']
  ] as const)(
    'rejects saved explicit %s/%s without erasing it or starting transport',
    async (model, reasoningEffort, error) => {
      const saved = { model, reasoningEffort }
      await expect(run(settings, saved)).rejects.toThrow(error)
      expect(saved).toEqual({ model, reasoningEffort })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('keeps an unknown exact ID usable with default reasoning and no tools', async () => {
    await run(settings, { model: 'gpt-5-next-unverified', reasoningEffort: 'none' })
    expect(request().body.model).toBe('gpt-5-next-unverified')
    expect(request().body).not.toHaveProperty('reasoning')
    expect(request().body).not.toHaveProperty('tools')
  })

  it('forces non-stream transport only when unsupported, retaining unknown stream preference', async () => {
    await createAgentProvider(
      settings,
      { model: 'o3-pro', reasoningEffort: 'none' },
      { stream: true }
    ).generate({ messages, tools }, new AbortController().signal)
    expect(request().body.stream).toBe(false)
    expect(request().body.tools).toHaveLength(1)
    fetchMock.mockResolvedValue(
      new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.completed',
            response: { status: 'completed', output: [], output_text: 'Done' }
          }) +
          '\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
    )
    await createAgentProvider(
      settings,
      { model: 'unknown/future', reasoningEffort: 'none' },
      { stream: true }
    ).generate({ messages, tools }, new AbortController().signal)
    expect(request().body.stream).toBe(true)
    expect(request().body).not.toHaveProperty('tools')
  })

  it('detaches capability options before the transport is created', async () => {
    const { modelCapabilities } = await import('./modelCapabilityService')
    const metadata = structuredClone(modelCapabilities('openai', 'responses', { id: 'gpt-5.1' }))
    const provider = createAgentProvider(
      settings,
      { model: 'gpt-5.1', reasoningEffort: 'low' },
      { capabilities: metadata }
    )
    metadata.tools = 'unsupported'
    metadata.reasoning.efforts = []
    await provider.generate({ messages, tools }, new AbortController().signal)
    expect(request().body.tools).toHaveLength(1)
    expect(request().body.reasoning).toEqual({ effort: 'low' })
  })

  it('allows provider default on mandatory gateway reasoning and omits explicitly unsupported tools', async () => {
    const generation = modelCapabilityCatalog.begin('openrouter', routerSettings.openrouterApiKey)
    modelCapabilityCatalog.complete('openrouter', routerSettings.openrouterApiKey, generation, [
      {
        id: 'vendor/mandatory-no-tools',
        supported_parameters: ['reasoning'],
        reasoning: { mandatory: true, supported_efforts: ['none', 'high'] }
      }
    ])
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'Done' } }] })
        )
    )
    await run(routerSettings, { model: 'vendor/mandatory-no-tools', reasoningEffort: 'none' })
    expect(request().body).not.toHaveProperty('reasoning')
    expect(request().body).not.toHaveProperty('tools')
    fetchMock.mockClear()
    await expect(
      run(routerSettings, { model: 'vendor/mandatory-no-tools', reasoningEffort: 'disabled' })
    ).rejects.toThrow('unsupported')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends max only when the exact model metadata documents it', async () => {
    await run(settings, { model: 'gpt-6-astra', reasoningEffort: 'max' })
    expect(request().body.reasoning).toEqual({ effort: 'max' })
    fetchMock.mockClear()
    await expect(run(settings, { model: 'gpt-5.4-nano', reasoningEffort: 'max' })).rejects.toThrow(
      'unsupported'
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
