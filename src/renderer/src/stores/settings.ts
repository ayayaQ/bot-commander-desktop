import { createSettingsPersistence } from './settingsPersistence'
import type { AppSettings } from '../types/types'
import { currentLanguage } from './localisation'

export type AiProvider = 'openai' | 'openrouter'

const defaultSettings: AppSettings = {
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
  agentNotificationsEnabled: true
}

const persistence = createSettingsPersistence(
  defaultSettings,
  (settings) => window.electron.ipcRenderer.invoke('save-settings', settings),
  (settings) => {
    currentLanguage.set(settings.language)
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', settings.theme)
    }
  }
)

export const settingsStore = persistence.committed
export const settingsDraftStore = persistence.draft
export const settingsSaveStatus = persistence.status
export const saveSettings = persistence.save
export const patchSettings = persistence.patch
export const retrySettingsSave = persistence.retry

export async function loadSettings() {
  return persistence.load(() => window.electron.ipcRenderer.invoke('get-settings'))
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
