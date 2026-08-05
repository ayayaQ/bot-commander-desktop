import { contextBridge, ipcRenderer } from 'electron'

// Channel whitelists - only explicitly listed channels can be used by the renderer
const validSendChannels = [
  'minimize-window',
  'maximize-window',
  'close-window',
  'connect',
  'disconnect',
  'send-webhook',
  'agent:view-state'
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
  'memory:list',
  'memory:create',
  'memory:update',
  'memory:delete',
  'fetch-ai-models',
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
  // Agent harness
  'agent:list',
  'agent:create',
  'agent:delete',
  'agent:update',
  'agent:set-active',
  'agent:send',
  'agent:resolve-plan',
  'agent:approve',
  'agent:cancel',
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
  'connect-error',
  'disconnect',
  'window-state-changed',
  'console:info',
  'console:error',
  'console:warning',
  'console:event',
  'console:success',
  'agent:event',
  'agent:navigate',
  'memory:changed'
]

const listenerWrappers = new Map<
  string,
  Map<(...args: unknown[]) => void, (...args: unknown[]) => void>
>()

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
        // Do not expose Electron's IpcRendererEvent: it contains a privileged sender reference.
        const wrappers = listenerWrappers.get(channel) ?? new Map()
        const previous = wrappers.get(func)
        if (previous) ipcRenderer.removeListener(channel, previous)
        const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => func(...args)
        wrappers.set(func, listener)
        listenerWrappers.set(channel, wrappers)
        ipcRenderer.on(channel, listener)
      }
    },
    removeListener(channel: string, func: (...args: unknown[]) => void) {
      const wrappers = listenerWrappers.get(channel)
      const listener = wrappers?.get(func)
      if (!listener) return
      ipcRenderer.removeListener(channel, listener)
      wrappers?.delete(func)
      if (wrappers?.size === 0) listenerWrappers.delete(channel)
    }
  }
})

contextBridge.exposeInMainWorld('api', {})
