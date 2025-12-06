import { AppSettings } from '../types/types'

let settings: AppSettings = {
  theme: 'light',
  showToken: false,
  language: 'en',
  openaiApiKey: '',
  openaiModel: 'gpt-4.1-nano',
  developerPrompt: '',
  useCustomApi: false,
  useLegacyInterpreter: false // Default to new interpreter
} // Default settings

export function getSettings() {
  return settings
}

export function setSettings(newSettings: AppSettings) {
  // if we are missing a setting, add its default value
  if (!newSettings.language) {
    newSettings.language = 'en'
  }

  if (!newSettings.theme) {
    newSettings.theme = 'light'
  }

  if (!newSettings.showToken) {
    newSettings.showToken = false
  }

  if (!newSettings.openaiApiKey) {
    newSettings.openaiApiKey = ''
  }

  if (!newSettings.openaiModel) {
    newSettings.openaiModel = 'gpt-4.1-nano'
  }

  if (!newSettings.developerPrompt) {
    newSettings.developerPrompt = ''
  }

  if (newSettings.useCustomApi === undefined) {
    newSettings.useCustomApi = false
  }

  if (newSettings.useLegacyInterpreter === undefined) {
    newSettings.useLegacyInterpreter = false
  }

  settings = newSettings
}
