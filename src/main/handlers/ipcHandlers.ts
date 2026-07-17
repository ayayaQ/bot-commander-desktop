import { BrowserWindow, ipcMain, session, dialog, shell, Notification } from 'electron'
import { OAuth2Scopes, PermissionsBitField, WebhookClient } from 'discord.js'
import {
  getBotStateContext,
  saveBotState,
  getStartupJs,
  setStartupJs,
  restartJsEngine
} from '../utils/virtual'
import fs from 'fs/promises'
import {
  applyBotStatus,
  Connect,
  Disconnect,
  getClient,
  getCommands,
  setCommands
} from '../services/botService'
import {
  AppSettings,
  BCFDCommand,
  BCFDSlashCommand,
  BotStatus,
  BCFDInteractionCommand,
  WebhookPreset
} from '../types/types'
import {
  saveBotStatus,
  saveCommands,
  saveSettings,
  saveInteractions,
  getWebhookPresets,
  saveWebhookPresets,
  getOnboarding,
  saveOnboarding
} from '../services/fileService'
import {
  getInteractions,
  setInteractions,
  findInteractionById
} from '../services/interactionService'
import { decodeBCFDCommandArray } from '../../shared/commandCodec'
import type { AgentPlanDecision, AgentStreamEvent } from '../../shared/agentTypes'
import {
  registerSlashCommand,
  unregisterSlashCommand,
  syncAllSlashCommands
} from '../services/slashCommandRegistry'
import { getSettings, setSettings } from '../services/settingsService'
import { fetchAiModels, getAiProvider } from '../services/aiProviderService'
import { getBotStatus, setBotStatus } from '../services/statusService'
import { getStatsInstance } from '../utils/stats'
import { checkForUpdates } from '../services/updateService'
import { addApiAuthHandlers } from './apiAuthHandlers'
import { addCommandRepoHandlers } from './commandRepoHandlers'
import {
  cancelAgentRun,
  createAgentSession,
  deleteAgentSession,
  loadAgentSessions,
  resolveAgentApproval,
  resolveAgentPlan,
  runAgentSession,
  setActiveAgentSession,
  setAgentEventSink,
  updateAgentSession
} from '../services/agentService'
import {
  getAgentNotificationDetails,
  shouldShowAgentNotification
} from '../services/agentNotification'
import {
  commitMemoryMutation,
  loadAgentMemories,
  prepareCreateMemory,
  prepareDeleteMemory,
  prepareUpdateMemory,
  setAgentMemoryEventSink
} from '../services/agentMemoryService'

const agentViewState = new Map<number, boolean>()

function isAgentViewActivelyVisible(): boolean {
  return BrowserWindow.getAllWindows().some(
    (window) =>
      agentViewState.get(window.webContents.id) === true && window.isVisible() && window.isFocused()
  )
}

function showAgentNotification(payload: AgentStreamEvent): void {
  if (
    !shouldShowAgentNotification(payload, {
      enabled: getSettings().agentNotificationsEnabled,
      agentViewActive: isAgentViewActivelyVisible(),
      supported: Notification.isSupported()
    })
  )
    return
  const details = getAgentNotificationDetails(payload)
  if (!details) return

  const notification = new Notification(details)
  notification.on('click', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    window.webContents.send('agent:navigate', payload.sessionId)
  })
  notification.show()
}

export function addWindowIPCHandlers(mainWindow: BrowserWindow) {
  ipcMain.on('minimize-window', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('maximize-window', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })

  ipcMain.on('close-window', () => {
    mainWindow?.close()
  })

  ipcMain.handle('is-window-maximized', () => {
    return mainWindow?.isMaximized() ?? false
  })

  ipcMain.handle('get-platform', () => {
    return process.platform
  })

  // Window state tracking
  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-state-changed', true)
  })

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-state-changed', false)
  })

  mainWindow.on('restore', () => {
    mainWindow.webContents.send('window-state-changed', mainWindow.isMaximized())
  })
}

export function addIPCHandlers() {
  setAgentEventSink((payload) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent:event', payload)
    }
    showAgentNotification(payload)
  })
  setAgentMemoryEventSink((memories) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('memory:changed', memories)
    }
  })

  ipcMain.on('agent:view-state', (event, active: boolean) => {
    agentViewState.set(event.sender.id, active)
  })

  ipcMain.on('connect', (event, token) => {
    Connect(event, token)
  })

  ipcMain.on('disconnect', (event) => {
    Disconnect(event)
  })

  ipcMain.handle('get-commands', () => {
    return getCommands()
  })

  ipcMain.handle(
    'save-commands',
    async (
      _,
      newCommands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] }
    ) => {
      setCommands(newCommands)
      await saveCommands()
      return true
    }
  )

  // Interaction Commands IPC handlers
  ipcMain.handle('get-interactions', () => {
    return getInteractions()
  })

  ipcMain.handle('save-interactions', async (_, newInteractions: BCFDInteractionCommand[]) => {
    setInteractions(newInteractions)
    await saveInteractions()
    return true
  })

  ipcMain.handle('register-slash-command', async (_, commandId: string) => {
    const interaction = findInteractionById(commandId)
    if (!interaction) {
      return { success: false, error: 'Command not found' }
    }

    try {
      await registerSlashCommand(interaction)
      interaction.isRegistered = true
      await saveInteractions()
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('unregister-slash-command', async (_, commandId: string) => {
    const interaction = findInteractionById(commandId)
    if (!interaction) {
      return { success: false, error: 'Command not found' }
    }

    try {
      await unregisterSlashCommand(interaction)
      interaction.isRegistered = false
      await saveInteractions()
      return { success: true }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('sync-all-slash-commands', async () => {
    const interactions = getInteractions()

    try {
      await syncAllSlashCommands(interactions)
      // Mark all as registered
      interactions.forEach((i) => (i.isRegistered = true))
      await saveInteractions()
      return { success: true, synced: interactions.length }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('get-settings', () => {
    return getSettings()
  })

  ipcMain.handle('save-settings', async (_, newSettings: AppSettings) => {
    setSettings(newSettings)
    await saveSettings()
    return getSettings()
  })

  ipcMain.handle('memory:list', () => loadAgentMemories())
  ipcMain.handle('memory:create', async (_, content: string) =>
    commitMemoryMutation(await prepareCreateMemory(content, 'user'))
  )
  ipcMain.handle(
    'memory:update',
    async (_, id: string, expectedRevision: string, content: string) =>
      commitMemoryMutation(
        await prepareUpdateMemory(id, expectedRevision, content, 'user')
      )
  )
  ipcMain.handle('memory:delete', async (_, id: string, expectedRevision: string) =>
    commitMemoryMutation(await prepareDeleteMemory(id, expectedRevision))
  )

  ipcMain.handle('fetch-ai-models', async () => {
    const settings = getSettings()
    const provider = getAiProvider(settings)
    const apiKey = provider === 'openrouter' ? settings.openrouterApiKey : settings.openaiApiKey
    return await fetchAiModels(provider, apiKey)
  })

  ipcMain.handle('get-bot-status', () => {
    return getBotStatus()
  })

  ipcMain.handle('save-bot-status', async (_, newBotStatus: BotStatus) => {
    setBotStatus(newBotStatus)
    await saveBotStatus()
    applyBotStatus(getBotStatus())
    return true
  })

  ipcMain.handle('get-onboarding', async () => {
    return await getOnboarding()
  })

  ipcMain.handle('save-onboarding', async (_, state) => {
    await saveOnboarding(state)
    return true
  })

  ipcMain.handle('generate-invite', async () => {
    const client = getClient()

    if (!client || !client.user) {
      throw new Error('Client is not connected')
    }

    try {
      const invite = client.generateInvite({
        scopes: [OAuth2Scopes.Bot],
        permissions: [PermissionsBitField.Flags.Administrator]
      })
      return invite
    } catch (error) {
      console.error('Error generating invite:', error)
      throw new Error('Failed to generate invite')
    }
  })

  ipcMain.handle('get-token', async () => {
    const cookies = await session.defaultSession.cookies.get({ name: 'token' })
    return cookies[0]?.value ?? ''
  })

  ipcMain.handle('getBotState', () => {
    const context = getBotStateContext()
    return context.getVariable('botState') ?? {}
  })

  ipcMain.handle('updateBotState', (_event, key: string, value: any) => {
    try {
      const context = getBotStateContext()
      const botState = context.getVariable('botState')
      const nextState: Record<string, unknown> =
        botState && typeof botState === 'object' ? { ...(botState as Record<string, unknown>) } : {}
      nextState[key] = value
      context.setVariable('botState', nextState)
      saveBotState() // Save the updated state
      return true
    } catch (error) {
      console.error('Error updating bot state:', error)
      return false
    }
  })

  ipcMain.handle('runCodeInContext', (_event, code: string) => {
    try {
      const context = getBotStateContext()
      const result = context.evaluate(code, { timeoutMs: 2000, wrapReturn: false })
      saveBotState() // Save the state in case it was modified
      return JSON.stringify(result, null, 2)
    } catch (error) {
      console.error('Error running code in context:', error)
      throw error
    }
  })

  // send a webhook using discord.js
  ipcMain.on('send-webhook', async (_event, webhook) => {
    const webhookClient = new WebhookClient({ url: webhook.webhookUrl })

    if (webhook.messageType === 'embed') {
      const embed = {
        title: webhook.embedTitle || undefined,
        description: webhook.embedDescription || undefined,
        color: webhook.embedColor ? parseInt(webhook.embedColor.replace('#', ''), 16) : undefined,
        footer: webhook.embedFooter ? { text: webhook.embedFooter } : undefined,
        image: webhook.embedImageUrl ? { url: webhook.embedImageUrl } : undefined,
        thumbnail: webhook.embedThumbnailUrl ? { url: webhook.embedThumbnailUrl } : undefined
      }

      await webhookClient.send({
        username: webhook.name ?? undefined,
        avatarURL: webhook.avatarUrl ?? undefined,
        embeds: [embed]
      })
    } else {
      await webhookClient.send({
        username: webhook.name ?? undefined,
        avatarURL: webhook.avatarUrl ?? undefined,
        content: webhook.message ?? undefined
      })
    }

    webhookClient.destroy()
    getStatsInstance().incrementWebhooksSent()
  })

  ipcMain.handle('get-stats', () => {
    return getStatsInstance().getStats()
  })

  // Startup JS IPC handlers
  ipcMain.handle('get-startup-js', async () => {
    return await getStartupJs()
  })

  ipcMain.handle('set-startup-js', async (_event, js: string) => {
    await setStartupJs(js)
    return true
  })

  ipcMain.handle('restart-js-engine', async () => {
    await restartJsEngine()
    return true
  })

  ipcMain.handle('get-webhook-presets', async () => {
    return await getWebhookPresets()
  })

  ipcMain.handle('save-webhook-presets', async (_, presets: WebhookPreset[]) => {
    await saveWebhookPresets(presets)
    return true
  })

  // Export commands to JSON file
  ipcMain.handle('export-commands', async () => {
    const commands = getCommands()
    const result = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow()!, {
      title: 'Export Commands',
      defaultPath: 'commands.json',
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })

    if (!result.canceled && result.filePath) {
      try {
        // Strip IDs before export (they are internal identifiers)
        const commandsToExport = commands.bcfdCommands.map(({ id, ...rest }) => rest)
        await fs.writeFile(result.filePath, JSON.stringify(commandsToExport, null, 2))
        return { success: true }
      } catch (error) {
        console.error('Error exporting commands:', error)
        return { success: false, error: (error as Error).message }
      }
    }
    return { success: false, canceled: true }
  })

  // Import commands from JSON file
  ipcMain.handle('import-commands', async () => {
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, {
      title: 'Import Commands',
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })

    if (!result.canceled && result.filePaths.length > 0) {
      try {
        const data = await fs.readFile(result.filePaths[0], 'utf-8')
        const importedCommands = decodeBCFDCommandArray(JSON.parse(data)).map(
          ({ command }) => command
        )
        return { success: true, commands: importedCommands }
      } catch (error) {
        console.error('Error importing commands:', error)
        return { success: false, error: (error as Error).message }
      }
    }
    return { success: false, canceled: true }
  })

  // Open external URLs in default browser
  ipcMain.handle('open-external-url', async (_event, url: string) => {
    try {
      await shell.openExternal(url)
      return { success: true }
    } catch (error) {
      console.error('Error opening external URL:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Check for updates
  ipcMain.handle('check-for-updates', async () => {
    try {
      const updateInfo = await checkForUpdates()
      return updateInfo
    } catch (error) {
      console.error('Error checking for updates:', error)
      throw error
    }
  })

  // Global agent harness
  ipcMain.handle('agent:list', async () => loadAgentSessions())
  ipcMain.handle('agent:create', async (_, title?: string) =>
    createAgentSession(getSettings(), title)
  )
  ipcMain.handle('agent:delete', async (_, sessionId: string) => deleteAgentSession(sessionId))
  ipcMain.handle('agent:update', async (_, sessionId: string, updates) =>
    updateAgentSession(sessionId, updates, getAiProvider(getSettings()))
  )
  ipcMain.handle('agent:set-active', async (_, sessionId: string | null) => {
    await setActiveAgentSession(sessionId)
    return true
  })
  ipcMain.handle('agent:send', async (_, sessionId: string, content: string) =>
    runAgentSession(sessionId, content, getSettings())
  )
  ipcMain.handle(
    'agent:resolve-plan',
    async (_, sessionId: string, decision: AgentPlanDecision) =>
      resolveAgentPlan(sessionId, decision, getSettings())
  )
  ipcMain.handle(
    'agent:approve',
    async (_, sessionId: string, toolCallId: string, approved: boolean) =>
      resolveAgentApproval(sessionId, toolCallId, approved)
  )
  ipcMain.handle('agent:cancel', (_, sessionId: string) => cancelAgentRun(sessionId))

  // Register API auth handlers
  addApiAuthHandlers()

  // Register command repository handlers
  addCommandRepoHandlers()
}
