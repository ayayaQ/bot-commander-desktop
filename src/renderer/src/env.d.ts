/// <reference types="svelte" />
/// <reference types="vite/client" />

interface ExposedIpcRenderer {
  send(channel: string, ...args: unknown[]): void
  invoke(channel: string, ...args: unknown[]): Promise<any>
  on(channel: string, func: (...args: any[]) => void): void
  removeListener(channel: string, func: (...args: any[]) => void): void
}

interface ExposedElectronAPI {
  ipcRenderer: ExposedIpcRenderer
}

interface Window {
  electron: ExposedElectronAPI
  api: unknown
}
