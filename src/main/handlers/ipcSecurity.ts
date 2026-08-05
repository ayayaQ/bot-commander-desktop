import { ipcMain as electronIpcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron'

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent

let trustedWebContents: WebContents | null = null
let trustedRendererUrl: URL | null = null

export function configureTrustedRenderer(webContents: WebContents, url: string): void {
  trustedWebContents = webContents
  trustedRendererUrl = new URL(url)
}

export function isTrustedIpcSender(event: IpcEvent): boolean {
  if (!trustedWebContents || !trustedRendererUrl) return false
  if (event.sender !== trustedWebContents) return false
  if (event.senderFrame !== event.sender.mainFrame) return false

  try {
    const senderUrl = new URL(event.senderFrame.url)
    if (trustedRendererUrl.protocol === 'file:') {
      return senderUrl.href === trustedRendererUrl.href
    }
    return senderUrl.origin === trustedRendererUrl.origin
  } catch {
    return false
  }
}

export function assertTrustedIpcSender(event: IpcEvent): void {
  if (!isTrustedIpcSender(event)) {
    throw new Error('Blocked IPC request from an untrusted renderer')
  }
}

type IpcInvokeListener = (event: IpcMainInvokeEvent, ...args: any[]) => unknown
type IpcEventListener = (event: IpcMainEvent, ...args: any[]) => unknown

export const trustedIpcMain = {
  handle(channel: string, listener: IpcInvokeListener): void {
    electronIpcMain.handle(channel, (event, ...args) => {
      assertTrustedIpcSender(event)
      return listener(event, ...args)
    })
  },
  on(channel: string, listener: IpcEventListener): void {
    electronIpcMain.on(channel, (event, ...args) => {
      if (!isTrustedIpcSender(event)) {
        console.warn(`Blocked IPC event on ${channel} from an untrusted renderer`)
        return
      }
      void listener(event, ...args)
    })
  }
}
