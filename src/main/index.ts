import { app, shell, BrowserWindow, Tray, Menu } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getStatsInstance, Stats } from './utils/stats'
import { initializeBotState, saveBotState } from './utils/virtual'
import { addIPCHandlers } from './handlers/ipcHandlers'
import { loadBotStatus, loadCommands, loadSettings } from './services/fileService'

// Extend the Electron.App interface to include our custom property
declare global {
  namespace Electron {
    interface App {
      isQuitting: boolean;
    }
  }
}



let stats: Stats
const statsFilePath = join(app.getPath('userData'), 'stats.json')

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

// Initialize the custom property
app.isQuitting = false

async function saveStats() {
  if (stats) {
    await stats.saveToFile(statsFilePath)
  }
}

function createWindow(): void {
  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: 1230,
    height: 670,
    minWidth: 1230,
    minHeight: 495,
    show: false,
    autoHideMenuBar: true,
    frame: false, // Remove the default frame
    titleBarStyle: 'hidden', // Hide the title bar
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: false, // Required for ipcRenderer in renderer process
      nodeIntegration: true // Required for ipcRenderer in renderer process
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
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
    return false
  })
}

function createTray() {
  tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => mainWindow?.show() },
    { label: 'Quit', click: () => {
      app.isQuitting = true
      app.quit()
    }}
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
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await loadCommands()
  await loadSettings()
  await loadBotStatus()

  stats = getStatsInstance()
  await stats.loadFromFile(statsFilePath)

  await initializeBotState() // Initialize bot state

  addIPCHandlers()

  createWindow()
  createTray()

  app.on('before-quit', async (event) => {
    event.preventDefault() // Prevent the app from quitting immediately
    await saveStats() // Save stats before quitting
    await saveBotState() // Save bot state before quitting
    app.exit(0) // Now quit the app
  })

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && app.isQuitting) {
    app.quit()
  }
})

app.on('before-quit', () => {
  app.isQuitting = true
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