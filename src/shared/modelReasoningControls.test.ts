import { describe, expect, it } from 'vitest'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'
import {
  providerReasoningEfforts,
  reasoningCapabilityLabel,
  reasoningChoices,
  reasoningConfigurationError,
  reasoningSelection
} from './modelReasoningControls'

const capabilities = (model: unknown, provider = 'openrouter' as 'openai' | 'openrouter') =>
  normalizeModelCapabilities({
    apiVersion: 1,
    provider,
    protocol: provider === 'openai' ? 'responses' : 'chat-completions',
    model
  })

describe('desktop reasoning control policy', () => {
  it('keeps legacy none as omission and explicit disable as a distinct selection', () => {
    expect(reasoningSelection('none')).toEqual({ mode: 'default' })
    expect(reasoningSelection('disabled')).toEqual({ mode: 'disabled' })
    expect(reasoningSelection('max')).toEqual({ mode: 'effort', effort: 'max' })
    expect(reasoningConfigurationError(undefined, 'none')).toBeNull()
    expect(reasoningChoices(undefined)).toEqual([
      { value: 'none', label: 'Provider default (may reason)' }
    ])
  })

  it('offers disable without unverified named efforts for an optional token-budget model', () => {
    const result = capabilities({
      id: 'vendor/budget',
      reasoning: { mandatory: false, supports_max_tokens: true }
    })
    expect(reasoningChoices(result).map((choice) => choice.value)).toEqual(['none', 'disabled'])
    expect(reasoningChoices(result, false).map((choice) => choice.value)).toEqual(['none'])
    expect(providerReasoningEfforts(result)).toEqual(['none'])
    expect(reasoningConfigurationError(result, 'disabled')).toBeNull()
    expect(reasoningConfigurationError(result, 'high')).toContain('unsupported')
    expect(reasoningCapabilityLabel(result)).toContain('no verified effort choices')
  })

  it('forbids disable for mandatory models but still allows provider default', () => {
    const result = capabilities({
      id: 'vendor/mandatory',
      reasoning: { mandatory: true, supported_efforts: ['none', 'low', 'future', 'max'] }
    })
    expect(reasoningChoices(result).map((choice) => choice.value)).toEqual(['none', 'low', 'max'])
    expect(providerReasoningEfforts(result)).toEqual(['low', 'max'])
    expect(reasoningConfigurationError(result, 'disabled')).toContain('unsupported')
    expect(reasoningConfigurationError(result, 'none')).toBeNull()
    expect(reasoningCapabilityLabel(result)).toContain('cannot disable')
  })

  it('preserves unknown/unsupported saved values and returns an actionable error', () => {
    const unknown = capabilities({ id: 'vendor/unknown' })
    const saved = { reasoningEffort: 'high' as const }
    expect(reasoningConfigurationError(unknown, saved.reasoningEffort)).toContain('unverified')
    expect(saved.reasoningEffort).toBe('high')
    const gpt5 = capabilities({ id: 'gpt-5' }, 'openai')
    expect(reasoningConfigurationError(gpt5, 'xhigh')).toContain('unsupported')
    expect(reasoningConfigurationError(gpt5, 'low')).toBeNull()
    expect(reasoningChoices(gpt5).map((choice) => choice.value)).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high'
    ])
  })
})
