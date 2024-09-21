import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  ActivityType,
  Client,
  DMChannel,
  EmbedBuilder,
  IntentsBitField,
  Message,
  OmitPartialGroupDMChannel,
  TextChannel
} from 'discord.js'
import fs from 'fs/promises'
import { BCFDCommand } from './types'
import { OAuth2Scopes, PermissionsBitField } from 'discord.js'

let client: Client | null = null
let connection: boolean = false
let commands: { bcfdCommands: BCFDCommand[] } = { bcfdCommands: [] }

async function loadCommands(): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json')
  try {
    const data = await fs.readFile(commandsPath, 'utf-8')
    commands = JSON.parse(data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with empty commands
      await fs.writeFile(commandsPath, JSON.stringify({ bcfdCommands: [] }))
    } else {
      console.error('Error loading commands:', error)
    }
  }
}

async function saveCommands(): Promise<void> {
  const commandsPath = join(app.getPath('userData'), 'commands.json')
  try {
    await fs.writeFile(commandsPath, JSON.stringify(commands, null, 2))
  } catch (error) {
    console.error('Error saving commands:', error)
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
    Connect(event, token)
  })

  ipcMain.on('disconnect', (event) => {
    Disconnect(event)
  })

  await loadCommands()

  ipcMain.handle('get-commands', () => {
    return commands
  })

  ipcMain.handle('save-commands', async (_, newCommands: { bcfdCommands: BCFDCommand[] }) => {
    commands = newCommands
    await saveCommands()
    return true
  })

  ipcMain.handle('generate-invite', async () => {
    if (!client || !client.user) {
      throw new Error('Client is not connected')
    }

    try {
      const invite = await client.generateInvite({
        scopes: [OAuth2Scopes.Bot],
        permissions: [PermissionsBitField.Flags.Administrator]
      })
      return invite
    } catch (error) {
      console.error('Error generating invite:', error)
      throw new Error('Failed to generate invite')
    }
  })

  ipcMain.handle('get-token', async () => {
    const cookies = await session.defaultSession.cookies.get({ name: 'token' })
    return cookies[0]?.value ?? ''
  })

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

function Connect(event: Electron.IpcMainEvent, token: string) {
  if (connection) {
    if (client) {
      client.destroy()
      client = null
      connection = false
    }

    return event.reply('disconnect')
  }

  session.defaultSession.cookies.set({
    url: 'https://discord.com',
    name: 'token',
    value: token,
    expirationDate: Date.now() + 1000 * 60 * 60 * 24 * 30
  })

  client = new Client({
    intents: [
      IntentsBitField.Flags.Guilds,
      IntentsBitField.Flags.GuildMembers,
      IntentsBitField.Flags.GuildMessages,
      IntentsBitField.Flags.MessageContent
    ]
  })

  client.once('ready', () => {
    if (client == null) return

    if (client.user == null) return

    client.user.setPresence({
      status: 'invisible',
      activities: [{ name: 'invisible', type: ActivityType.Listening }]
    })

    connection = true

    return event.reply('connect', {
      user: client.user.username,
      avatar: client.user.avatarURL()
    })
  })

  client.on('messageCreate', (message) => {
    onMessageCreate(message)
  })

  client.login(token).catch((err) => {
    event.reply('fail', { error: err })
  })
}

function Disconnect(event: Electron.IpcMainEvent) {
  if (client) {
    client.destroy()
    client = null
    connection = false
  }

  return event.reply('disconnect')
}

async function onMessageCreate(message: OmitPartialGroupDMChannel<Message<boolean>>) {
  if (message.author.bot) return

  let firstItem = message.content.split(' ')[0];
  let messageWordCount = message.content.split(' ').length;

  let filteredCommands = commands.bcfdCommands.filter(
    (c) =>
      c.type == 0 &&
      message.content == c.command ||
      (c.phrase && message.content.toLowerCase().includes(c.command.toLowerCase())) ||
      c.command == '*' ||
      ((c.isBan || c.isKick || c.isVoiceMute) && c.command == firstItem && messageWordCount == 2)
  )

  for (const command of filteredCommands) {
    if (command.isRequiredRole) {
      // Check if the user has the required role
      if (!message.member?.roles.cache.has(command.roleToAssign)) {
        // User does not have the required role, skip the command
        if (!command.ignoreErrorMessage) {
          message.reply('```' + `${command.command} requires role: ${command.roleToAssign}`  + '```')
        }
        continue;
      }
    }

    if (command.isAdmin) {
      if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        continue;
      }
    }

    if (command.isNSFW) {
      if (message.channel instanceof TextChannel && !message.channel.nsfw) {
        continue;
      }
    }
    
    if (command.deleteIf) {
      let deleteStrings = command.deleteIfStrings.split('|');
      for (const deleteString of deleteStrings) {
        if (message.content.includes(deleteString)) {
          message.delete();
          break;
        }
      }
    }

    if (command.deleteX) {
      // check if user has permission to manage messages
      if (!message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages) || !(message.channel instanceof TextChannel)) {
        continue;
      }

      let deleteAmount = command.deleteNum;
      // get the previous x messages
      let messages = await message.channel.messages.fetch({ limit: deleteAmount });
      // delete the messages
      message.channel.bulkDelete(messages);
    }

    if (command.actionArr[0]) {
      // reply to message
      message.channel.send(command.channelMessage);
    }

    if (command.actionArr[1]) {
      // sends a private message to the user
      message.author.send(command.privateMessage);
    }

    if (command.isKick && command.command == firstItem && messageWordCount == 2) {
      // check if user has permission to kick
      if (!message.member?.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        continue;
      }

      let mentioned = message.mentions?.users?.first();

      if (mentioned) {
        // kick the user
        message.guild?.members.kick(mentioned);
      }
    }

    if (command.isBan && command.command == firstItem && messageWordCount == 2) {
      // check if user has permission to ban
      if (!message.member?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        continue;
      }

      let mentioned = message.mentions?.users?.first();
      
      if (mentioned) {
        // ban the user
        message.guild?.members.ban(mentioned);
      }
    }

    if (command.isVoiceMute && command.command == firstItem && messageWordCount == 2) {
      // check if user has permission to mute
      if (!message.member?.permissions.has(PermissionsBitField.Flags.MuteMembers)) {
        continue;
      }

      let mentioned = message.mentions?.users?.first();

      if (mentioned) {
        let userID = mentioned.id;
        let guild = message.guild;

        if (!guild) {
          continue;
        }

        let member = await guild.members.fetch(userID);

        // mute the user
        member.voice.setMute(true, "Muted by bot command");
      }
    }

    if (command.isRoleAssigner) {
      let role = command.roleToAssign;

      // add the role to the member if they dont have it, and if they have it remove it
      if (!message.member?.roles.cache.has(role)) {
        message.member?.roles.add(role);
      } else {
        message.member?.roles.remove(role);
      }
    }

    if (command.sendChannelEmbed) {
      // builds an embed with our embed template
      let embed = new EmbedBuilder();

      if (command.channelEmbed.title != '') {
        embed.setTitle(command.channelEmbed.title);
      }

      if (command.channelEmbed.description != '') {
        embed.setDescription(command.channelEmbed.description);
      }

      if (command.channelEmbed.hexColor != '') {
        // convert our hex color string to 'color'
        let color = parseInt(command.channelEmbed.hexColor, 16);
        embed.setColor(color);
      }

      if (command.channelEmbed.imageURL != '') {
        embed.setImage(command.channelEmbed.imageURL);
      }

      if (command.channelEmbed.thumbnailURL != '') {
        embed.setThumbnail(command.channelEmbed.thumbnailURL);
      }

      if (command.channelEmbed.footer != '') {
        embed.setFooter({ text: command.channelEmbed.footer });
      }
      
      // send the embed
      message.channel.send({ embeds: [embed] });
    }

    if (command.sendPrivateEmbed) {
      // builds an embed with our embed template
      let embed = new EmbedBuilder();

      if (command.privateEmbed.title != '') {
        embed.setTitle(command.privateEmbed.title);
      }

      if (command.privateEmbed.description != '') {
        embed.setDescription(command.privateEmbed.description);
      }

      if (command.privateEmbed.hexColor != '') {
        // convert our hex color string to 'color'
        let color = parseInt(command.privateEmbed.hexColor, 16);
        embed.setColor(color);
      }

      if (command.privateEmbed.imageURL != '') {
        embed.setImage(command.privateEmbed.imageURL);
      }

      if (command.privateEmbed.thumbnailURL != '') {
        embed.setThumbnail(command.privateEmbed.thumbnailURL);
      }

      if (command.privateEmbed.footer != '') {
        embed.setFooter({ text: command.privateEmbed.footer });
      }

      // send the embed
      message.author.send({ embeds: [embed] });
      
    }

    if (command.isReact) {
      // add a reaction to the message

      // convert our command reaction to a reaction emote from the guild
      let reaction = message.guild?.emojis.cache.get(command.reaction);

      if (reaction) {
        message.react(reaction);
      }
    }

    if (command.deleteAfter) {
      // delete the message
      message.delete();
    }
  }
}
