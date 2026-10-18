import { get } from 'svelte/store'
import { createSettingsPersistence } from './settingsPersistence'
import type { AppSettings } from '../types/types'
import { currentLanguage } from './localisation'

export type AiProvider = 'openai' | 'openrouter' | 'deepseek'

const defaultSettings: AppSettings = {
  theme: 'light',
  showToken: false,
  hideOutput: false,
  language: 'en',
  aiProvider: 'openai',
  openaiApiKey: '',
  openrouterApiKey: '',
  deepseekKeyConfigured: false,
  webProvider: 'disabled',
  deepseekWebKeySource: 'separate',
  deepseekWebKeyConfigured: false,
  spamProtectionEnabled: false,
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

/** Guard mixed-version responses and callers without retaining new credentials in stores. */
function withoutDeepSeekSecrets(settings: AppSettings): AppSettings {
  if (!settings || typeof settings !== 'object') return settings
  const safe = { ...settings } as AppSettings & Record<string, unknown>
  delete safe.deepseekApiKey
  delete safe.deepseekWebApiKey
  return safe
}

const persistence = createSettingsPersistence(
  defaultSettings,
  async (settings) =>
    withoutDeepSeekSecrets(
      await window.electron.ipcRenderer.invoke('save-settings', withoutDeepSeekSecrets(settings))
    ),
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
export const saveSettings = (settings: AppSettings) =>
  persistence.save(withoutDeepSeekSecrets(settings))
export const patchSettings = (changes: Partial<AppSettings>) =>
  persistence.patch(withoutDeepSeekSecrets(changes as AppSettings))
export const retrySettingsSave = persistence.retry

export async function loadSettings() {
  return persistence.load(async () =>
    withoutDeepSeekSecrets(await window.electron.ipcRenderer.invoke('get-settings'))
  )
}

/** Keys cross only this narrow IPC call, never the renderer settings stores. */
export async function saveDeepSeekKey(purpose: 'chat' | 'web', value: string): Promise<void> {
  const current = get(settingsStore)
  const expectedRevision =
    purpose === 'chat' ? current.deepseekChatAccountRevision : current.agentWebAccountRevision
  if (!expectedRevision) throw new Error('Wait for settings to load before updating the key')
  await window.electron.ipcRenderer.invoke('save-deepseek-key', {
    purpose,
    value,
    expectedRevision
  })
  await loadSettings()
}

export function getSelectedModelForProvider(
  settings: AppSettings,
  provider: AiProvider = settings.aiProvider || 'openai'
): string {
  if (provider === 'deepseek') return settings.selectedDeepSeekModel || 'deepseek-flash'
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
  if (provider === 'deepseek')
    return {
      ...settings,
      aiProvider: provider,
      selectedDeepSeekModel: model,
      selectedAiModel: model
    }
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
