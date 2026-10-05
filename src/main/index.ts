import { stopSpamProtection, resumeSpamProtection } from './services/botService'
import { app, shell, BrowserWindow, Tray, Menu, session, dialog } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import iconPng from '../../resources/icon.png?asset'
import iconIco from '../../resources/icon.ico?asset'
import { getStatsInstance, Stats } from './utils/stats'
import {
  initializeBotState,
  stopRuntimeAndCheckpoint,
  pauseRuntime,
  resumeRuntime
} from './utils/virtual'
import { finishPersistenceBeforeQuit } from './utils/gracefulShutdown'
import { stopAgentRuns, checkpointAgentSessionsBeforeQuit } from './services/agentService'
import { setAgentPersistenceNoticeHandler } from './services/agentPersistence'
import {
  pauseAgentPersistence,
  drainAgentPersistence,
  resumeAgentPersistence
} from './services/agentPersistenceLifecycle'
import {
  closeAndDrainAtomicWrites,
  reopenAtomicWrites,
  setAtomicWriteNoticeHandler
} from './services/atomicPersistence'
import {
  stopResourceMutations,
  drainResourceMutations,
  resumeResourceMutations
} from './services/resourceChangeService'
import { rendererConsole } from './utils/rendererConsole'
import { addIPCHandlers, addWindowIPCHandlers } from './handlers/ipcHandlers'
import { configureTrustedRenderer } from './handlers/ipcSecurity'
import { loadBotStatus, loadCommands, loadSettings, loadInteractions } from './services/fileService'
import { initializeMcpServer, stopMcpServer } from './services/mcpServerService'

// Extend the Electron.App interface to include our custom property
declare global {
  namespace Electron {
    interface App {
      isQuitting: boolean
    }
  }
}

let stats: Stats
const statsFilePath = join(app.getPath('userData'), 'stats.json')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let savingBeforeQuit = false

// Initialize the custom property
app.isQuitting = false
app.name = 'Bot Commander for Discord'

async function saveStats() {
  if (stats) {
    await stats.saveToFile(statsFilePath)
  }
}

function createWindow(recoveryError?: unknown): void {
  const windowIcon =
    process.platform === 'win32' ? iconIco : process.platform === 'darwin' ? iconPng : undefined

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1230,
    height: 670,
    minWidth: 1230,
    minHeight: 495,
    show: false,
    autoHideMenuBar: true,
    frame: process.platform === 'darwin', // Use native frame on macOS
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden', // hiddenInset shows traffic lights on macOS
    ...(windowIcon ? { icon: windowIcon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  addWindowIPCHandlers(mainWindow)

  const rendererUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  configureTrustedRenderer(mainWindow.webContents, rendererUrl)

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const expected = new URL(rendererUrl)
    const requested = new URL(navigationUrl)
    const allowed =
      expected.protocol === 'file:'
        ? requested.href === expected.href
        : requested.origin === expected.origin

    if (!allowed) event.preventDefault()
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (recoveryError) {
      dialog.showErrorBox('Bot state recovery required', String(recoveryError))
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Prevent the window from closing when the close button is clicked
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })
}

function isSafeExternalUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function createTray() {
  tray = new Tray(iconPng)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow?.show() },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setToolTip('BCFD')
  tray.setContextMenu(contextMenu)

  tray.on('double-click', () => {
    mainWindow?.show()
  })
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  setAgentPersistenceNoticeHandler(({ level, message }) => {
    if (level === 'error') {
      rendererConsole.error(message)
      dialog.showErrorBox('Agent storage recovery required', message)
    } else {
      rendererConsole.warning(message)
      void dialog
        .showMessageBox({ type: 'warning', title: 'Agent storage recovered', message })
        .catch((error) => console.error('Could not show agent recovery warning:', error))
    }
  })
  setAtomicWriteNoticeHandler(({ level, message }) => {
    rendererConsole[level](message)
    // Unsupported directory sync is an expected platform limitation; keep it in the logs.
    if (level === 'error') dialog.showErrorBox('Save durability could not be confirmed', message)
  })
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // The help view embeds remote HTTPS content. This app does not need any web permissions.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await loadCommands()
  await loadSettings()
  await loadBotStatus()
  await loadInteractions()

  stats = getStatsInstance()
  await stats.loadFromFile(statsFilePath)

  let recoveryError: unknown
  try {
    await initializeBotState()
  } catch (error) {
    // Keep the shell and repair controls available; the runtime retains its blocking failure.
    recoveryError = error
    rendererConsole.error(String(error))
  }
  await initializeMcpServer()

  createWindow(recoveryError)
  addIPCHandlers()
  if (process.platform !== 'darwin') {
    createTray()
  }

  app.on('before-quit', async (event) => {
    event.preventDefault() // Prevent the app from quitting immediately
    if (savingBeforeQuit) return
    savingBeforeQuit = true
    try {
      await finishPersistenceBeforeQuit({
        pauseResources: stopResourceMutations,
        pauseRuntime,
        pauseAgents: () => {
          pauseAgentPersistence()
          stopAgentRuns()
        },
        checkpointAndStopRuntime: stopRuntimeAndCheckpoint,
        drainResources: drainResourceMutations,
        drainAgents: async () => {
          await drainAgentPersistence()
          await checkpointAgentSessionsBeforeQuit()
        },
        saveStats,
        stopServer: stopMcpServer,
        closeAndDrainWrites: closeAndDrainAtomicWrites,
        resumeResources: resumeResourceMutations,
        resumeRuntime,
        resumeAgents: resumeAgentPersistence,
        reopenWrites: reopenAtomicWrites
      })
      app.exit(0)
    } catch (error) {
      app.isQuitting = false
      resumeSpamProtection()
      rendererConsole.error(`Could not quit safely; the app remains open: ${String(error)}`)
      mainWindow?.show()
      await initializeMcpServer().catch((serverError) =>
        console.error('Could not resume MCP server:', serverError)
      )
    } finally {
      savingBeforeQuit = false
    }
  })

  app.on('activate', function () {
    if (mainWindow) {
      mainWindow.show()
    } else {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && app.isQuitting) {
    app.quit()
  }
})

app.on('before-quit', () => {
  app.isQuitting = true
  stopSpamProtection()
})

function saveStatsPeriodicaly() {
  setInterval(
    async () => {
      await saveStats()
    },
    5 * 60 * 1000
  ) // Save every 5 minutes
}

// Call this function after initializing the stats object
saveStatsPeriodicaly()
