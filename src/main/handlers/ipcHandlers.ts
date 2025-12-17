import { BrowserWindow, ipcMain, session, dialog, shell } from 'electron'
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
import { AppSettings, BCFDCommand, BCFDSlashCommand, BotStatus } from '../types/types'
import { saveBotStatus, saveCommands, saveSettings } from '../services/fileService'
import { getSettings, setSettings } from '../services/settingsService'
import { getBotStatus, setBotStatus } from '../services/statusService'
import { getStatsInstance } from '../utils/stats'
import { checkForUpdates } from '../services/updateService'
import OpenAI from 'openai'

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
    await webhookClient.send({
      username: webhook.name ?? undefined,
      avatarURL: webhook.avatarUrl ?? undefined,
      content: webhook.message ?? undefined
    })
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
        await fs.writeFile(result.filePath, JSON.stringify(commands.bcfdCommands, null, 2))
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
      _,
      payload: {
        messages: Array<{ role: string; content: string }>
        currentCommand: BCFDCommand
        model: string
        systemPrompt: string
      }
    ) => {
      const settings = getSettings()

      if (!settings.openaiApiKey) {
        return { error: 'OpenAI API key not configured. Please add your API key in Settings.' }
      }

      try {
        const openai = new OpenAI({
          apiKey: settings.openaiApiKey
        })

        // Build messages array with system context
        const apiMessages: OpenAI.ChatCompletionMessageParam[] = [
          {
            role: 'system',
            content: payload.systemPrompt
          },
          {
            role: 'system',
            content: `Current command state:\n${JSON.stringify(payload.currentCommand, null, 2)}`
          }
        ]

        // Add developer prompt if set
        if (settings.developerPrompt) {
          apiMessages.push({
            role: 'system',
            content: `Additional context from developer: ${settings.developerPrompt}`
          })
        }

        // Add conversation history
        for (const msg of payload.messages) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            apiMessages.push({
              role: msg.role as 'user' | 'assistant',
              content: msg.content
            })
          }
        }

        // Define structured output schema for command updates
        const responseSchema = {
          type: 'object',
          properties: {
            explanation: {
              type: 'string',
              description: 'A brief explanation of the changes being made'
            },
            hasChanges: {
              type: 'boolean',
              description: 'Whether any changes are being proposed to the command'
            },
            updatedCommand: {
              anyOf: [
                { type: 'null' },
                {
                  type: 'object',
                  properties: {
                    command: { type: 'string' },
                    commandDescription: { type: 'string' },
                    type: { type: 'number' },
                    channelMessage: { type: 'string' },
                    privateMessage: { type: 'string' },
                    actionArr: {
                      type: 'array',
                      items: { type: 'boolean' }
                    },
                    sendChannelEmbed: { type: 'boolean' },
                    sendPrivateEmbed: { type: 'boolean' },
                    channelEmbed: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        hexColor: { type: 'string' },
                        imageURL: { type: 'string' },
                        thumbnailURL: { type: 'string' },
                        footer: { type: 'string' }
                      },
                      required: [
                        'title',
                        'description',
                        'hexColor',
                        'imageURL',
                        'thumbnailURL',
                        'footer'
                      ],
                      additionalProperties: false
                    },
                    privateEmbed: {
                      type: 'object',
                      properties: {
                        title: { type: 'string' },
                        description: { type: 'string' },
                        hexColor: { type: 'string' },
                        imageURL: { type: 'string' },
                        thumbnailURL: { type: 'string' },
                        footer: { type: 'string' }
                      },
                      required: [
                        'title',
                        'description',
                        'hexColor',
                        'imageURL',
                        'thumbnailURL',
                        'footer'
                      ],
                      additionalProperties: false
                    },
                    isSpecificChannel: { type: 'boolean' },
                    specificChannel: { type: 'string' },
                    isReact: { type: 'boolean' },
                    reaction: { type: 'string' },
                    deleteIf: { type: 'boolean' },
                    deleteIfStrings: { type: 'string' },
                    deleteAfter: { type: 'boolean' },
                    deleteX: { type: 'boolean' },
                    deleteNum: { type: 'number' },
                    isRoleAssigner: { type: 'boolean' },
                    roleToAssign: { type: 'string' },
                    isKick: { type: 'boolean' },
                    isBan: { type: 'boolean' },
                    isVoiceMute: { type: 'boolean' },
                    isRequiredRole: { type: 'boolean' },
                    requiredRole: { type: 'string' },
                    isAdmin: { type: 'boolean' },
                    phrase: { type: 'boolean' },
                    startsWith: { type: 'boolean' },
                    isNSFW: { type: 'boolean' },
                    isSpecificMessage: { type: 'boolean' },
                    specificMessage: { type: 'string' },
                    ignoreErrorMessage: { type: 'boolean' }
                  },
                  required: [
                    'command',
                    'commandDescription',
                    'type',
                    'channelMessage',
                    'privateMessage',
                    'actionArr',
                    'sendChannelEmbed',
                    'sendPrivateEmbed',
                    'channelEmbed',
                    'privateEmbed',
                    'isSpecificChannel',
                    'specificChannel',
                    'isReact',
                    'reaction',
                    'deleteIf',
                    'deleteIfStrings',
                    'deleteAfter',
                    'deleteX',
                    'deleteNum',
                    'isRoleAssigner',
                    'roleToAssign',
                    'isKick',
                    'isBan',
                    'isVoiceMute',
                    'isRequiredRole',
                    'requiredRole',
                    'isAdmin',
                    'phrase',
                    'startsWith',
                    'isNSFW',
                    'isSpecificMessage',
                    'specificMessage',
                    'ignoreErrorMessage'
                  ],
                  additionalProperties: false
                }
              ],
              description:
                'The updated command object with changes applied (null when hasChanges is false)'
            }
          },
          required: ['explanation', 'hasChanges', 'updatedCommand'],
          additionalProperties: false
        } as const

        const completion = await openai.beta.chat.completions.parse({
          model: payload.model || settings.openaiModel || 'gpt-4.1-nano',
          messages: apiMessages,
          temperature: 0.7,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'command_update_response',
              strict: true,
              schema: responseSchema
            }
          }
        })

        const parsed = completion.choices[0]?.message?.parsed as any
        const tokenCount = completion.usage?.total_tokens || 0

        if (!parsed) {
          return {
            error: 'Failed to parse AI response',
            tokenCount
          }
        }

        return {
          explanation: parsed.explanation,
          hasChanges: parsed.hasChanges,
          updatedCommand: parsed.hasChanges ? parsed.updatedCommand : null,
          tokenCount
        }
      } catch (error) {
        console.error('AI Command Chat error:', error)
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
        return { error: errorMessage }
      }
    }
  )
}
