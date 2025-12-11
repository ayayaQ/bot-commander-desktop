import { writable } from 'svelte/store'
import type { AppSettings } from '../types/types'
import { currentLanguage } from './localisation'

export const settingsStore = writable<AppSettings>({
  theme: 'light',
  showToken: false,
  hideOutput: false,
  language: 'en',
  openaiApiKey: '',
  openaiModel: 'gpt-4.1-nano',
  developerPrompt: '',
  useCustomApi: false,
  useLegacyInterpreter: false
})

export async function loadSettings() {
  const settings = await (window as any).electron.ipcRenderer.invoke('get-settings')
  settingsStore.set(settings)
  currentLanguage.set(settings.language)
}

export async function saveSettings(newSettings: AppSettings) {
  await (window as any).electron.ipcRenderer.invoke('save-settings', newSettings)
  settingsStore.set(newSettings)
}
