import { AppSettings } from '../types/types'

let settings: AppSettings = {
  theme: 'light',
  showToken: false,
  language: 'en',
  openaiApiKey: '',
  openaiModel: 'gpt-4o-mini'
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
    newSettings.openaiModel = 'gpt-4o-mini'
  }

  settings = newSettings
}
