import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { classifySpamWithOpenRouter, OpenRouterDecisionError } from './aiProviderService'

const context = { message: 'synthetic message', recentMessages: [] }
describe('OpenRouter spam decisions', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Decisions endpoint and only an OpenRouter key, without chat configuration', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          model: 'typesafe/jev-1.13',
          answers: { spam: { type: 'noul', noul: 0.98 } }
        })
      )
    )
    const signal = new AbortController().signal
    expect(await classifySpamWithOpenRouter('router-key', context, signal)).toEqual({
      probability: 0.98,
      model: 'typesafe/jev-1.13'
    })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(init?.signal).toBe(signal)
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer router-key',
      'X-OpenRouter-Title': 'Bot Commander for Discord'
    })
    const body = JSON.parse(init?.body as string)
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
    expect(body).toMatchObject({
      model: '~typesafe/jev-latest',
      state: context,
      questions: { spam: { type: 'noul' } }
    })
  })

  it.each([
    null,
    {},
    { type: 'choice', noul: 1 },
    { type: 'noul', noul: '1' },
    { type: 'noul', noul: -0.1 },
    { type: 'noul', noul: 1.01 }
  ])('rejects malformed verdict %j', async (spam) => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ model: 'jev', answers: { spam } }))
    )
    await expect(
      classifySpamWithOpenRouter('key', context, new AbortController().signal)
    ).rejects.toThrow('Invalid OpenRouter Decisions response')
  })

  it('rejects malformed JSON and missing keys', async () => {
    await expect(
      classifySpamWithOpenRouter('', context, new AbortController().signal)
    ).rejects.toBeInstanceOf(OpenRouterDecisionError)
    expect(fetch).not.toHaveBeenCalled()
    vi.mocked(fetch).mockResolvedValue(new Response('not json'))
    await expect(
      classifySpamWithOpenRouter('key', context, new AbortController().signal)
    ).rejects.toThrow()
  })

  it.each(['12', 'invalid', ''])(
    'handles Retry-After %s without exposing the response body',
    async (retryAfter) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('private message and credentials', {
          status: 429,
          headers: { 'Retry-After': retryAfter }
        })
      )
      try {
        await classifySpamWithOpenRouter('key', context, new AbortController().signal)
        expect.fail('expected error')
      } catch (error) {
        expect(error).toMatchObject({
          status: 429,
          retryAfterMs: retryAfter === '12' ? 12_000 : 30_000
        })
        expect(String(error)).not.toContain('private')
      }
    }
  )

  it('supports HTTP-date Retry-After', async () => {
    const now = Date.parse('2026-09-18T00:00:00Z')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', {
          status: 429,
          headers: { 'Retry-After': new Date(now + 60_000).toUTCString() }
        })
      )
      await expect(
        classifySpamWithOpenRouter('key', context, new AbortController().signal)
      ).rejects.toMatchObject({ retryAfterMs: 60_000 })
    } finally {
      clock.mockRestore()
    }
  })
})
