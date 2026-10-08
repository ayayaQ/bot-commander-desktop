import { AppSettings } from '../types/types'
import { randomUUID } from 'node:crypto'
import { registerAgentDecisionSecret } from './agentDecisionPrivacy'

let observedCredentials: { provider: string; openai: string; openrouter: string; revision: string }
let settingsGeneration = 0

export function getAgentDecisionSettingsGeneration(): number {
  return settingsGeneration
}

let settings: AppSettings = {
  theme: 'light',
  showToken: false,
  hideOutput: false,
  language: 'en',
  aiProvider: 'openai',
  agentDecisionAccountRevision: randomUUID(),
  openaiApiKey: '',
  openrouterApiKey: '',
  spamProtectionEnabled: false,
  selectedAiModel: 'gpt-5.4-nano',
  selectedOpenAiModel: 'gpt-5.4-nano',
  selectedOpenRouterModel: 'openai/gpt-5.4-nano',
  aiReasoningEffort: 'none',
  openaiModel: 'gpt-5.4-nano',
  developerPrompt: '',
  useCustomApi: false,
  useLegacyInterpreter: false, // Historical key: true enables global eval scope
  agentNotificationsEnabled: true
} // Default settings

export function getSettings() {
  return settings
}

const listeners = new Set<(next: AppSettings, previous: AppSettings) => void>()

export function onSettingsChanged(listener: (next: AppSettings, previous: AppSettings) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function normalizeSettings(newSettings: AppSettings): AppSettings {
  const supportedSettings = { ...newSettings } as AppSettings & Record<string, unknown>
  delete supportedSettings['selectedCommandOpenAiModel']
  delete supportedSettings['selectedCommandOpenRouterModel']
  delete supportedSettings['disableReasoningApi']
  newSettings = supportedSettings

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
    newSettings.openaiModel = 'gpt-5.4-nano'
  }

  if (!newSettings.selectedAiModel) {
    newSettings.selectedAiModel = newSettings.openaiModel
  }

  if (!newSettings.selectedOpenAiModel) {
    newSettings.selectedOpenAiModel =
      newSettings.aiProvider === 'openai'
        ? newSettings.selectedAiModel || newSettings.openaiModel
        : newSettings.openaiModel || 'gpt-5.4-nano'
  }

  if (!newSettings.selectedOpenRouterModel) {
    newSettings.selectedOpenRouterModel =
      newSettings.aiProvider === 'openrouter'
        ? newSettings.selectedAiModel || 'openai/gpt-5.4-nano'
        : 'openai/gpt-5.4-nano'
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

  if (newSettings.agentNotificationsEnabled === undefined) {
    newSettings.agentNotificationsEnabled = true
  }

  newSettings.spamProtectionEnabled = newSettings.spamProtectionEnabled === true
  registerAgentDecisionSecret(newSettings.openaiApiKey)
  registerAgentDecisionSecret(newSettings.openrouterApiKey)
  const provider = newSettings.aiProvider
  const openai = newSettings.openaiApiKey
  const openrouter = newSettings.openrouterApiKey || ''
  if (
    !observedCredentials ||
    observedCredentials.provider !== provider ||
    observedCredentials.openai !== openai ||
    observedCredentials.openrouter !== openrouter
  ) {
    const stored = newSettings.agentDecisionAccountRevision
    observedCredentials = {
      provider,
      openai,
      openrouter,
      // The initial persisted opaque nonce is retained; renderer-provided replacements
      // never control a credential change after initialization.
      revision:
        !observedCredentials && typeof stored === 'string' && /^[a-f0-9-]{36}$/.test(stored)
          ? stored
          : randomUUID()
    }
  }
  newSettings.agentDecisionAccountRevision = observedCredentials.revision
  return newSettings
}

export function setSettings(newSettings: AppSettings) {
  const previous = settings
  settings = normalizeSettings(newSettings)
  settingsGeneration++
  for (const listener of listeners) listener(settings, previous)
}
