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
  saveStats: vi.fn(),
  dialog: vi.fn(),
  warningDialog: vi.fn(async () => ({ response: 0 })),
  consoleError: vi.fn(),
  consoleWarning: vi.fn(),
  addIPCHandlers: vi.fn(),
  initializeMcpServer: vi.fn(async () => undefined),
  stopSpamProtection: vi.fn(),
  resumeSpamProtection: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => mocks.directory,
    whenReady: () => Promise.resolve(),
    on: (name: string, listener: (...args: unknown[]) => unknown) => {
      const previous = mocks.appCallbacks.get(name)
      mocks.appCallbacks.set(
        name,
        previous ? (...args) => Promise.all([previous(...args), listener(...args)]) : listener
      )
    },
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
  getStatsInstance: () => ({ loadFromFile: vi.fn(), saveToFile: mocks.saveStats })
}))
vi.mock('./utils/rendererConsole', () => ({
  rendererConsole: {
    error: mocks.consoleError,
    info: vi.fn(),
    warning: mocks.consoleWarning,
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
vi.mock('./services/botService', () => ({
  stopSpamProtection: mocks.stopSpamProtection,
  resumeSpamProtection: mocks.resumeSpamProtection
}))
vi.mock('./services/agentMcpService', () => ({
  agentMcpService: {
    pause: vi.fn(),
    close: vi.fn(async () => undefined),
    resume: vi.fn(),
    cancelPendingLaunches: vi.fn()
  }
}))
vi.mock('./services/mcpServerService', () => ({
  initializeMcpServer: mocks.initializeMcpServer,
  stopMcpServer: vi.fn()
}))

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  mocks.saveStats.mockResolvedValue(undefined)
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

it('logs unsupported save durability once per directory without showing a dialog', async () => {
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  try {
    const { atomicWrite } = await import('./services/atomicPersistence')
    const path = join(mocks.directory, 'settings.json')
    await atomicWrite(path, '{}')
    await atomicWrite(path, '{"theme":"dark"}')
    const message = expect.stringContaining(
      'rename durability across power loss cannot be guaranteed'
    )
    expect(warning).toHaveBeenCalledOnce()
    expect(warning).toHaveBeenCalledWith(message)
    expect(mocks.consoleWarning).toHaveBeenCalledOnce()
    expect(mocks.consoleWarning).toHaveBeenCalledWith(message)
    expect(mocks.warningDialog).not.toHaveBeenCalled()
    expect(mocks.dialog).not.toHaveBeenCalled()
  } finally {
    vi.restoreAllMocks()
  }
})

it('still shows a recovery warning when agent storage is restored from its backup', async () => {
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())
  const { createAgentPersistence } = await import('./services/agentPersistence')
  const path = join(mocks.directory, 'agent-sessions.json')
  await fs.writeFile(path, '{broken')
  await fs.writeFile(`${path}.bak`, '{"recovered":true}')
  const store = createAgentPersistence({
    path: () => path,
    label: 'Agent sessions',
    decode: JSON.parse,
    empty: () => ({})
  })

  expect(await store.load()).toEqual({ data: { recovered: true }, writable: true })
  expect(mocks.warningDialog).toHaveBeenCalledOnce()
  expect(mocks.warningDialog).toHaveBeenCalledWith({
    type: 'warning',
    title: 'Agent storage recovered',
    message: expect.stringContaining('Agent sessions was recovered from its backup')
  })
  expect(mocks.consoleWarning).toHaveBeenCalledWith(
    expect.stringContaining('Agent sessions was recovered from its backup')
  )
})

it('still shows an error for an actual committed-save directory sync failure', async () => {
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())
  const { atomicWrite } = await import('./services/atomicPersistence')
  const path = join(mocks.directory, 'settings.json')
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[0] === mocks.directory) throw Object.assign(new Error('disk I/O'), { code: 'EIO' })
    return open(...args)
  })
  try {
    expect(await atomicWrite(path, '{}')).toEqual({ durability: 'uncertain' })
    expect(mocks.dialog).toHaveBeenCalledWith(
      'Save durability could not be confirmed',
      expect.stringContaining('has not been rolled back')
    )
    expect(mocks.consoleError).toHaveBeenCalledWith(expect.stringContaining('disk I/O'))
  } finally {
    vi.restoreAllMocks()
    await atomicWrite(path, '{}')
  }
})

it('resumes spam protection and the runtime when a failed checkpoint cancels quitting', async () => {
  await import('./index')
  await vi.waitFor(() => expect(mocks.addIPCHandlers).toHaveBeenCalledOnce())
  mocks.saveStats.mockRejectedValueOnce(new Error('synthetic disk failure'))
  const preventDefault = vi.fn()
  await mocks.appCallbacks.get('before-quit')?.({ preventDefault })

  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.stopSpamProtection).toHaveBeenCalledOnce()
  expect(mocks.resumeSpamProtection).toHaveBeenCalledOnce()
  expect(mocks.exit).not.toHaveBeenCalled()
  expect(mocks.consoleError).toHaveBeenCalledWith(expect.stringContaining('Could not quit safely'))
  const runtime = await import('./utils/virtual')
  await expect(
    runtime.evaluateBotState('botState.afterCancelledQuit = true')
  ).resolves.toBeUndefined()
  expect(await runtime.readBotState()).toEqual({ afterCancelledQuit: true })
})
