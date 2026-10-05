import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryMessage, ProviderProgress, ToolDefinition } from '@ayayaq/vivi'
import type { AgentSession } from '../../shared/agentTypes'
import type { AiRuntimeSettings } from './aiProviderService'
import { createAgentProvider, executeAgentProviderTurn } from './agentProviderAdapter'

const settings: AiRuntimeSettings = { aiProvider: 'openai', openaiApiKey: 'fake-openai-key' }
const routerSettings: AiRuntimeSettings = {
  aiProvider: 'openrouter',
  openaiApiKey: '',
  openrouterApiKey: 'fake-router-key'
}
const session: Pick<AgentSession, 'model' | 'reasoningEffort'> = {
  model: 'gpt-session',
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
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ status: 'completed', output: [], output_text: 'Done' }))
  )
  vi.stubGlobal('fetch', fetchMock)
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
      model: 'gpt-session',
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
    'preserves the existing %s effort selection',
    async (reasoningEffort) => {
      await run(settings, { ...session, reasoningEffort })
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
})
