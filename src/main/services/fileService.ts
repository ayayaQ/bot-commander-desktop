import { app } from "electron"
import { join } from "path"
import fs from 'fs/promises'
import { AppSettings, BCFDCommand, BCFDSlashCommand, BotStatus } from "../types/types"
import { getCommands, setCommands } from "./botService";
import { getSettings, setSettings } from "./settingsService";
import { getBotStatus, setBotStatus } from "./statusService";

export async function loadCommands(): Promise<void> {
    const commandsPath = join(app.getPath('userData'), 'commands.json')
    try {
      const data = await fs.readFile(commandsPath, 'utf-8')
      let commands : { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] } = JSON.parse(data)
        setCommands(commands);
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
      await fs.writeFile(settingsPath, JSON.stringify(getSettings(), null, 2))
    } catch (error) {
      console.error('Error saving settings:', error)
    }
  }
  
export async function loadBotStatus(): Promise<void> {
    const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
    try {
      const data = await fs.readFile(botStatusPath, 'utf-8')
      let botStatus = JSON.parse(data) as BotStatus;
      setBotStatus(botStatus);
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
      let settings = JSON.parse(data) as AppSettings;
      setSettings(settings);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist, create it with default settings
        await fs.writeFile(settingsPath, JSON.stringify(getSettings(), null, 2))
      } else {
        console.error('Error loading settings:', error)
      }
    }
  }