// this function sends a webhook to the main process
export function sendWebhook(webhookUrl: string, name: string, avatarUrl: string, message: string) {
    (window as any).electron.ipcRenderer.send('send-webhook', { webhookUrl, name, avatarUrl, message })
}