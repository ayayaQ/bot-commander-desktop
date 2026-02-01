import { writable } from 'svelte/store'

export type ConsoleMessageType = 'info' | 'error' | 'warning' | 'event' | 'success'

export type ConsoleMessage = {
  id: number
  type: ConsoleMessageType
  message: string
  timestamp: Date
}

function createConsoleStore() {
  const { subscribe, update } = writable<ConsoleMessage[]>([])
  let nextId = 0

  function addMessage(type: ConsoleMessageType, message: string) {
    update((messages) => [
      ...messages,
      {
        id: nextId++,
        type,
        message,
        timestamp: new Date()
      }
    ])
  }

  function clear() {
    update(() => [])
  }

  return {
    subscribe,
    info: (message: string) => addMessage('info', message),
    error: (message: string) => addMessage('error', message),
    warning: (message: string) => addMessage('warning', message),
    event: (message: string) => addMessage('event', message),
    success: (message: string) => addMessage('success', message),
    clear
  }
}

export const consoleStore = createConsoleStore()

// Set up IPC listeners for console messages
export function initConsoleListeners() {
  const electron = (window as any).electron

  if (electron?.ipcRenderer) {
    electron.ipcRenderer.on('console:info', (_event: any, message: string) => {
      consoleStore.info(message)
    })

    electron.ipcRenderer.on('console:error', (_event: any, message: string) => {
      consoleStore.error(message)
    })

    electron.ipcRenderer.on('console:warning', (_event: any, message: string) => {
      consoleStore.warning(message)
    })

    electron.ipcRenderer.on('console:event', (_event: any, message: string) => {
      consoleStore.event(message)
    })

    electron.ipcRenderer.on('console:success', (_event: any, message: string) => {
      consoleStore.success(message)
    })
  }
}
