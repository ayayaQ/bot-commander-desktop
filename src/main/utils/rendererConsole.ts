import { BrowserWindow } from 'electron'

type ConsoleMessageType = 'info' | 'error' | 'warning' | 'event' | 'success'

function sendToRenderer(type: ConsoleMessageType, message: string) {
  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(`console:${type}`, message)
  }
}

export const rendererConsole = {
  info: (message: string) => sendToRenderer('info', message),
  error: (message: string) => sendToRenderer('error', message),
  warning: (message: string) => sendToRenderer('warning', message),
  event: (message: string) => sendToRenderer('event', message),
  success: (message: string) => sendToRenderer('success', message)
}
