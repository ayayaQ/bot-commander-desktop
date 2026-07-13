import { BrowserWindow } from 'electron'

export type ConsoleMessageType = 'info' | 'error' | 'warning' | 'event' | 'success'

export type RendererConsoleEntry = {
  id: number
  type: ConsoleMessageType
  message: string
  timestamp: string
}

const MAX_CONSOLE_ENTRIES = 1_000
const entries: RendererConsoleEntry[] = []
let nextId = 0

function sendToRenderer(type: ConsoleMessageType, message: string) {
  entries.push({ id: nextId++, type, message, timestamp: new Date().toISOString() })
  if (entries.length > MAX_CONSOLE_ENTRIES) entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES)

  const windows = BrowserWindow.getAllWindows()
  for (const win of windows) {
    win.webContents.send(`console:${type}`, message)
  }
}

export function getRendererConsoleEntries(options: {
  limit?: number
  types?: ConsoleMessageType[]
} = {}): RendererConsoleEntry[] {
  const limit = Math.max(1, Math.min(Number(options.limit) || 100, 200))
  const allowedTypes = options.types?.length ? new Set(options.types) : null
  const matchingEntries = allowedTypes
    ? entries.filter((entry) => allowedTypes.has(entry.type))
    : entries
  return structuredClone(matchingEntries.slice(-limit))
}

export const rendererConsole = {
  info: (message: string) => sendToRenderer('info', message),
  error: (message: string) => sendToRenderer('error', message),
  warning: (message: string) => sendToRenderer('warning', message),
  event: (message: string) => sendToRenderer('event', message),
  success: (message: string) => sendToRenderer('success', message)
}
