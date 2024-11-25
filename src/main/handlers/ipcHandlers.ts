import { BrowserWindow, ipcMain, session } from 'electron'
import { OAuth2Scopes, PermissionsBitField, WebhookClient } from 'discord.js'
import { getBotStateContext, saveBotState } from '../virtual'
import vm from 'node:vm'
import { applyBotStatus, Connect, Disconnect, getClient, getCommands, setCommands } from '../services/botService'
import { AppSettings, BCFDCommand, BCFDSlashCommand, BotStatus } from '../types/types'
import { saveBotStatus, saveCommands, saveSettings } from '../services/fileService'
import { getSettings, setSettings } from '../services/settingsService'
import { getBotStatus, setBotStatus } from '../services/statusService'
import { getStatsInstance } from '../stats'

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
        const context = getBotStateContext();
        vm.runInContext(`botState['${key}'] = ${JSON.stringify(value)}`, context);
        saveBotState(); // Save the updated state
        return true;
      } catch (error) {
        console.error('Error updating bot state:', error);
        return false;
      }
    });
  
    ipcMain.handle('runCodeInContext', (_event, code: string) => {
      try {
        const context = getBotStateContext();
        const result = vm.runInContext(code, context);
        saveBotState(); // Save the state in case it was modified
        return JSON.stringify(result, null, 2);
      } catch (error) {
        console.error('Error running code in context:', error);
        throw error;
      }
    });
  
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
  
    ipcMain.on('minimize-window', () => {
      BrowserWindow.getFocusedWindow()?.minimize()
    })
  
    ipcMain.on('maximize-window', () => {
      const win = BrowserWindow.getFocusedWindow()
      if (win?.isMaximized()) {
        win.unmaximize()
      } else {
        win?.maximize()
      }
    })
  
    ipcMain.on('close-window', () => {
      BrowserWindow.getFocusedWindow()?.close()
    })
  }