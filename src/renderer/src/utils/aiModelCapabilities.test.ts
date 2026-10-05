import { describe, expect, it, vi } from 'vitest'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'
import {
  canRefreshModelCatalog,
  currentSelectedCapabilities,
  catalogSettingsMatch,
  ModelCatalogRequestGate,
  selectedModelCapabilities
} from './aiModelCapabilities'

const capabilities = normalizeModelCapabilities({
  apiVersion: 1,
  provider: 'openai',
  protocol: 'responses',
  model: { id: 'gpt-5.1' }
})
const models = [{ id: 'gpt-5.1', name: 'GPT-5.1', capabilities }]

describe('renderer endpoint and catalog freshness controls', () => {
  it('never reuses other providers, endpoints, IDs or mismatched snapshots', () => {
    expect(selectedModelCapabilities('openai', 'responses', 'gpt-5.1', models)).toEqual(
      capabilities
    )
    expect(
      selectedModelCapabilities('openai', 'chat-completions', 'gpt-5.1', models)
    ).toBeUndefined()
    expect(
      selectedModelCapabilities('openrouter', 'chat-completions', 'gpt-5.1', models)
    ).toBeUndefined()
    expect(selectedModelCapabilities('openai', 'responses', 'gpt-5.1-new', models)).toBeUndefined()
    expect(
      selectedModelCapabilities('openai', 'responses', 'gpt-5.1', [
        { ...models[0], capabilities: { ...capabilities, id: 'wrong' } }
      ])
    ).toBeUndefined()
  })

  it('rejects older async completions after refresh, key/provider switch or external settings change', () => {
    const gate = new ModelCatalogRequestGate()
    const old = gate.begin()
    const newer = gate.begin()
    expect(gate.current(old)).toBe(false)
    expect(gate.current(newer)).toBe(true)
    gate.invalidate()
    expect(gate.current(newer)).toBe(false)
    const current = gate.begin()
    expect(gate.current(current)).toBe(true)
  })
  it('blocks pending or failed provider saves until the exact committed identity matches', () => {
    const old = { aiProvider: 'openai' as const, openaiApiKey: 'old-fixture-key' }
    const local = { ...old, openaiApiKey: 'new-fixture-key' }
    expect(canRefreshModelCatalog(local, old, { saving: true, unsaved: true })).toBe(false)
    expect(canRefreshModelCatalog(local, old, { saving: false, unsaved: true })).toBe(false)
    expect(canRefreshModelCatalog(local, old, { saving: false, unsaved: false })).toBe(false)
    expect(canRefreshModelCatalog(local, local, { saving: true, unsaved: true })).toBe(false)
    expect(canRefreshModelCatalog(local, local, { saving: false, unsaved: false })).toBe(true)
    expect(catalogSettingsMatch(old, local)).toBe(false)
    expect(
      catalogSettingsMatch(local, {
        ...local,
        aiProvider: 'openrouter',
        openrouterApiKey: 'router-key'
      })
    ).toBe(false)
  })
  it('uses pure selected facts independently of account membership and rejects stale selected snapshots', () => {
    expect(selectedModelCapabilities('openai', 'responses', 'gpt-5.1', [], capabilities)).toEqual(
      capabilities
    )
    expect(
      selectedModelCapabilities('openai', 'responses', 'gpt-5.1-new', [], capabilities)
    ).toBeUndefined()
    expect(
      selectedModelCapabilities('openrouter', 'chat-completions', 'gpt-5.1', [], capabilities)
    ).toBeUndefined()
    expect(
      selectedModelCapabilities('openai', 'chat-completions', 'gpt-5.1', [], capabilities)
    ).toBeUndefined()
    const selectedGate = new ModelCatalogRequestGate()
    const oldModelRequest = selectedGate.begin()
    const currentModelRequest = selectedGate.begin()
    expect(selectedGate.current(oldModelRequest)).toBe(false)
    expect(selectedGate.current(currentModelRequest)).toBe(true)
    selectedGate.invalidate()
    expect(selectedGate.current(currentModelRequest)).toBe(false)
  })
  it('expires Router controls while a selected model stays open, then uses authoritative unknown facts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-05T06:00:00Z'))
    try {
      const { ModelCapabilityCatalog } =
        await import('../../../main/services/modelCapabilityService')
      const cache = new ModelCapabilityCatalog()
      const model = {
        id: 'vendor/selected',
        supported_parameters: ['tools', 'reasoning'],
        reasoning: { mandatory: false, supported_efforts: ['none', 'high'] }
      }
      const generation = cache.begin('openrouter', 'fixture-key')
      cache.complete('openrouter', 'fixture-key', generation, [model])
      const selected = cache.selectedSnapshot(
        'openrouter',
        'fixture-key',
        'chat-completions',
        model.id
      )
      expect(
        currentSelectedCapabilities(
          selected.capabilities,
          'openrouter',
          'chat-completions',
          model.id,
          selected.expiresAt
        )?.reasoning.efforts
      ).toEqual(['none', 'high'])
      vi.advanceTimersByTime(15 * 60_000)
      expect(
        currentSelectedCapabilities(
          selected.capabilities,
          'openrouter',
          'chat-completions',
          model.id,
          selected.expiresAt
        )
      ).toBeUndefined()
      const reread = cache.selectedSnapshot(
        'openrouter',
        'fixture-key',
        'chat-completions',
        model.id
      )
      expect(
        currentSelectedCapabilities(
          reread.capabilities,
          'openrouter',
          'chat-completions',
          model.id,
          reread.expiresAt
        )?.reasoning
      ).toMatchObject({ support: 'unknown', efforts: [] })
      expect(reread.expiresAt).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
