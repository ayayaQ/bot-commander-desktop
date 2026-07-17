import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types/types'

function legacySettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: '' as AppSettings['theme'],
    showToken: false,
    hideOutput: undefined as unknown as boolean,
    language: '' as AppSettings['language'],
    openaiApiKey: '',
    openaiModel: '',
    developerPrompt: '',
    useCustomApi: undefined as unknown as boolean,
    useLegacyInterpreter: undefined as unknown as boolean,
    agentNotificationsEnabled: undefined as unknown as boolean,
    ...overrides
  }
}

describe('settingsService', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('fills defaults for legacy settings without optional AI fields', async () => {
    const { getSettings, setSettings } = await import('./settingsService')

    setSettings(legacySettings())

    expect(getSettings()).toMatchObject({
      theme: 'light',
      showToken: false,
      hideOutput: false,
      language: 'en',
      aiProvider: 'openai',
      openaiApiKey: '',
      openrouterApiKey: '',
      openaiModel: 'gpt-5.4-nano',
      selectedAiModel: 'gpt-5.4-nano',
      selectedOpenAiModel: 'gpt-5.4-nano',
      selectedOpenRouterModel: 'openai/gpt-5.4-nano',
      aiReasoningEffort: 'none',
      developerPrompt: '',
      useCustomApi: false,
      useLegacyInterpreter: false,
      agentNotificationsEnabled: true
    })
  })

  it('keeps provider-specific selected model values in sync', async () => {
    const { getSettings, setSettings } = await import('./settingsService')

    setSettings(
      legacySettings({
        aiProvider: 'openrouter',
        selectedAiModel: 'anthropic/claude-test',
        selectedOpenRouterModel: 'meta/test-model',
        selectedOpenAiModel: 'gpt-4.1-mini'
      })
    )

    expect(getSettings()).toMatchObject({
      aiProvider: 'openrouter',
      selectedAiModel: 'meta/test-model',
      selectedOpenAiModel: 'gpt-4.1-mini',
      selectedOpenRouterModel: 'meta/test-model'
    })
  })

  it('discards retired command-assistant settings', async () => {
    const { getSettings, setSettings } = await import('./settingsService')
    const retiredSettings = {
      ...legacySettings(),
      selectedCommandOpenAiModel: 'gpt-4.1-mini',
      selectedCommandOpenRouterModel: 'meta/test-model',
      disableReasoningApi: true
    } as AppSettings

    setSettings(retiredSettings)

    expect(getSettings()).not.toHaveProperty('selectedCommandOpenAiModel')
    expect(getSettings()).not.toHaveProperty('selectedCommandOpenRouterModel')
    expect(getSettings()).not.toHaveProperty('disableReasoningApi')
  })
})
