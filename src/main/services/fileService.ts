import { app, safeStorage } from 'electron'
import { join } from 'path'
import crypto from 'crypto'
import {
  AppSettings,
  BotStatus,
  BCFDInteractionCommand,
  WebhookPreset,
  OnboardingState
} from '../types/types'
import { getCommands, setCommands } from './botService'
import { getSettings, setSettings, normalizeSettings } from './settingsService'
import { getBotStatus, setBotStatus } from './statusService'
import { getInteractions, setInteractions } from './interactionService'
import { decodeBCFDCommand } from '../../shared/commandCodec'

import { atomicWrite, readWithBackup } from './atomicPersistence'

const ENCRYPTED_SECRET_PREFIX = 'bcfd-encrypted:v1:'

function isSecureCredentialStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  // Electron's Linux fallback stores values in plaintext when no secret service is available.
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function encryptSecret(value: string | undefined): string {
  if (!value) return ''
  if (!isSecureCredentialStorageAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system')
  }
  return ENCRYPTED_SECRET_PREFIX + safeStorage.encryptString(value).toString('base64')
}

function decryptSecret(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  if (!value.startsWith(ENCRYPTED_SECRET_PREFIX)) return value
  if (!isSecureCredentialStorageAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system')
  }
  return safeStorage.decryptString(
    Buffer.from(value.slice(ENCRYPTED_SECRET_PREFIX.length), 'base64')
  )
}

function serializeSettings(settings: AppSettings): string {
  return JSON.stringify(
    {
      ...settings,
      openaiApiKey: encryptSecret(settings.openaiApiKey),
      openrouterApiKey: encryptSecret(settings.openrouterApiKey)
    },
    null,
    2
  )
}

function parseSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    openaiApiKey: decryptSecret(settings.openaiApiKey),
    openrouterApiKey: decryptSecret(settings.openrouterApiKey)
  }
}

function objectValue(data: string): Record<string, unknown> {
  const value = JSON.parse(data)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a persisted object')
  }
  return value
}

function arrayValue<T>(data: string): T[] {
  const value = JSON.parse(data)
  if (!Array.isArray(value)) throw new Error('Expected a persisted array')
  return value
}

type Commands = ReturnType<typeof getCommands>
function parseCommands(data: string): Commands {
  const value = objectValue(data)
  if (!Array.isArray(value.bcfdCommands)) throw new Error('Invalid persisted commands')
  if (value.bcfdSlashCommands !== undefined && !Array.isArray(value.bcfdSlashCommands)) {
    throw new Error('Invalid persisted slash commands')
  }
  const ids = new Set<string>()
  value.bcfdCommands.forEach((command) => {
    const decoded = decodeBCFDCommand(command, () => 'validation-only')
    if (command.id) {
      if (ids.has(decoded.command.id)) throw new Error('Duplicate persisted command id')
      ids.add(decoded.command.id)
    }
  })
  return value as unknown as Commands
}

const userFile = (name: string) => join(app.getPath('userData'), name)
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

export async function loadCommands(): Promise<void> {
  try {
    const stored = await readWithBackup(userFile('commands.json'), parseCommands)
    let migrated = false
    const commands = {
      ...stored,
      bcfdSlashCommands: stored.bcfdSlashCommands ?? [],
      bcfdCommands: stored.bcfdCommands.map((command) => {
        const decoded = decodeBCFDCommand(command, () => crypto.randomUUID())
        migrated ||= decoded.migrated
        return decoded.command
      })
    }
    if (migrated) await saveCommands(commands)
    setCommands(commands)
  } catch (error) {
    if (missing(error)) await saveCommands({ bcfdCommands: [], bcfdSlashCommands: [] })
    else console.error('Error loading commands:', error)
  }
}

export async function saveCommands(commands: Commands = getCommands()): Promise<void> {
  await atomicWrite(userFile('commands.json'), JSON.stringify(commands, null, 2), {
    validate: parseCommands
  })
}

function parseStoredSettings(data: string): AppSettings {
  const settings = objectValue(data)
  for (const key of ['openaiApiKey', 'openrouterApiKey']) {
    if (settings[key] !== undefined && typeof settings[key] !== 'string') {
      throw new Error('Invalid persisted credential')
    }
  }
  return settings as unknown as AppSettings
}

export async function saveSettings(settings: AppSettings = getSettings()): Promise<void> {
  const data = serializeSettings(settings)
  await atomicWrite(userFile('settings.json'), data, {
    validate: (previous) => {
      parseSettings(parseStoredSettings(previous))
    },
    backupTransform: (previous) => serializeSettings(parseSettings(parseStoredSettings(previous)))
  })
}

export async function loadSettings(): Promise<void> {
  try {
    const stored = await readWithBackup(userFile('settings.json'), (data) => {
      const raw = parseStoredSettings(data)
      return { raw, settings: normalizeSettings(parseSettings(raw)) }
    })
    // Secure migration must succeed before the credentials become live.
    if (
      [stored.raw.openaiApiKey, stored.raw.openrouterApiKey].some(
        (secret) => secret && !secret.startsWith(ENCRYPTED_SECRET_PREFIX)
      )
    )
      await saveSettings(stored.settings)
    setSettings(stored.settings)
  } catch (error) {
    if (missing(error)) await saveSettings()
    else console.error('Error loading settings:', error)
  }
}

function parseStatus(data: string): BotStatus {
  const status = objectValue(data)
  for (const key of ['status', 'activity', 'activityDetails', 'streamUrl']) {
    if (typeof status[key] !== 'string') throw new Error('Invalid persisted bot status')
  }
  return status as unknown as BotStatus
}

function parseOnboarding(data: string): OnboardingState {
  const state = objectValue(data)
  if (
    typeof state.stepperDismissed !== 'boolean' ||
    typeof state.botHostedOnce !== 'boolean' ||
    !Array.isArray(state.dismissedTips) ||
    state.dismissedTips.some((tip) => typeof tip !== 'string')
  ) {
    throw new Error('Invalid persisted onboarding state')
  }
  return state as unknown as OnboardingState
}

export async function loadBotStatus(): Promise<void> {
  try {
    const status = await readWithBackup(userFile('botStatus.json'), parseStatus)
    setBotStatus(status)
  } catch (error) {
    if (missing(error)) await saveBotStatus()
    else console.error('Error loading bot status:', error)
  }
}

export async function saveBotStatus(status: BotStatus = getBotStatus()): Promise<void> {
  await atomicWrite(userFile('botStatus.json'), JSON.stringify(status, null, 2), {
    validate: parseStatus
  })
}

export async function loadInteractions(): Promise<void> {
  try {
    setInteractions(
      await readWithBackup(userFile('interactions.json'), arrayValue<BCFDInteractionCommand>)
    )
  } catch (error) {
    if (missing(error)) await saveInteractions([])
    else console.error('Error loading interactions:', error)
  }
}

export async function saveInteractions(
  interactions: BCFDInteractionCommand[] = getInteractions()
): Promise<void> {
  await atomicWrite(userFile('interactions.json'), JSON.stringify(interactions, null, 2), {
    validate: arrayValue
  })
}

export async function getWebhookPresets(): Promise<WebhookPreset[]> {
  try {
    return await readWithBackup(userFile('webhook_presets.json'), arrayValue<WebhookPreset>)
  } catch (error) {
    if (!missing(error)) console.error('Error loading webhook presets:', error)
    return []
  }
}

export async function saveWebhookPresets(presets: WebhookPreset[]): Promise<void> {
  await atomicWrite(userFile('webhook_presets.json'), JSON.stringify(presets, null, 2), {
    validate: arrayValue
  })
}

export async function getOnboarding(): Promise<OnboardingState> {
  try {
    return await readWithBackup(userFile('onboarding.json'), parseOnboarding)
  } catch (error) {
    if (!missing(error)) console.error('Error loading onboarding:', error)
    return { stepperDismissed: false, botHostedOnce: false, dismissedTips: [] }
  }
}

export async function saveOnboarding(state: OnboardingState): Promise<void> {
  await atomicWrite(userFile('onboarding.json'), JSON.stringify(state, null, 2), {
    validate: parseOnboarding
  })
}
