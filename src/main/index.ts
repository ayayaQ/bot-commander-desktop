import { app, shell, BrowserWindow, ipcMain, session} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { ActivityType, Client, IntentsBitField } from 'discord.js';
import fs from 'fs/promises';
import { BCFDCommand } from './types';
import { OAuth2Scopes, PermissionsBitField } from 'discord.js';

let client : Client | null = null;
let connection: boolean = false;
let commands: { bcfdCommands: BCFDCommand[] } = { bcfdCommands: [] };


async function loadCommands(): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json');
  try {
    const data = await fs.readFile(commandsPath, 'utf-8');
    commands = JSON.parse(data);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with empty commands
      await fs.writeFile(commandsPath, JSON.stringify({ bcfdCommands: [] }));
    } else {
      console.error('Error loading commands:', error);
    }
  }
}

async function saveCommands(): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json');
  try {
    await fs.writeFile(commandsPath, JSON.stringify(commands, null, 2));
  } catch (error) {
    console.error('Error saving commands:', error);
  }
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
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

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.on('connect', (event, token) => {
    Connect(event, token);
  });

  ipcMain.on('disconnect', (event) => {
    Disconnect(event);
  });

  await loadCommands();

  ipcMain.handle('get-commands', () => {
    return commands;
  });

  ipcMain.handle('save-commands', async (_, newCommands: { bcfdCommands: BCFDCommand[] }) => {
    commands = newCommands;
    await saveCommands();
    return true;
  });

  ipcMain.handle('generate-invite', async () => {
    if (!client || !client.user) {
      throw new Error('Client is not connected');
    }

    try {
      const invite = await client.generateInvite({
        scopes: [OAuth2Scopes.Bot],
        permissions: [
          PermissionsBitField.Flags.Administrator,
        ]
      });
      return invite;
    } catch (error) {
      console.error('Error generating invite:', error);
      throw new Error('Failed to generate invite');
    }
  });

  ipcMain.handle('get-token', async () => { 
    const cookies = await session.defaultSession.cookies.get({ name: 'token' });
    return cookies[0]?.value ?? '';
  });

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

function Connect(event, token) {
	if (connection) {
		if (client) {
			client.destroy();
			client = null;
			connection = false;
		}

		return event.reply("disconnect");
	}

  session.defaultSession.cookies.set({ url: 'https://discord.com', name: 'token', value: token, expirationDate: Date.now() + 1000 * 60 * 60 * 24 * 30 });

	client = new Client({
		intents: [
			IntentsBitField.Flags.Guilds,
			IntentsBitField.Flags.GuildMembers,
			IntentsBitField.Flags.GuildMessages,			
      IntentsBitField.Flags.MessageContent
		]
	});

	client.once('ready', () => {
		if (client == null) return;

    if (client.user == null) return;

    client.user.setPresence({ status: 'invisible', activities: [{ name: 'invisible', type: ActivityType.Listening }], });
    

		connection = true;

		return event.reply("connect", {
			user: client.user.username,
			avatar: client.user.avatarURL(),
			
		});
	});

	client.on('messageCreate', (message) => {
		if (message.author.bot) return;
    
    let command = commands.bcfdCommands.find(c => message.content == c.command);

    if (command) {
      message.channel.send(command.channelMessage);
    }
	});

	client.login(token).catch((err) => {
		event.reply('fail', { error: err });
	});
}

function Disconnect(event) {
  if (client) {
    client.destroy();
    client = null;
    connection = false;
  }

  return event.reply("disconnect");
}