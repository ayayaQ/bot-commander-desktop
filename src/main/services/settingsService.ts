import { AppSettings } from '../types/types'
import { selectedReviewer } from '../../shared/providerSelection'
import { randomUUID } from 'node:crypto'
import { registerAgentDecisionSecret } from './agentDecisionPrivacy'

let observedCredentials: { provider: string; key: string; revision: string }
let observedWeb: {
  provider: string
  source: string
  key: string
  storedKey: string
  revision: string
}
let observedChat: { key: string; revision: string }
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
  deepseekApiKey: '',
  deepseekChatAccountRevision: randomUUID(),
  webProvider: 'disabled',
  agentWebAccountRevision: randomUUID(),
  deepseekWebKeySource: 'separate',
  deepseekWebApiKey: '',
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

  if (!['openai', 'openrouter', 'deepseek'].includes(newSettings.aiProvider || '')) {
    newSettings.aiProvider = 'openai'
  }

  if (!newSettings.openrouterApiKey) {
    newSettings.openrouterApiKey = ''
  }

  newSettings.deepseekApiKey ||= ''
  newSettings.deepseekWebApiKey ||= ''
  newSettings.webProvider = newSettings.webProvider === 'deepseek' ? 'deepseek' : 'disabled'
  newSettings.deepseekWebKeySource =
    newSettings.deepseekWebKeySource === 'chat' ? 'chat' : 'separate'
  if (!['openai', 'openrouter'].includes(newSettings.agentReviewerProvider || ''))
    delete newSettings.agentReviewerProvider
  newSettings.selectedDeepSeekModel ||= 'deepseek-flash'

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
    newSettings.aiProvider === 'deepseek'
      ? newSettings.selectedDeepSeekModel
      : newSettings.aiProvider === 'openrouter'
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
  registerAgentDecisionSecret(newSettings.deepseekApiKey)
  registerAgentDecisionSecret(newSettings.deepseekWebApiKey)
  const provider = selectedReviewer(newSettings) || 'unconfigured'
  const key =
    provider === 'openai'
      ? newSettings.openaiApiKey
      : provider === 'openrouter'
        ? newSettings.openrouterApiKey || ''
        : ''
  if (
    !observedCredentials ||
    observedCredentials.provider !== provider ||
    observedCredentials.key !== key
  ) {
    const stored = newSettings.agentDecisionAccountRevision
    observedCredentials = {
      provider,
      key,
      // The initial persisted opaque nonce is retained; renderer-provided replacements
      // never control a credential change after initialization.
      revision:
        !observedCredentials && typeof stored === 'string' && /^[a-f0-9-]{36}$/.test(stored)
          ? stored
          : randomUUID()
    }
  }
  newSettings.agentDecisionAccountRevision = observedCredentials.revision
  if (!observedChat || observedChat.key !== newSettings.deepseekApiKey) {
    const stored = newSettings.deepseekChatAccountRevision
    observedChat = {
      key: newSettings.deepseekApiKey,
      revision:
        !observedChat && typeof stored === 'string' && /^[a-f0-9-]{36}$/.test(stored)
          ? stored
          : randomUUID()
    }
  }
  newSettings.deepseekChatAccountRevision = observedChat.revision
  delete newSettings.deepseekKeyConfigured
  delete newSettings.deepseekWebKeyConfigured
  const webProvider = newSettings.webProvider
  const source = newSettings.deepseekWebKeySource
  const webKey = source === 'chat' ? newSettings.deepseekApiKey : newSettings.deepseekWebApiKey
  if (
    !observedWeb ||
    observedWeb.provider !== webProvider ||
    observedWeb.source !== source ||
    observedWeb.key !== webKey ||
    observedWeb.storedKey !== newSettings.deepseekWebApiKey
  ) {
    const stored = newSettings.agentWebAccountRevision
    observedWeb = {
      provider: webProvider,
      source,
      key: webKey,
      storedKey: newSettings.deepseekWebApiKey,
      revision:
        !observedWeb && typeof stored === 'string' && /^[a-f0-9-]{36}$/.test(stored)
          ? stored
          : randomUUID()
    }
  }
  newSettings.agentWebAccountRevision = observedWeb.revision
  return newSettings
}

export function setSettings(newSettings: AppSettings) {
  const previous = settings
  settings = normalizeSettings(newSettings)
  settingsGeneration++
  for (const listener of listeners) listener(settings, previous)
}

/** New DeepSeek secrets are write-only across the renderer boundary. Legacy providers are unchanged. */
export function publicSettings(value?: AppSettings): AppSettings {
  // Establish the live baseline before exposing write nonces on a fresh installation.
  // Persisted settings are normalized during startup before this renderer boundary.
  if (!observedChat || !observedWeb || !observedCredentials)
    settings = normalizeSettings({ ...settings })
  value ??= settings
  const { deepseekApiKey, deepseekWebApiKey, ...safe } = value
  return {
    ...safe,
    deepseekKeyConfigured: !!deepseekApiKey?.trim(),
    deepseekWebKeyConfigured: !!deepseekWebApiKey?.trim()
  }
}
