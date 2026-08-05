import { app, safeStorage } from 'electron'
import { join } from 'path'
import fs from 'fs/promises'
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
    const data = await fs.readFile(commandsPath, 'utf-8')
    let commands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] } =
      JSON.parse(data)

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
      await saveCommands()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with empty commands
      await fs.writeFile(commandsPath, JSON.stringify({ bcfdCommands: [] }))
    } else {
      console.error('Error loading commands:', error)
    }
  }
}

export async function saveCommands(): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json')
  try {
    await fs.writeFile(commandsPath, JSON.stringify(getCommands(), null, 2))
  } catch (error) {
    console.error('Error saving commands:', error)
  }
}

export async function saveSettings(): Promise<void> {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    await fs.writeFile(settingsPath, serializeSettings(getSettings()))
  } catch (error) {
    console.error('Error saving settings:', error)
  }
}

export async function loadBotStatus(): Promise<void> {
  const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
  try {
    const data = await fs.readFile(botStatusPath, 'utf-8')
    let botStatus = JSON.parse(data) as BotStatus
    setBotStatus(botStatus)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with default bot status
      await fs.writeFile(botStatusPath, JSON.stringify(getBotStatus(), null, 2))
    } else {
      console.error('Error loading bot status:', error)
    }
  }
}

export async function saveBotStatus(): Promise<void> {
  const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
  try {
    await fs.writeFile(botStatusPath, JSON.stringify(getBotStatus(), null, 2))
  } catch (error) {
    console.error('Error saving bot status:', error)
  }
}

export async function loadSettings(): Promise<void> {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    const data = await fs.readFile(settingsPath, 'utf-8')
    const storedSettings = JSON.parse(data) as AppSettings
    const settings = parseSettings(storedSettings)
    setSettings(settings)

    // Upgrade previously plaintext API keys as soon as they are read successfully.
    if (
      [storedSettings.openaiApiKey, storedSettings.openrouterApiKey].some(
        (secret) => typeof secret === 'string' && secret.length > 0 && !secret.startsWith(ENCRYPTED_SECRET_PREFIX)
      )
    ) {
      await fs.writeFile(settingsPath, serializeSettings(settings))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with default settings
      await fs.writeFile(settingsPath, JSON.stringify(getSettings(), null, 2))
    } else {
      console.error('Error loading settings:', error)
    }
  }
}

export async function loadInteractions(): Promise<void> {
  const interactionsPath = join(app.getPath('userData'), 'interactions.json')
  try {
    const data = await fs.readFile(interactionsPath, 'utf-8')
    const interactions = JSON.parse(data) as BCFDInteractionCommand[]
    setInteractions(interactions)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with empty array
      await fs.writeFile(interactionsPath, JSON.stringify([]))
    } else {
      console.error('Error loading interactions:', error)
    }
  }
}

export async function saveInteractions(): Promise<void> {
  const interactionsPath = join(app.getPath('userData'), 'interactions.json')
  try {
    await fs.writeFile(interactionsPath, JSON.stringify(getInteractions(), null, 2))
  } catch (error) {
    console.error('Error saving interactions:', error)
  }
}

export async function getWebhookPresets(): Promise<WebhookPreset[]> {
  const presetsPath = join(app.getPath('userData'), 'webhook_presets.json')
  try {
    const data = await fs.readFile(presetsPath, 'utf-8')
    return JSON.parse(data)
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
  try {
    await fs.writeFile(presetsPath, JSON.stringify(presets, null, 2))
  } catch (error) {
    console.error('Error saving webhook presets:', error)
  }
}

export async function getOnboarding(): Promise<OnboardingState> {
  const onboardingPath = join(app.getPath('userData'), 'onboarding.json')
  try {
    const data = await fs.readFile(onboardingPath, 'utf-8')
    return JSON.parse(data) as OnboardingState
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
  try {
    await fs.writeFile(onboardingPath, JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('Error saving onboarding:', error)
  }
}
