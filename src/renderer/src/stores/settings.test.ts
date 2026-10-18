import { describe, expect, it } from 'vitest'
import { get } from 'svelte/store'
import type { AppSettings } from '../types/types'
import {
  getSelectedModelForProvider,
  settingsStore,
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
    aiReasoningEffort: 'none',
    openaiModel: 'gpt-5.4-nano',
    developerPrompt: '',
    useCustomApi: false,
    useLegacyInterpreter: false,
    agentNotificationsEnabled: true,
    ...overrides
  }
}

describe('renderer settings helpers', () => {
  it('selects model values for each provider with fallback order', () => {
    expect(getSelectedModelForProvider(settings(), 'openai')).toBe('gpt-5.4-nano')
    expect(getSelectedModelForProvider(settings(), 'openrouter')).toBe('openai/gpt-5.4-nano')
    expect(getSelectedModelForProvider(settings(), 'deepseek')).toBe('deepseek-flash')
    expect(
      getSelectedModelForProvider(
        settings({ selectedDeepSeekModel: 'deepseek-v4-pro' }),
        'deepseek'
      )
    ).toBe('deepseek-v4-pro')
    expect(
      getSelectedModelForProvider(
        settings({ selectedOpenAiModel: '', selectedAiModel: '', openaiModel: 'gpt-4.1-mini' }),
        'openai'
      )
    ).toBe('gpt-4.1-mini')
  })

  it('keeps web disabled with a separate key source by default', () => {
    expect(get(settingsStore)).toMatchObject({
      aiProvider: 'openai',
      webProvider: 'disabled',
      deepseekWebKeySource: 'separate',
      deepseekWebKeyConfigured: false,
      deepseekKeyConfigured: false
    })
  })

  it('switches DeepSeek chat without enabling web, reusing a key or changing the reviewer', () => {
    const original = settings({
      webProvider: 'disabled',
      deepseekWebKeySource: 'separate',
      deepseekWebKeyConfigured: true,
      deepseekKeyConfigured: true,
      deepseekChatAccountRevision: 'chat-account-fixture',
      agentReviewerProvider: 'openrouter'
    })
    const updated = withSelectedModelForProvider(original, 'deepseek', 'deepseek-v4-pro')
    expect(updated).toMatchObject({
      aiProvider: 'deepseek',
      selectedDeepSeekModel: 'deepseek-v4-pro',
      selectedAiModel: 'deepseek-v4-pro',
      selectedOpenAiModel: 'gpt-5.4-nano',
      selectedOpenRouterModel: 'openai/gpt-5.4-nano',
      webProvider: 'disabled',
      deepseekWebKeySource: 'separate',
      deepseekWebKeyConfigured: true,
      deepseekKeyConfigured: true,
      deepseekChatAccountRevision: 'chat-account-fixture',
      agentReviewerProvider: 'openrouter'
    })
    expect(getSelectedModelForProvider(updated, 'openai')).toBe('gpt-5.4-nano')
    expect(getSelectedModelForProvider(updated, 'openrouter')).toBe('openai/gpt-5.4-nano')
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
})
