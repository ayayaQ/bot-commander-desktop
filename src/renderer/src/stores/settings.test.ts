import { describe, expect, it } from 'vitest'
import type { AppSettings } from '../types/types'
import {
  getSelectedCommandModelForProvider,
  getSelectedModelForProvider,
  withSelectedCommandModelForProvider,
  withSelectedModelForProvider
} from './settings'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: 'light',
    showToken: false,
    hideOutput: false,
    language: 'en',
    aiProvider: 'openai',
    openaiApiKey: '',
    openrouterApiKey: '',
    selectedAiModel: 'gpt-5.4-nano',
    selectedOpenAiModel: 'gpt-5.4-nano',
    selectedOpenRouterModel: 'openai/gpt-5.4-nano',
    selectedCommandOpenAiModel: 'gpt-5.4-mini',
    selectedCommandOpenRouterModel: 'anthropic/claude-test',
    aiReasoningEffort: 'none',
    openaiModel: 'gpt-5.4-nano',
    developerPrompt: '',
    useCustomApi: false,
    useLegacyInterpreter: false,
    disableReasoningApi: false,
    agentNotificationsEnabled: true,
    ...overrides
  }
}

describe('renderer settings helpers', () => {
  it('selects model values for each provider with fallback order', () => {
    expect(getSelectedModelForProvider(settings(), 'openai')).toBe('gpt-5.4-nano')
    expect(getSelectedModelForProvider(settings(), 'openrouter')).toBe('openai/gpt-5.4-nano')
    expect(
      getSelectedModelForProvider(
        settings({ selectedOpenAiModel: '', selectedAiModel: '', openaiModel: 'gpt-4.1-mini' }),
        'openai'
      )
    ).toBe('gpt-4.1-mini')
  })

  it('updates chat model selection without changing the other provider model', () => {
    const updated = withSelectedModelForProvider(settings(), 'openrouter', 'meta/llama-test')

    expect(updated).toMatchObject({
      aiProvider: 'openrouter',
      selectedAiModel: 'meta/llama-test',
      selectedOpenRouterModel: 'meta/llama-test',
      selectedOpenAiModel: 'gpt-5.4-nano'
    })
  })

  it('keeps command model selection separate from chat model selection', () => {
    const updated = withSelectedCommandModelForProvider(settings(), 'openai', 'gpt-4.1-mini')

    expect(getSelectedCommandModelForProvider(updated, 'openai')).toBe('gpt-4.1-mini')
    expect(getSelectedModelForProvider(updated, 'openai')).toBe('gpt-5.4-nano')
  })
})
