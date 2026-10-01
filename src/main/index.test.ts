import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({
  directory: '',
  windows: [] as Array<{
    show: ReturnType<typeof vi.fn>
    callbacks: Map<string, (...args: unknown[]) => void>
  }>,
  appCallbacks: new Map<string, (...args: unknown[]) => unknown>(),
  exit: vi.fn(),
  dialog: vi.fn(),
  warningDialog: vi.fn(async () => ({ response: 0 })),
  consoleError: vi.fn(),
  addIPCHandlers: vi.fn(),
  initializeMcpServer: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.directory,
    whenReady: () => Promise.resolve(),
    on: (name: string, listener: (...args: unknown[]) => unknown) =>
      mocks.appCallbacks.set(name, listener),
    exit: mocks.exit
  },
  BrowserWindow: class {
    callbacks = new Map<string, (...args: unknown[]) => void>()
    webContents = { on: vi.fn(), setWindowOpenHandler: vi.fn() }
    show = vi.fn()
    hide = vi.fn()
    loadFile = vi.fn()
    constructor() {
      mocks.windows.push(this)
    }
    on(name: string, listener: (...args: unknown[]) => void) {
      this.callbacks.set(name, listener)
    }
  },
  Tray: class {
    setToolTip = vi.fn()
    setContextMenu = vi.fn()
    on = vi.fn()
  },
  Menu: { buildFromTemplate: vi.fn() },
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn()
    }
  },
  dialog: { showErrorBox: mocks.dialog, showMessageBox: mocks.warningDialog }
}))
vi.mock('@electron-toolkit/utils', () => ({
  electronApp: { setAppUserModelId: vi.fn() },
  optimizer: { watchWindowShortcuts: vi.fn() },
  is: { dev: false }
}))
vi.mock('../../resources/icon.png?asset', () => ({ default: 'icon.png' }))
vi.mock('../../resources/icon.ico?asset', () => ({ default: 'icon.ico' }))
vi.mock('./utils/stats', () => ({
  getStatsInstance: () => ({ loadFromFile: vi.fn(), saveToFile: vi.fn() })
}))
vi.mock('./utils/rendererConsole', () => ({
  rendererConsole: {
    error: mocks.consoleError,
    info: vi.fn(),
    warning: vi.fn(),
    success: vi.fn()
  }
}))
vi.mock('./handlers/ipcHandlers', () => ({
  addIPCHandlers: mocks.addIPCHandlers,
  addWindowIPCHandlers: vi.fn()
}))
vi.mock('./handlers/ipcSecurity', () => ({ configureTrustedRenderer: vi.fn() }))
vi.mock('./services/fileService', () => ({
  loadCommands: vi.fn(),
  loadSettings: vi.fn(),
  loadBotStatus: vi.fn(),
  loadInteractions: vi.fn()
}))
vi.mock('./services/mcpServerService', () => ({
  initializeMcpServer: mocks.initializeMcpServer,
  stopMcpServer: vi.fn()
}))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.windows.length = 0
  mocks.appCallbacks.clear()
  mocks.directory = await fs.mkdtemp(join(tmpdir(), 'bc-shell-recovery-'))
})

afterEach(async () => {
  vi.useRealTimers()
  const runtime = await import('./utils/virtual')
  try {
    runtime.getBotStateContext().dispose()
  } catch {
    // The recovery-only shell has no active VM.
  }
  await fs.rm(mocks.directory, { recursive: true, force: true })
})

it('creates the shell and shows actionable recovery instructions when no saved state can be decoded', async () => {
  const path = join(mocks.directory, 'botState.json')
  await fs.writeFile(path, '{broken')
  await fs.writeFile(`${path}.bak`, '[]')
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())

  expect(mocks.windows).toHaveLength(1)
  const window = mocks.windows[0]
  window.callbacks.get('ready-to-show')?.()
  expect(window.show).toHaveBeenCalledOnce()
  expect(mocks.dialog).toHaveBeenCalledWith(
    'Bot state recovery required',
    expect.stringContaining('Restart JS Engine')
  )
  expect(mocks.consoleError).toHaveBeenCalledWith(expect.stringContaining(path))

  const runtime = await import('./utils/virtual')
  await expect(runtime.evaluateBotState('botState.overwrite = true')).rejects.toThrow('disabled')
  const beforeQuit = mocks.appCallbacks.get('before-quit')
  const preventDefault = vi.fn()
  await beforeQuit?.({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.exit).toHaveBeenCalledWith(0)
  expect(await fs.readFile(path, 'utf8')).toBe('{broken')
  expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('[]')
})

it('opens a normal shell without a recovery dialog after a valid backup loads', async () => {
  const path = join(mocks.directory, 'botState.json')
  await fs.writeFile(path, '{broken')
  await fs.writeFile(`${path}.bak`, '{"recovered":true}')
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())
  mocks.windows[0].callbacks.get('ready-to-show')?.()
  expect(mocks.dialog).not.toHaveBeenCalled()
  const runtime = await import('./utils/virtual')
  expect(await runtime.readBotState()).toEqual({ recovered: true })
})

it('makes unsupported save durability visible once per directory', async () => {
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    const { atomicWrite } = await import('./services/atomicPersistence')
    const path = join(mocks.directory, 'settings.json')
    await atomicWrite(path, '{}')
    await atomicWrite(path, '{"theme":"dark"}')
    expect(mocks.warningDialog).toHaveBeenCalledOnce()
    expect(mocks.warningDialog).toHaveBeenCalledWith({
      type: 'warning',
      title: 'Limited power-loss save protection',
      message: expect.stringContaining('cannot be guaranteed')
    })
  } finally {
    vi.restoreAllMocks()
  }
})
