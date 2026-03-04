import { writable } from 'svelte/store'
import type { WebhookPreset } from '../types/types'

export const webhookPresetsStore = writable<WebhookPreset[]>([])

// Load webhook presets from main process
export async function loadWebhookPresets() {
  const presets = await window.electron.ipcRenderer.invoke('get-webhook-presets')
  webhookPresetsStore.set(presets)
}

// Save webhook presets to main process
export async function saveWebhookPresets(presets: WebhookPreset[]) {
  await window.electron.ipcRenderer.invoke('save-webhook-presets', presets)
  webhookPresetsStore.set(presets)
}

// this function sends a webhook to the main process
export function sendWebhook(
  webhookUrl: string,
  name: string,
  avatarUrl: string,
  messageType: 'message' | 'embed',
  message: string,
  embedTitle?: string,
  embedDescription?: string,
  embedColor?: string,
  embedFooter?: string,
  embedImageUrl?: string,
  embedThumbnailUrl?: string
) {
  ;window.electron.ipcRenderer.send('send-webhook', {
    webhookUrl,
    name,
    avatarUrl,
    messageType,
    message,
    embedTitle,
    embedDescription,
    embedColor,
    embedFooter,
    embedImageUrl,
    embedThumbnailUrl
  })
}
