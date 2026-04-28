import { writable } from 'svelte/store'
import type { AppSettings } from '../types/types'
import { currentLanguage } from './localisation'

export type AiProvider = 'openai' | 'openrouter'

export const settingsStore = writable<AppSettings>({
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
  selectedCommandOpenAiModel: 'gpt-5.4-nano',
  selectedCommandOpenRouterModel: 'openai/gpt-5.4-nano',
  aiReasoningEffort: 'none',
  openaiModel: 'gpt-5.4-nano',
  developerPrompt: '',
  useCustomApi: false,
  useLegacyInterpreter: false,
  disableReasoningApi: false
})

export async function loadSettings() {
  const settings = await window.electron.ipcRenderer.invoke('get-settings')
  settingsStore.set(settings)
  currentLanguage.set(settings.language)
}

export async function saveSettings(newSettings: AppSettings) {
  const savedSettings = await window.electron.ipcRenderer.invoke('save-settings', newSettings)
  settingsStore.set(savedSettings || newSettings)
}

export function getSelectedModelForProvider(
  settings: AppSettings,
  provider: AiProvider = settings.aiProvider || 'openai'
): string {
  if (provider === 'openrouter') {
    return settings.selectedOpenRouterModel || settings.selectedAiModel || 'openai/gpt-5.4-nano'
  }
  return (
    settings.selectedOpenAiModel ||
    settings.selectedAiModel ||
    settings.openaiModel ||
    'gpt-5.4-nano'
  )
}

export function withSelectedModelForProvider(
  settings: AppSettings,
  provider: AiProvider,
  model: string
): AppSettings {
  if (provider === 'openrouter') {
    return {
      ...settings,
      aiProvider: provider,
      selectedOpenRouterModel: model,
      selectedAiModel: model
    }
  }

  return {
    ...settings,
    aiProvider: provider,
    selectedOpenAiModel: model,
    selectedAiModel: model,
    openaiModel: model
  }
}

export function getSelectedCommandModelForProvider(
  settings: AppSettings,
  provider: AiProvider = settings.aiProvider || 'openai'
): string {
  if (provider === 'openrouter') {
    return (
      settings.selectedCommandOpenRouterModel || getSelectedModelForProvider(settings, provider)
    )
  }
  return settings.selectedCommandOpenAiModel || getSelectedModelForProvider(settings, provider)
}

export function withSelectedCommandModelForProvider(
  settings: AppSettings,
  provider: AiProvider,
  model: string
): AppSettings {
  if (provider === 'openrouter') {
    return {
      ...settings,
      selectedCommandOpenRouterModel: model
    }
  }

  return {
    ...settings,
    selectedCommandOpenAiModel: model
  }
}
