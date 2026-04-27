import { AppSettings } from '../types/types'

let settings: AppSettings = {
  theme: 'light',
  showToken: false,
  hideOutput: false,
  language: 'en',
  aiProvider: 'openai',
  openaiApiKey: '',
  openrouterApiKey: '',
  selectedAiModel: 'gpt-4.1-nano',
  selectedOpenAiModel: 'gpt-4.1-nano',
  selectedOpenRouterModel: 'openai/gpt-5.2',
  aiReasoningEffort: 'none',
  openaiModel: 'gpt-4.1-nano',
  developerPrompt: '',
  useCustomApi: false,
  useLegacyInterpreter: false, // Default to new interpreter
  disableReasoningApi: false // Default to using reasoning API for thinking models
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

  if (newSettings.hideOutput === undefined) {
    newSettings.hideOutput = false
  }

  if (!newSettings.openaiApiKey) {
    newSettings.openaiApiKey = ''
  }

  if (!newSettings.aiProvider) {
    newSettings.aiProvider = 'openai'
  }

  if (!newSettings.openrouterApiKey) {
    newSettings.openrouterApiKey = ''
  }

  if (!newSettings.openaiModel) {
    newSettings.openaiModel = 'gpt-4.1-nano'
  }

  if (!newSettings.selectedAiModel) {
    newSettings.selectedAiModel = newSettings.openaiModel
  }

  if (!newSettings.selectedOpenAiModel) {
    newSettings.selectedOpenAiModel =
      newSettings.aiProvider === 'openai'
        ? newSettings.selectedAiModel || newSettings.openaiModel
        : newSettings.openaiModel || 'gpt-4.1-nano'
  }

  if (!newSettings.selectedOpenRouterModel) {
    newSettings.selectedOpenRouterModel =
      newSettings.aiProvider === 'openrouter'
        ? newSettings.selectedAiModel || 'openai/gpt-5.2'
        : 'openai/gpt-5.2'
  }

  newSettings.selectedAiModel =
    newSettings.aiProvider === 'openrouter'
      ? newSettings.selectedOpenRouterModel
      : newSettings.selectedOpenAiModel

  if (!newSettings.aiReasoningEffort) {
    newSettings.aiReasoningEffort = 'none'
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

  if (newSettings.disableReasoningApi === undefined) {
    newSettings.disableReasoningApi = false
  }

  settings = newSettings
}
