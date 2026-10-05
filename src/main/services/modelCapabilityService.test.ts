import { describe, expect, it } from 'vitest'
import { normalizeModelCapabilities, type CapabilityInput } from '@ayayaq/vivi/providers/models'
import { ModelCapabilityCatalog, modelCapabilities } from './modelCapabilityService'
import { openAiResponsesExclusionSources } from './openAiResponsesExclusionSources'
import { nonConversationOpenAI, openaiCapabilities } from './openAiResponsesRegistry'
import fixtures from './fixtures/model-capabilities.json'

const router = {
  id: 'vendor/optional-budget',
  supported_parameters: ['tools', 'reasoning'],
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  reasoning: { mandatory: false, supports_max_tokens: true }
}

describe('endpoint-aware desktop capability facts', () => {
  it.each(fixtures.cases)('$name', ({ input, expected }) => {
    expect(normalizeModelCapabilities(input as CapabilityInput)).toMatchObject(expected)
  })

  it('retains every existing documented Responses ID, effort and streaming fact', () => {
    expect(Object.keys(openaiCapabilities)).toHaveLength(52)
    expect(fixtures.baselineOpenAI).toHaveLength(52)
    for (const { model } of fixtures.baselineOpenAI) {
      const result = modelCapabilities('openai', 'responses', { id: model.id })
      expect(result).toMatchObject({
        id: model.id,
        chat: 'supported',
        tools: model.tools,
        stream: model.streaming,
        reasoning: { efforts: model.efforts }
      })
      expect(result.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'official-model-documentation',
            reviewedOn: '2026-10-05'
          })
        ])
      )
    }
    expect(modelCapabilities('openai', 'responses', { id: 'gpt-4.1' }).reasoning.support).toBe(
      'unsupported'
    )
    expect(modelCapabilities('openai', 'responses', { id: 'o3-pro' }).reasoning).toMatchObject({
      support: 'supported',
      disable: 'unknown',
      effortSelection: 'unknown',
      efforts: []
    })
  })

  it('retains all 72 exact Responses exclusions without leaking them to Chat', () => {
    expect(nonConversationOpenAI.size).toBe(72)
    expect(fixtures.baselineOpenAIExclusions).toHaveLength(72)
    for (const row of fixtures.baselineOpenAIExclusions) {
      expect(modelCapabilities('openai', 'responses', { id: row.model.id }).chat).toBe(
        'unsupported'
      )
    }
    expect(
      modelCapabilities('openai', 'chat-completions', { id: 'gpt-4o-search-preview' }).chat
    ).toBe('unknown')
    expect(modelCapabilities('openai', 'chat-completions', { id: 'gpt-audio' }).chat).toBe(
      'unknown'
    )
    expect(modelCapabilities('openai', 'responses', { id: 'gpt-5-pro' }).chat).toBe('supported')
    expect(modelCapabilities('openai', 'chat-completions', { id: 'gpt-5-pro' }).chat).toBe(
      'unsupported'
    )
  })

  it('uses precise exclusion receipts, including specialized output/legacy API/removal evidence', () => {
    expect(Object.keys(openAiResponsesExclusionSources)).toHaveLength(72)
    expect(
      modelCapabilities('openai', 'responses', { id: 'gpt-5-search-api' }).sources[0].url
    ).toBe('https://developers.openai.com/api/docs/guides/tools-web-search.md')
    expect(
      modelCapabilities('openai', 'responses', { id: 'text-moderation-007' }).sources[0].url
    ).toBe('https://developers.openai.com/api/docs/models/text-moderation-stable.md')
    expect(
      modelCapabilities('openai', 'responses', { id: 'omni-moderation-2024-09-26' }).sources[0].url
    ).toBe('https://developers.openai.com/api/docs/models/omni-moderation-latest.md')
    for (const id of ['gpt-image-1', 'gpt-3.5-turbo-instruct', 'chatgpt-4o-latest']) {
      expect(modelCapabilities('openai', 'responses', { id }).chat).toBe('unsupported')
    }
  })

  it.each(['gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17'])(
    'retains the documented desktop default %s on both APIs',
    (id) => {
      for (const protocol of ['responses', 'chat-completions'] as const) {
        expect(modelCapabilities('openai', protocol, { id })).toMatchObject({
          id,
          protocol,
          chat: 'supported',
          tools: 'supported',
          stream: 'supported',
          reasoning: { disable: 'supported', efforts: ['none', 'low', 'medium', 'high', 'xhigh'] }
        })
      }
    }
  )

  it('keeps enriched snapshots deeply frozen and detached from fixture inputs', () => {
    const input = { id: 'gpt-5.4-nano', reasoning: { supported_efforts: ['future'] } }
    const result = modelCapabilities('openai', 'responses', input)
    input.id = 'custom'
    input.reasoning.supported_efforts.push('high')
    expect(result.id).toBe('gpt-5.4-nano')
    expect(result.reasoning.efforts).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    for (const value of [
      result,
      result.reasoning,
      result.reasoning.efforts,
      result.sources,
      ...result.sources
    ]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    expect(() => (result.reasoning.efforts as string[]).push('max')).toThrow()
    expect(() => Object.assign(result.sources[0], { url: 'changed' })).toThrow()
  })

  it('uses separate documented Chat facts, including conditional GPT-6 tools', () => {
    expect(
      modelCapabilities('openai', 'chat-completions', { id: 'gpt-5.4' }).reasoning.efforts
    ).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(modelCapabilities('openai', 'chat-completions', { id: 'gpt-6-sol' }).tools).toBe(
      'unknown'
    )
    expect(modelCapabilities('openai', 'chat-completions', { id: 'gpt-6.1-sol' }).tools).toBe(
      'unsupported'
    )
    expect(modelCapabilities('openai', 'responses', { id: 'gpt-6.1-sol' }).tools).toBe('supported')
    expect(modelCapabilities('openai', 'chat-completions', { id: 'o3' }).reasoning).toMatchObject({
      support: 'supported',
      effortSelection: 'unknown',
      efforts: []
    })
  })

  it.each(['gpt-5-next-unverified', 'gpt-5.4-nano-extra', 'ft:custom/future', 'custom-model'])(
    'does not guess capabilities from the exact custom ID %s',
    (id) => {
      expect(modelCapabilities('openai', 'responses', { id })).toMatchObject({
        id,
        chat: 'unknown',
        tools: 'unknown',
        stream: 'unknown',
        reasoning: { support: 'unknown', efforts: [] }
      })
    }
  )
})

describe('host-owned account-scoped capability cache', () => {
  it('isolates provider, key, endpoint and exact ID without retaining credentials or raw fields', () => {
    const cache = new ModelCapabilityCatalog(() => 100)
    const generation = cache.begin('openrouter', 'secret-one')
    cache.complete('openrouter', 'secret-one', generation, [{ ...router, api_key: 'secret-one' }])
    expect(cache.get('openrouter', 'secret-one', 'chat-completions', router.id).tools).toBe(
      'supported'
    )
    expect(cache.get('openrouter', 'secret-two', 'chat-completions', router.id).tools).toBe(
      'unknown'
    )
    expect(cache.get('openrouter', 'secret-one', 'responses', router.id).tools).toBe('unknown')
    expect(
      cache.get('openrouter', 'secret-one', 'chat-completions', router.id + '-new').tools
    ).toBe('unknown')
    expect(cache.get('openai', 'secret-one', 'responses', router.id).tools).toBe('unknown')
    expect(
      JSON.stringify(cache, (_key, value) => (value instanceof Map ? [...value.entries()] : value))
    ).not.toContain('secret-one')
    expect(
      JSON.stringify(cache.get('openrouter', 'secret-one', 'chat-completions', router.id))
    ).not.toContain('api_key')
  })

  it('rejects old completions after another key or a newer same-key request', () => {
    const cache = new ModelCapabilityCatalog(() => 100)
    const old = cache.begin('openrouter', 'old-key')
    const current = cache.begin('openrouter', 'new-key')
    expect(cache.complete('openrouter', 'new-key', current, [router])).toBe(true)
    expect(cache.complete('openrouter', 'old-key', old, [router])).toBe(false)
    const newer = cache.begin('openrouter', 'new-key')
    expect(cache.complete('openrouter', 'new-key', current, [router])).toBe(false)
    expect(cache.complete('openrouter', 'new-key', newer, [{ id: router.id }])).toBe(true)
    expect(cache.get('openrouter', 'old-key', 'chat-completions', router.id).tools).toBe('unknown')
    expect(cache.get('openrouter', 'new-key', 'chat-completions', router.id).tools).toBe('unknown')
  })

  it('expires metadata and leaves malformed or missing fields unknown', () => {
    let now = 100
    const cache = new ModelCapabilityCatalog(() => now)
    const generation = cache.begin('openrouter', 'key')
    cache.complete('openrouter', 'key', generation, [
      router,
      { id: 'vendor/malformed', supported_parameters: 1 }
    ])
    expect(cache.get('openrouter', 'key', 'chat-completions', 'vendor/malformed').tools).toBe(
      'unknown'
    )
    now += 15 * 60_000
    expect(cache.get('openrouter', 'key', 'chat-completions', router.id).tools).toBe('unknown')
  })
  it('invalidates pending generations on external committed provider/key changes', async () => {
    const { getSettings, setSettings } = await import('./settingsService')
    const { modelCapabilityCatalog } = await import('./modelCapabilityService')
    const original = { ...getSettings() }
    const settings = {
      ...original,
      aiProvider: 'openrouter' as const,
      openrouterApiKey: 'router-fixture-key'
    }
    setSettings(settings)
    const old = modelCapabilityCatalog.begin('openrouter', settings.openrouterApiKey)
    setSettings({ ...settings, aiProvider: 'openai' })
    setSettings(settings)
    expect(
      modelCapabilityCatalog.complete('openrouter', settings.openrouterApiKey, old, [router])
    ).toBe(false)
    const current = modelCapabilityCatalog.begin('openrouter', settings.openrouterApiKey)
    expect(
      modelCapabilityCatalog.complete('openrouter', settings.openrouterApiKey, current, [router])
    ).toBe(true)
    setSettings({ ...settings, openrouterApiKey: 'new-router-fixture-key' })
    setSettings(settings)
    expect(
      modelCapabilityCatalog.get(
        'openrouter',
        settings.openrouterApiKey,
        'chat-completions',
        router.id
      ).tools
    ).toBe('unknown')
    setSettings(original)
  })
})
