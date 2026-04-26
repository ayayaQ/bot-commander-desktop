import { contextBridge, ipcRenderer } from 'electron'

// Channel whitelists - only explicitly listed channels can be used by the renderer
const validSendChannels = [
  'minimize-window',
  'maximize-window',
  'close-window',
  'connect',
  'disconnect',
  'send-webhook'
]

const validInvokeChannels = [
  // Window
  'get-platform',
  'is-window-maximized',
  'check-for-updates',
  'open-external-url',
  // Commands
  'get-commands',
  'save-commands',
  'export-commands',
  'import-commands',
  // Interactions
  'get-interactions',
  'save-interactions',
  'register-slash-command',
  'unregister-slash-command',
  'sync-all-slash-commands',
  // Settings & status
  'get-settings',
  'save-settings',
  'get-bot-status',
  'save-bot-status',
  // Onboarding
  'get-onboarding',
  'save-onboarding',
  // Connection
  'generate-invite',
  'get-token',
  // Bot state & execution
  'getBotState',
  'updateBotState',
  'runCodeInContext',
  'get-startup-js',
  'set-startup-js',
  'restart-js-engine',
  // Webhooks
  'get-webhook-presets',
  'save-webhook-presets',
  // Stats
  'get-stats',
  // AI chat
  'ai-command-chat',
  'get-chats',
  'get-chat',
  'create-chat',
  'delete-chat',
  'clear-chat-messages',
  'set-active-chat',
  'get-recent-chats',
  'search-chats',
  'save-chat-message',
  'update-chat-message',
  'add-message-to-chat',
  'update-message-in-chat',
  'update-chat-contexts',
  // API auth
  'api-auth-register',
  'api-auth-login',
  'api-auth-logout',
  'api-auth-check',
  // Command repository
  'repo-fetch-commands',
  'repo-search-commands',
  'repo-share-command',
  'repo-import-command',
  'repo-delete-command',
  'repo-my-commands'
]

const validReceiveChannels = [
  'connect',
  'disconnect',
  'window-state-changed',
  'console:info',
  'console:error',
  'console:warning',
  'console:event',
  'console:success',
  'ai-chat:thinking',
  'ai-chat:done',
  'ai-chat:error'
]

contextBridge.exposeInMainWorld('electron', {
  ipcRenderer: {
    send(channel: string, ...args: unknown[]) {
      if (validSendChannels.includes(channel)) {
        ipcRenderer.send(channel, ...args)
      }
    },
    invoke(channel: string, ...args: unknown[]) {
      if (validInvokeChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args)
      }
      return Promise.reject(new Error(`Invalid invoke channel: ${channel}`))
    },
    on(channel: string, func: (...args: unknown[]) => void) {
      if (validReceiveChannels.includes(channel)) {
        ipcRenderer.on(channel, func)
      }
    },
    removeListener(channel: string, func: (...args: unknown[]) => void) {
      ipcRenderer.removeListener(channel, func)
    }
  }
})

contextBridge.exposeInMainWorld('api', {})
