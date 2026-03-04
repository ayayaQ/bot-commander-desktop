import { writable } from 'svelte/store'
import type { BotStatus } from '../types/types'

export const botStatusStore = writable<BotStatus>({
  status: 'online',
  activity: 'Playing',
  activityDetails: 'with BCFD',
  streamUrl: ''
})

export async function loadBotStatus() {
  const botStatus = await window.electron.ipcRenderer.invoke('get-bot-status')
  botStatusStore.set(botStatus)
}

export async function saveBotStatus(newBotStatus: BotStatus) {
  await window.electron.ipcRenderer.invoke('save-bot-status', newBotStatus)
  botStatusStore.set(newBotStatus)
}
