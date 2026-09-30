import { app, safeStorage } from 'electron'
import { join } from 'path'
import crypto from 'crypto'
import {
  AppSettings,
  BCFDCommand,
  BCFDSlashCommand,
  BotStatus,
  BCFDInteractionCommand,
  WebhookPreset,
  OnboardingState
} from '../types/types'
import { getCommands, setCommands } from './botService'
import { getSettings, setSettings } from './settingsService'
import { getBotStatus, setBotStatus } from './statusService'
import { getInteractions, setInteractions } from './interactionService'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { atomicWriteJson, atomicWriteJsonText, readJsonWithBackup } from '../utils/atomicFile'

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

export async function loadCommands(): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json')
  try {
    const loaded = await readJsonWithBackup<{
      bcfdCommands: BCFDCommand[]
      bcfdSlashCommands?: BCFDSlashCommand[]
    }>(commandsPath)
    const commands = {
      bcfdCommands: loaded.value.bcfdCommands ?? [],
      bcfdSlashCommands: loaded.value.bcfdSlashCommands ?? []
    }

    if (loaded.recoveredFromBackup) {
      console.warn('Recovered commands from backup after the primary file could not be read')
    }

    // Normalize legacy command shapes into the canonical payload-derived model.
    let needsSave = false
    commands.bcfdCommands = commands.bcfdCommands.map((cmd) => {
      const decoded = decodeBCFDCommand(cmd, () => crypto.randomUUID())
      needsSave ||= decoded.migrated
      return decoded.command
    })

    setCommands(commands)

    // Save if we migrated any commands
    if (needsSave) {
      await saveCommands(commands)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with empty commands
      await atomicWriteJson(commandsPath, { bcfdCommands: [], bcfdSlashCommands: [] })
    } else {
      console.error('Error loading commands:', error)
    }
  }
}

export async function saveCommands(commands = getCommands()): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json')
  await atomicWriteJson(commandsPath, commands)
}

export async function persistCommands(commands: {
  bcfdCommands: BCFDCommand[]
  bcfdSlashCommands: BCFDSlashCommand[]
}): Promise<void> {
  await saveCommands(commands)
  setCommands(commands)
}

export async function saveSettings(settings = getSettings(), backup = true): Promise<void> {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  await atomicWriteJsonText(settingsPath, serializeSettings(settings), { backup })
}

export async function persistSettings(settings: AppSettings): Promise<AppSettings> {
  const previous = getSettings()
  setSettings(settings)
  const normalized = getSettings()
  try {
    await saveSettings(normalized)
    return normalized
  } catch (error) {
    setSettings(previous)
    throw error
  }
}

export async function loadBotStatus(): Promise<void> {
  const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
  try {
    const loaded = await readJsonWithBackup<BotStatus>(botStatusPath)
    setBotStatus(loaded.value)
    if (loaded.recoveredFromBackup) {
      console.warn('Recovered bot status from backup after the primary file could not be read')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with default bot status
      await atomicWriteJson(botStatusPath, getBotStatus())
    } else {
      console.error('Error loading bot status:', error)
    }
  }
}

export async function saveBotStatus(status = getBotStatus()): Promise<void> {
  const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
  await atomicWriteJson(botStatusPath, status)
}

export async function persistBotStatus(status: BotStatus): Promise<void> {
  await saveBotStatus(status)
  setBotStatus(status)
}

export async function loadSettings(): Promise<void> {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    const loaded = await readJsonWithBackup<AppSettings>(settingsPath)
    const storedSettings = loaded.value
    const settings = parseSettings(storedSettings)
    setSettings(settings)

    if (loaded.recoveredFromBackup) {
      console.warn('Recovered settings from backup after the primary file could not be read')
    }

    // Upgrade previously plaintext API keys as soon as they are read successfully.
    if (
      [storedSettings.openaiApiKey, storedSettings.openrouterApiKey].some(
        (secret) =>
          typeof secret === 'string' &&
          secret.length > 0 &&
          !secret.startsWith(ENCRYPTED_SECRET_PREFIX)
      )
    ) {
      // Do not retain a plaintext credential copy in the recovery backup.
      await saveSettings(settings, false)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with default settings
      await saveSettings()
    } else {
      console.error('Error loading settings:', error)
    }
  }
}

export async function loadInteractions(): Promise<void> {
  const interactionsPath = join(app.getPath('userData'), 'interactions.json')
  try {
    const loaded = await readJsonWithBackup<BCFDInteractionCommand[]>(interactionsPath)
    setInteractions(loaded.value)
    if (loaded.recoveredFromBackup) {
      console.warn('Recovered interactions from backup after the primary file could not be read')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with empty array
      await atomicWriteJson(interactionsPath, [])
    } else {
      console.error('Error loading interactions:', error)
    }
  }
}

export async function saveInteractions(interactions = getInteractions()): Promise<void> {
  const interactionsPath = join(app.getPath('userData'), 'interactions.json')
  await atomicWriteJson(interactionsPath, interactions)
}

export async function persistInteractions(interactions: BCFDInteractionCommand[]): Promise<void> {
  await saveInteractions(interactions)
  setInteractions(interactions)
}

export async function getWebhookPresets(): Promise<WebhookPreset[]> {
  const presetsPath = join(app.getPath('userData'), 'webhook_presets.json')
  try {
    const loaded = await readJsonWithBackup<WebhookPreset[]>(presetsPath)
    if (loaded.recoveredFromBackup) {
      console.warn('Recovered webhook presets from backup after the primary file could not be read')
    }
    return loaded.value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    console.error('Error loading webhook presets:', error)
    return []
  }
}

export async function saveWebhookPresets(presets: WebhookPreset[]): Promise<void> {
  const presetsPath = join(app.getPath('userData'), 'webhook_presets.json')
  await atomicWriteJson(presetsPath, presets)
}

export async function getOnboarding(): Promise<OnboardingState> {
  const onboardingPath = join(app.getPath('userData'), 'onboarding.json')
  try {
    const loaded = await readJsonWithBackup<OnboardingState>(onboardingPath)
    if (loaded.recoveredFromBackup) {
      console.warn(
        'Recovered onboarding state from backup after the primary file could not be read'
      )
    }
    return loaded.value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { stepperDismissed: false, botHostedOnce: false, dismissedTips: [] }
    }
    console.error('Error loading onboarding:', error)
    return { stepperDismissed: false, botHostedOnce: false, dismissedTips: [] }
  }
}

export async function saveOnboarding(state: OnboardingState): Promise<void> {
  const onboardingPath = join(app.getPath('userData'), 'onboarding.json')
  await atomicWriteJson(onboardingPath, state)
}
