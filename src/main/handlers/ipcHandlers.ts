import { BrowserWindow, ipcMain, session, dialog, shell } from 'electron'
import crypto from 'crypto'
import { OAuth2Scopes, PermissionsBitField, WebhookClient } from 'discord.js'
import {
  getBotStateContext,
  saveBotState,
  getStartupJs,
  setStartupJs,
  restartJsEngine
} from '../utils/virtual'
import vm from 'node:vm'
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
  saveWebhookPresets
} from '../services/fileService'
import {
  getInteractions,
  setInteractions,
  findInteractionById
} from '../services/interactionService'
import {
  registerSlashCommand,
  unregisterSlashCommand,
  syncAllSlashCommands
} from '../services/slashCommandRegistry'
import { getSettings, setSettings } from '../services/settingsService'
import { getBotStatus, setBotStatus } from '../services/statusService'
import { getStatsInstance } from '../utils/stats'
import { checkForUpdates } from '../services/updateService'
import {
  loadChats,
  saveChats,
  getChats,
  getChat,
  createChat,
  updateChat,
  deleteChat,
  addMessageToChat,
  updateMessageInChat,
  updateChatContexts,
  clearChatMessages,
  setActiveChat,
  getActiveChat,
  getRecentChats,
  searchChats,
  executeAiCommandChat,
  type SavedChat,
  type ChatContext,
  type ChatMessage
} from '../services/chatService'
import { addApiAuthHandlers } from './apiAuthHandlers'
import { addCommandRepoHandlers } from './commandRepoHandlers'

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
    return true
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
    return vm.runInContext('JSON.parse(JSON.stringify(botState))', context)
  })

  ipcMain.handle('updateBotState', (_event, key: string, value: any) => {
    try {
      const context = getBotStateContext()
      vm.runInContext(`botState['${key}'] = ${JSON.stringify(value)}`, context)
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
      const result = vm.runInContext(code, context, { timeout: 2000, breakOnSigint: true })
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
        const importedCommands = JSON.parse(data) as BCFDCommand[]
        // Add IDs to imported commands that don't have them
        for (const cmd of importedCommands) {
          if (!cmd.id) {
            cmd.id = crypto.randomUUID()
          }
        }
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

  // AI Command Chat - Multi-turn conversation for editing commands
  ipcMain.handle(
    'ai-command-chat',
    async (
      event,
      payload: {
        messages: Array<{ role: string; content: string }>
        currentCommand: BCFDCommand
        model: string
        additionalContext?: string
      }
    ) => {
      const settings = getSettings()

      if (!settings.openaiApiKey) {
        return { error: 'OpenAI API key not configured. Please add your API key in Settings.' }
      }

      const win = BrowserWindow.fromWebContents(event.sender)

      try {
        await executeAiCommandChat(
          payload,
          {
            openaiApiKey: settings.openaiApiKey,
            openaiModel: settings.openaiModel,
            disableReasoningApi: settings.disableReasoningApi
          },
          {
            onThinking: (delta, accumulated) => {
              win?.webContents.send('ai-chat:thinking', { delta, accumulated })
            },
            onDone: (result) => {
              win?.webContents.send('ai-chat:done', result)
            },
            onError: (error) => {
              win?.webContents.send('ai-chat:error', { error })
            }
          }
        )

        return { streaming: true }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
        win?.webContents.send('ai-chat:error', { error: errorMessage })
        return { streaming: true, error: errorMessage }
      }
    }
  )

  // Chat persistence IPC handlers
  ipcMain.handle('load-chats', async () => {
    return await loadChats()
  })

  ipcMain.handle('save-chats', async () => {
    await saveChats()
    return true
  })

  ipcMain.handle('get-chats', () => {
    return getChats()
  })

  ipcMain.handle('get-chat', (_, chatId: string) => {
    return getChat(chatId)
  })

  ipcMain.handle(
    'create-chat',
    (_, payload: { title: string; commandId?: string; contexts?: ChatContext[] }) => {
      const chat = createChat(payload.title, payload.commandId, payload.contexts || [])
      saveChats() // Auto-save
      return chat
    }
  )

  ipcMain.handle('update-chat', async (_, chatId: string, updates: Partial<SavedChat>) => {
    const result = updateChat(chatId, updates)
    if (result) await saveChats()
    return result
  })

  ipcMain.handle('delete-chat', async (_, chatId: string) => {
    const result = deleteChat(chatId)
    if (result) await saveChats()
    return result
  })

  ipcMain.handle('add-message-to-chat', async (_, chatId: string, message: ChatMessage) => {
    const result = addMessageToChat(chatId, message)
    if (result) await saveChats()
    return result
  })

  ipcMain.handle(
    'update-message-in-chat',
    async (_, chatId: string, messageId: string, updates: Partial<ChatMessage>) => {
      const result = updateMessageInChat(chatId, messageId, updates)
      if (result) await saveChats()
      return result
    }
  )

  ipcMain.handle('update-chat-contexts', async (_, chatId: string, contexts: ChatContext[]) => {
    const result = updateChatContexts(chatId, contexts)
    if (result) await saveChats()
    return result
  })

  ipcMain.handle('clear-chat-messages', async (_, chatId: string) => {
    const result = clearChatMessages(chatId)
    if (result) await saveChats()
    return result
  })

  ipcMain.handle('set-active-chat', (_, chatId: string | null) => {
    setActiveChat(chatId)
    saveChats()
    return true
  })

  ipcMain.handle('get-active-chat', () => {
    return getActiveChat()
  })

  ipcMain.handle('get-recent-chats', (_, limit?: number) => {
    return getRecentChats(limit)
  })

  ipcMain.handle('search-chats', (_, query: string) => {
    return searchChats(query)
  })

  // Register API auth handlers
  addApiAuthHandlers()

  // Register command repository handlers
  addCommandRepoHandlers()
}
