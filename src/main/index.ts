import { app, shell, BrowserWindow, ipcMain, session, Tray, Menu } from 'electron'
import { join } from 'path'
import vm from 'node:vm'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  ActivityType,
  ChannelType,
  Client,
  DMChannel,
  EmbedBuilder,
  Events,
  Guild,
  GuildBan,
  GuildMember,
  IntentsBitField,
  Interaction,
  Message,
  MessageReaction,
  NewsChannel,
  OmitPartialGroupDMChannel,
  PartialDMChannel,
  PartialGuildMember,
  PartialMessageReaction,
  Partials,
  PartialUser,
  PresenceStatusData,
  PrivateThreadChannel,
  PublicThreadChannel,
  StageChannel,
  TextChannel,
  User,
  VoiceChannel,
  WebhookClient
} from 'discord.js'
import fs from 'fs/promises'
import { AppSettings, BCFDCommand, BCFDSlashCommand, BotStatus } from './types'
import { OAuth2Scopes, PermissionsBitField } from 'discord.js'
import { stringInfoAddEval } from './virtual'
import { Stats } from './stats'
import { initializeBotState, loadBotState, saveBotState, getBotStateContext } from './virtual'

// Extend the Electron.App interface to include our custom property
declare global {
  namespace Electron {
    interface App {
      isQuitting: boolean;
    }
  }
}

let client: Client | null = null
let connection: boolean = false
let commands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] } = {
  bcfdCommands: [],
  bcfdSlashCommands: []
}
let context: vm.Context
let settings: AppSettings = { theme: 'light', showToken: false } // Default settings
let botStatus: BotStatus = {
  status: 'Online',
  activity: 'Playing',
  activityDetails: 'with BCFD',
  streamUrl: ''
} // Default bot status
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

async function loadSettings(): Promise<void> {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    const data = await fs.readFile(settingsPath, 'utf-8')
    settings = JSON.parse(data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with default settings
      await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
    } else {
      console.error('Error loading settings:', error)
    }
  }
}

async function saveSettings(): Promise<void> {
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  try {
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2))
  } catch (error) {
    console.error('Error saving settings:', error)
  }
}

async function loadBotStatus(): Promise<void> {
  const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
  try {
    const data = await fs.readFile(botStatusPath, 'utf-8')
    botStatus = JSON.parse(data)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create it with default bot status
      await fs.writeFile(botStatusPath, JSON.stringify(botStatus, null, 2))
    } else {
      console.error('Error loading bot status:', error)
    }
  }
}

async function saveBotStatus(): Promise<void> {
  const botStatusPath = join(app.getPath('userData'), 'botStatus.json')
  try {
    await fs.writeFile(botStatusPath, JSON.stringify(botStatus, null, 2))
  } catch (error) {
    console.error('Error saving bot status:', error)
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

  stats = new Stats()
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

// Modify the existing 'window-all-closed' event handler
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && app.isQuitting) {
    app.quit()
  }
})

// Add a 'before-quit' event handler
app.on('before-quit', () => {
  app.isQuitting = true
})

function addIPCHandlers() {
  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.on('connect', (event, token) => {
    Connect(event, token)
  })

  ipcMain.on('disconnect', (event) => {
    Disconnect(event)
  })

  ipcMain.handle('get-commands', () => {
    return commands
  })

  ipcMain.handle(
    'save-commands',
    async (
      _,
      newCommands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] }
    ) => {
      commands = newCommands
      await saveCommands()
      return true
    }
  )

  ipcMain.handle('get-settings', () => {
    return settings
  })

  ipcMain.handle('save-settings', async (_, newSettings: AppSettings) => {
    settings = newSettings
    await saveSettings()
    return true
  })

  ipcMain.handle('get-bot-status', () => {
    return botStatus
  })

  ipcMain.handle('save-bot-status', async (_, newBotStatus: BotStatus) => {
    botStatus = newBotStatus
    await saveBotStatus()
    applyBotStatus(botStatus)
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

  ipcMain.handle('getBotState', () => {
    const context = getBotStateContext()
    return vm.runInContext('JSON.parse(JSON.stringify(botState))', context)
  })

  ipcMain.handle('updateBotState', (event, key: string, value: any) => {
    try {
      const context = getBotStateContext();
      vm.runInContext(`botState['${key}'] = ${JSON.stringify(value)}`, context);
      saveBotState(); // Save the updated state
      return true;
    } catch (error) {
      console.error('Error updating bot state:', error);
      return false;
    }
  });

  ipcMain.handle('runCodeInContext', (event, code: string) => {
    try {
      const context = getBotStateContext();
      const result = vm.runInContext(code, context);
      saveBotState(); // Save the state in case it was modified
      return JSON.stringify(result, null, 2);
    } catch (error) {
      console.error('Error running code in context:', error);
      throw error;
    }
  });

  // send a webhook using discord.js
  ipcMain.on('send-webhook', async (_event, webhook) => {
    const webhookClient = new WebhookClient({ url: webhook.webhookUrl })
    await webhookClient.send({
      username: webhook.name ?? undefined,
      avatarURL: webhook.avatarUrl ?? undefined,
      content: webhook.message ?? undefined
    })
    webhookClient.destroy()
    stats.incrementWebhooksSent()
  })

  ipcMain.handle('get-stats', () => {
    return stats.getStats()
  })

  // Add these new IPC handlers for window controls if not already present
  ipcMain.on('minimize-window', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })

  ipcMain.on('maximize-window', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('close-window', () => {
    BrowserWindow.getFocusedWindow()?.close()
  })
}

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
      IntentsBitField.Flags.MessageContent,
      IntentsBitField.Flags.DirectMessages,
      IntentsBitField.Flags.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
  })

  client.once('ready', async () => {
    if (client == null) return

    if (client.user == null) return

    await loadBotState() // Load bot state when client is ready
    context = getBotStateContext() // Use the bot state context

    // Use our bot status to set the presence of the bot
    applyBotStatus(botStatus)

    stats.updateUserCount(client.users.cache.size)
    stats.updateServerCount(client.guilds.cache.size)
    stats.updateCommandCount(commands.bcfdCommands.length)

    connection = true

    return event.reply('connect', {
      user: client.user.username,
      avatar: client.user.avatarURL()
    })
  })

  client.on(Events.MessageCreate, (message) => {
    stats.incrementMessagesReceived()
    onMessageCreate(message)
  })

  // when a user joins a guild
  client.on(Events.GuildMemberAdd, (member) => {
    stats.incrementJoinEventsReceived()
    onGuildMemberAdd(member)
  })

  // when a user leaves a guild
  client.on(Events.GuildMemberRemove, (member) => {
    stats.incrementLeaveEventsReceived()
    onGuildMemberRemove(member)
  })

  // when a user is banned from a guild
  client.on(Events.GuildBanAdd, (ban) => {
    stats.incrementBanEventsReceived()
    onGuildBanAdd(ban)
  })

  // when a reaction is added to a message
  client.on(Events.MessageReactionAdd, (reaction, user) => {
    onMessageReactionAdd(reaction, user)
  })

  client.on(Events.InteractionCreate, (interaction) => {
    onInteractionCreate(interaction)
  })

  client.login(token).catch((err) => {
    event.reply('fail', { error: err })
  })
}

function convertBotStatusActivityType(activityType: string): ActivityType {
  switch (activityType) {
    case 'Playing':
      return ActivityType.Playing
    case 'Streaming':
      return ActivityType.Streaming
    case 'Listening':
      return ActivityType.Listening
    case 'Watching':
      return ActivityType.Watching
    case 'Competing':
      return ActivityType.Competing
    default:
      return ActivityType.Playing
  }
}

function convertBotStatusStatus(status: string): PresenceStatusData {
  switch (status) {
    case 'Invisible':
      return 'invisible'
    case 'Online':
      return 'online'
    case 'Idle':
      return 'idle'
    case 'Do Not Disturb':
      return 'dnd'
    default:
      return 'online'
  }
}

function applyBotStatus(botStatus: BotStatus) {
  if (client) {
    client.user?.setPresence({
      status: convertBotStatusStatus(botStatus.status),
      activities:
        botStatus.activity != 'None'
          ? [
              {
                name: botStatus.activityDetails,
                type: convertBotStatusActivityType(botStatus.activity)
              }
            ]
          : undefined
    })
  }
}

function Disconnect(event: Electron.IpcMainEvent) {
  if (client) {
    saveBotState() // Save bot state before disconnecting
    client.destroy()
    client = null
    connection = false
  }

  return event.reply('disconnect')
}

async function onInteractionCreate(interaction: Interaction) {
  if (!interaction.isChatInputCommand()) return

  let command = commands.bcfdSlashCommands.find((c) => c.commandName == interaction.commandName)

  if (!command) return

  interaction.reply(command.commandReply)
}

async function requiredRole(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<boolean> {
  if (command.isRequiredRole) {
    // Check if the user has the required role
    if (!message.member?.roles.cache.has(command.requiredRole)) {
      // User does not have the required role, skip the command
      if (!command.ignoreErrorMessage) {
        message.reply('```' + `${command.command} requires role: ${command.requiredRole}` + '```')
      }
      return false
    }
  }
  return true
}

async function deleteIf(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<boolean> {
  if (command.deleteIf) {
    let deleteStrings = command.deleteIfStrings.split('|')
    for (const deleteString of deleteStrings) {
      if (message.content.includes(deleteString)) {
        message.delete()
        break
      }
    }
  }

  return true
}

async function deleteX(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<boolean> {
  if (command.deleteX) {
    // check if user has permission to manage messages
    if (
      !message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
      !(message.channel instanceof TextChannel)
    ) {
      return false
    }

    let deleteAmount = command.deleteNum

    let messages = await message.channel.messages.fetch({ limit: deleteAmount })
    message.channel.bulkDelete(messages)
  }

  return true
}

async function channelMessage(
  command: BCFDCommand,
  channel:
    | TextChannel
    | DMChannel
    | PartialDMChannel
    | NewsChannel
    | StageChannel
    | VoiceChannel
    | PublicThreadChannel<boolean>
    | PrivateThreadChannel
    | VoiceChannel,
  stringInfoMethod: () => string
): Promise<boolean> {
  if (command.actionArr[0]) {
    // reply to message
    channel.send(stringInfoMethod())
  }

  return true
}

async function privateMessage(
  command: BCFDCommand,
  user: User,
  stringInfoMethod: () => string
): Promise<boolean> {
  if (command.actionArr[1]) {
    // sends a private message to the user
    user.send(stringInfoMethod())
  }

  return true
}

async function kick(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>,
  firstItem: string,
  messageWordCount: number
): Promise<boolean> {
  if (command.isKick && command.command == firstItem && messageWordCount == 2) {
    // check if user has permission to kick
    if (!message.member?.permissions.has(PermissionsBitField.Flags.KickMembers)) {
      return false
    }

    let mentioned = message.mentions?.users?.first()

    if (mentioned) {
      // kick the user
      message.guild?.members.kick(mentioned)
    }
  }

  return true
}

async function ban(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>,
  firstItem: string,
  messageWordCount: number
): Promise<boolean> {
  if (command.isBan && command.command == firstItem && messageWordCount == 2) {
    // check if user has permission to ban
    if (!message.member?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
      return false
    }

    let mentioned = message.mentions?.users?.first()

    if (mentioned) {
      // ban the user
      message.guild?.members.ban(mentioned)
    }
  }

  return true
}

async function voiceMute(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>,
  firstItem: string,
  messageWordCount: number
): Promise<boolean> {
  if (command.isVoiceMute && command.command == firstItem && messageWordCount == 2) {
    // check if user has permission to mute
    if (!message.member?.permissions.has(PermissionsBitField.Flags.MuteMembers)) {
      return false
    }

    let mentioned = message.mentions?.users?.first()

    if (mentioned) {
      let userID = mentioned.id
      let guild = message.guild

      if (!guild) {
        return false
      }

      let member = await guild.members.fetch(userID)

      // mute the user
      member.voice.setMute(true, 'Muted by bot command')
    }
  }

  return true
}

async function roleAssigner(
  command: BCFDCommand,
  member: GuildMember,
  stringInfoMethod: (field: string) => string
): Promise<boolean> {
  if (command.isRoleAssigner) {
    let role = stringInfoMethod(command.roleToAssign)

    // add the role to the member if they dont have it, and if they have it remove it
    if (!member.roles.cache.has(role)) {
      member.roles.add(role)
    } else {
      member.roles.remove(role)
    }
  }

  return true
}

async function sendChannelEmbed(
  command: BCFDCommand,
  channel:
    | TextChannel
    | DMChannel
    | PartialDMChannel
    | NewsChannel
    | StageChannel
    | VoiceChannel
    | PublicThreadChannel<boolean>
    | PrivateThreadChannel
    | VoiceChannel,
  stringInfoMethod: (field: string) => string
): Promise<boolean> {
  if (command.sendChannelEmbed) {
    // builds an embed with our embed template
    let embed = new EmbedBuilder()

    if (command.channelEmbed.title != '') {
      embed.setTitle(stringInfoMethod(command.channelEmbed.title))
    }

    if (command.channelEmbed.description != '') {
      embed.setDescription(stringInfoMethod(command.channelEmbed.description))
    }

    if (command.channelEmbed.hexColor != '') {
      // convert our hex color string to 'color'
      let color = parseInt(stringInfoMethod(command.channelEmbed.hexColor), 16)
      embed.setColor(color)
    }

    if (command.channelEmbed.imageURL != '') {
      embed.setImage(stringInfoMethod(command.channelEmbed.imageURL))
    }

    if (command.channelEmbed.thumbnailURL != '') {
      embed.setThumbnail(stringInfoMethod(command.channelEmbed.thumbnailURL))
    }

    if (command.channelEmbed.footer != '') {
      embed.setFooter({ text: stringInfoMethod(command.channelEmbed.footer) })
    }

    // send the embed
    channel.send({ embeds: [embed] })
  }

  return true
}

async function sendPrivateEmbed(
  command: BCFDCommand,
  user: User,
  stringInfoMethod: (field: string) => string
): Promise<boolean> {
  if (command.sendPrivateEmbed) {
    // builds an embed with our embed template
    let embed = new EmbedBuilder()

    if (command.privateEmbed.title != '') {
      embed.setTitle(stringInfoMethod(command.privateEmbed.title))
    }

    if (command.privateEmbed.description != '') {
      embed.setDescription(stringInfoMethod(command.privateEmbed.description))
    }

    if (command.privateEmbed.hexColor != '') {
      // convert our hex color string to 'color'
      let color = parseInt(stringInfoMethod(command.privateEmbed.hexColor), 16)
      embed.setColor(color)
    }

    if (command.privateEmbed.imageURL != '') {
      embed.setImage(stringInfoMethod(command.privateEmbed.imageURL))
    }

    if (command.privateEmbed.thumbnailURL != '') {
      embed.setThumbnail(stringInfoMethod(command.privateEmbed.thumbnailURL))
    }

    if (command.privateEmbed.footer != '') {
      embed.setFooter({ text: stringInfoMethod(command.privateEmbed.footer) })
    }

    // send the embed
    user.send({ embeds: [embed] })
  }

  return true
}

async function react(
  command: BCFDCommand,
  message: OmitPartialGroupDMChannel<Message<boolean>>
): Promise<boolean> {
  if (command.isReact) {
    // add a reaction to the message

    // convert our command reaction to a reaction emote from the guild
    let reaction = message.guild?.emojis.cache.get(
      stringInfoAdd(command.reaction, message, command)
    )

    if (reaction) {
      message.react(reaction)
    }
  }

  return true
}

async function onGuildMemberAdd(member: GuildMember) {
  if (member.user.bot) return

  let filteredCommands = commands.bcfdCommands.filter((c) => c.type == 2)

  for (const command of filteredCommands) {
    if (command.isRoleAssigner) {
      roleAssigner(command, member, (field) => field) //stringInfoAdd(field, member, command))
    }

    // get the first channel of the guild
    let channel = member.guild.channels.cache.first() as TextChannel | undefined

    if (channel) {
      sendChannelEmbed(command, channel, (field) => field) //stringInfoAdd(field, channel, command))
      channelMessage(
        command,
        channel,
        () => command.channelMessage //stringInfoAdd(command.channelMessage, channel, command)
      )
    }

    sendPrivateEmbed(command, member.user, (field) => field) //stringInfoAdd(field, member.user, command))
    privateMessage(
      command,
      member.user,
      () => command.privateMessage //stringInfoAdd(command.privateMessage, member.user, command)
    )
  }
}

async function onGuildMemberRemove(member: GuildMember | PartialGuildMember) {
  if (member.user.bot) return

  let filteredCommands = commands.bcfdCommands.filter((c) => c.type == 3)

  for (const command of filteredCommands) {
    // get the first channel of the guild
    let channel = member.guild.channels.cache.first() as TextChannel | undefined

    if (channel) {
      sendChannelEmbed(command, channel, (field) => field) //stringInfoAdd(field, channel, command))
      channelMessage(
        command,
        channel,
        () => command.channelMessage //stringInfoAdd(command.channelMessage, channel, command)
      )
    }

    sendPrivateEmbed(command, member.user, (field) => field) //stringInfoAdd(field, member.user, command))
    privateMessage(
      command,
      member.user,
      () => command.privateMessage //stringInfoAdd(command.privateMessage, member.user, command)
    )
  }
}

async function onGuildBanAdd(ban: GuildBan) {
  if (ban.user.bot) return

  let filteredCommands = commands.bcfdCommands.filter((c) => c.type == 4)

  for (const command of filteredCommands) {
    // get the first channel of the guild
    let channel = ban.guild.channels.cache.first() as TextChannel | undefined

    if (channel) {
      sendChannelEmbed(command, channel, (field) => field) //stringInfoAdd(field, channel, command))
      channelMessage(
        command,
        channel,
        () => command.channelMessage //stringInfoAdd(command.channelMessage, channel, command)
      )
    }

    sendPrivateEmbed(command, ban.user, (field) => field) //stringInfoAdd(field, member.user, command))
    privateMessage(
      command,
      ban.user,
      () => command.privateMessage //stringInfoAdd(command.privateMessage, member.user, command)
    )
  }
}

async function onMessageReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser
) {
  if (user.bot) return
  
  // Fetch the complete reaction and user if they're partial
  if (reaction.partial) {
    try {
      reaction = await reaction.fetch()
    } catch (error) {
      console.error('Error fetching reaction:', error)
      return
    }
  }
  if (user.partial) {
    try {
      user = await user.fetch()
    } catch (error) {
      console.error('Error fetching user:', error)
      return
    }
  }

  // Get the message
  const message = reaction.message
  let fetchedMessage: OmitPartialGroupDMChannel<Message<boolean>>;
  if (message.partial) {
    try {
      fetchedMessage = await message.fetch()
    } catch (error) {
      console.error('Error fetching message:', error)
      return
    }
  }

  // Get the guild member
  const member = message.guild?.members.cache.get(user.id)
  if (!member) return

  // Filter commands for reaction type (type 5)
  const filteredCommands = commands.bcfdCommands.filter(c => 
    c.type === 5 && (
      // Check if reaction matches command
      c.command === reaction.emoji.id ||
      // Check if reaction matches command name
      c.command === reaction.emoji.name ||
      // Or if it's a phrase match
      (c.phrase && reaction.emoji.name?.toLowerCase().includes(c.command.toLowerCase())) ||
      // Or if it matches specific message
      (c.specificMessage && message.id === c.specificMessage)
    )
  )

  for (const command of filteredCommands) {
    // Check required role
    if (command.isRequiredRole) {
      if (!member.roles.cache.has(command.requiredRole)) {
        if (!command.ignoreErrorMessage) {
          user.send(`This reaction requires role: ${command.requiredRole}`)
        }
        continue
      }
    }

    // Check admin requirement
    if (command.isAdmin) {
      if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        continue
      }
    }

    // Check NSFW requirement
    if (command.isNSFW) {
      if (message.channel instanceof TextChannel && !message.channel.nsfw) {
        continue
      }
    }

    // Handle channel message
    if (command.actionArr[0]) {
      channelMessage(
        command,
        message.channel as TextChannel,
        () => stringInfoAddReaction(command.channelMessage, reaction, command)
      )
    }

    // Handle private message
    if (command.actionArr[1]) {
      privateMessage(
        command,
        user,
        () => stringInfoAddReaction(command.privateMessage, reaction, command)
      )
    }

    // Handle channel embed
    if (command.sendChannelEmbed) {
      sendChannelEmbed(
        command,
        message.channel as TextChannel,
        (field) => stringInfoAddReaction(field, reaction, command)
      )
    }

    // Handle private embed
    if (command.sendPrivateEmbed) {
      sendPrivateEmbed(
        command,
        user,
        (field) => stringInfoAddReaction(field, reaction, command)
      )
    }

    // Handle role assignment
    if (command.isRoleAssigner) {
      roleAssigner(
        command,
        member,
        (field) => stringInfoAddReaction(field, reaction, command)
      )
    }

    // Increment stats if messages were sent
    if (command.actionArr[0] || command.actionArr[1]) {
      stats.incrementMessagesSent()
    }
  }
}

async function onMessageCreate(message: OmitPartialGroupDMChannel<Message<boolean>>) {
  if (message.author.bot) return
  if (message.channel.type === ChannelType.DM) {
    stats.incrementPrivateMessagesReceived()
  }

  let firstItem = message.content.split(' ')[0]
  let messageWordCount = message.content.split(' ').length

  let filteredCommands = commands.bcfdCommands.filter(
    (c) =>
      (c.type == 0 && message.content == c.command) ||
      (c.phrase && message.content.toLowerCase().includes(c.command.toLowerCase())) ||
      c.command == '*' ||
      ((c.isBan || c.isKick || c.isVoiceMute) && c.command == firstItem && messageWordCount == 2)
  )

  for (const command of filteredCommands) {
    if (!(await requiredRole(command, message))) {
      continue
    }

    if (command.isAdmin) {
      if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        continue
      }
    }

    if (command.isNSFW) {
      if (message.channel instanceof TextChannel && !message.channel.nsfw) {
        continue
      }
    }

    deleteIf(command, message)

    if (!(await deleteX(command, message))) {
      continue
    }

    channelMessage(command, message.channel, () =>
      stringInfoAdd(command.channelMessage, message, command)
    )

    privateMessage(command, message.author, () =>
      stringInfoAdd(command.privateMessage, message, command)
    )

    if (!(await kick(command, message, firstItem, messageWordCount))) {
      continue
    }

    if (!(await ban(command, message, firstItem, messageWordCount))) {
      continue
    }

    if (!(await voiceMute(command, message, firstItem, messageWordCount))) {
      continue
    }

    if (message.member) {
      roleAssigner(command, message.member, (field) => stringInfoAdd(field, message, command))
    }

    sendChannelEmbed(command, message.channel, (field) => stringInfoAdd(field, message, command))

    sendPrivateEmbed(command, message.author, (field) => stringInfoAdd(field, message, command))

    react(command, message)

    if (command.deleteAfter) {
      // delete the message
      message.delete()
    }

    if (command.actionArr[0] || command.actionArr[1]) {
      stats.incrementMessagesSent()
    }
  }
}

function stringInfoAdd(
  message: string,
  messageEvent: OmitPartialGroupDMChannel<Message<boolean>>,
  command: BCFDCommand
): string {
  message = stringInfoAddUser(message, messageEvent.author)
  message = stringInfoAddMember(message, messageEvent.member)
  message = stringInfoAddClient(message, messageEvent.client)
  message = stringInfoAddGuild(message, messageEvent.guild)
  if (messageEvent.channel instanceof TextChannel) {
    message = stringInfoAddChannel(message, messageEvent.channel)
  }

  // add the info of the first mentioned user
  if (messageEvent.mentions.users.size > 0) {
    message = stringInfoAddMentionedUser(message, messageEvent.mentions.users.first()!)
  }

  message = stringInfoAddGeneral(message)

  message = stringInfoAddMessageContent(message, messageEvent, command)

  message = stringInfoAddEval(message, context)

  return message
}

// string info add for reaction add event
function stringInfoAddReaction(message: string, reaction: MessageReaction | PartialMessageReaction, command: BCFDCommand): string {

  message = stringInfoAddClient(message, reaction.client)
  message = stringInfoAddGuild(message, reaction.message.guild)
  if (reaction.message.channel instanceof TextChannel) {
    message = stringInfoAddChannel(message, reaction.message.channel)
  }

  message = stringInfoAddGeneral(message)

  message = stringInfoAddMessageContent(message, reaction.message as Message<boolean>, command)

  message = stringInfoAddEval(message, context)


  return message
}


function stringInfoAddUser(message: string, user: User): string {
  message = message
    .replaceAll('$namePlain', user.displayName)
    .replaceAll('$name', `<@${user.id}>`)
    .replaceAll('$defaultavatar', user.defaultAvatarURL)
    .replaceAll('$avatar', user.avatarURL({}) ?? user.defaultAvatarURL)
    .replaceAll('$discriminator', user.discriminator)
    .replaceAll('$tag', user.tag)
    .replaceAll('$id', user.id)
    .replaceAll('$timeCreated', new Date(user.createdTimestamp).toLocaleString())

  // todo $serversSharedWithBot

  return message
}

function stringInfoAddMember(message: string, member: GuildMember | null): string {
  if (!member) {
    return message
  }

  message = message
    .replaceAll('$memberIsOwner', (member.guild.ownerId == member.id).toString())
    .replaceAll('$memberEffectiveName', member.displayName)
    .replaceAll('$memberNickname', member.nickname ?? '')
    .replaceAll('$memberID', member.id)
    .replaceAll('$memberHasTimeJoined', (member.joinedTimestamp != null).toString())
    .replaceAll(
      '$memberTimeJoined',
      member.joinedTimestamp != null ? new Date(member.joinedTimestamp).toLocaleString() : ''
    )
    .replaceAll(
      '$memberEffectiveAvatar',
      member.avatarURL({}) ?? member.user.avatarURL({}) ?? member.user.defaultAvatarURL
    )
    .replaceAll('$memberHasBoosted', (member.premiumSinceTimestamp != null).toString())
    .replaceAll(
      '$memberTimeBoosted',
      member.premiumSinceTimestamp != null
        ? new Date(member.premiumSinceTimestamp).toLocaleString()
        : ''
    )

  return message
}

function stringInfoAddClient(message: string, client: Client): string {
  message = message
    .replaceAll('$ping', client.ws.ping.toString())
    .replaceAll(
      '$inviteURL',
      client.generateInvite({
        scopes: [OAuth2Scopes.Bot],
        permissions: [PermissionsBitField.Flags.Administrator]
      })
    )
    .replaceAll('$serverCount', client.guilds.cache.size.toString())
    .replaceAll('$allMemberCount', client.users.cache.size.toString())

  if (client.user) {
    message = message
      .replaceAll('$botAvatar', client.user.avatarURL({}) ?? client.user.defaultAvatarURL)
      .replaceAll('$botName', `<@${client.user.id}>`)
      .replaceAll('$botNamePlain', client.user.displayName)
      .replaceAll('$botID', client.user.id)
      .replaceAll('$botDiscriminator', client.user.discriminator)
      .replaceAll('$botTag', client.user.tag)
      .replaceAll('$botDefaultAvatar', client.user.defaultAvatarURL)
      .replaceAll('$botTimeCreated', new Date(client.user.createdTimestamp).toLocaleString())
      .replaceAll('$botID', client.user.id)
  }

  return message
}

function stringInfoAddGuild(message: string, guild: Guild | null): string {
  if (!guild) {
    return message
  }

  message = message
    .replaceAll('$memberCount', guild.memberCount.toString())
    .replaceAll('$serverCreateTime', new Date(guild.createdTimestamp).toLocaleString())
    .replaceAll('$serverIcon', guild.iconURL({}) ?? '')
    .replaceAll('$serverBanner', guild.bannerURL({}) ?? '')
    .replaceAll('$serverDescription', guild.description ?? '')
    .replaceAll('$serverSplash', guild.splashURL({}) ?? '')
    .replaceAll('$server', guild.name)

  return message
}

function stringInfoAddChannel(message: string, channel: TextChannel | null): string {
  if (!channel) {
    return message
  }

  message = message
    .replaceAll('$channel', channel.name)
    .replaceAll('$channelID', channel.id)
    .replaceAll('$channelCreateDate', new Date(channel.createdTimestamp).toLocaleString())
    .replaceAll('$channelAsMention', `<#${channel.id}>`)

  return message
}

function stringInfoAddMentionedUser(message: string, user: User): string {
  message = message
    .replaceAll('$mentionedName', `<@${user.id}>`)
    .replaceAll('$mentionedID', user.id)
    .replaceAll('$mentionedTag', user.tag)
    .replaceAll('$mentionedDiscriminator', user.discriminator)
    .replaceAll('$mentionedAvatar', user.avatarURL({}) ?? user.defaultAvatarURL)
    .replaceAll('$mentionedTimeCreated', new Date(user.createdTimestamp).toLocaleString())
    .replaceAll('$mentionedNamePlain', user.displayName)
    .replaceAll('$mentionedDefaultAvatar', user.defaultAvatarURL)
    .replaceAll('$mentionedIsBot', user.bot.toString())

  return message
}

function stringInfoAddGeneral(message: string) {
  // while $random is in the message, a command which comes in the form $random{abc|def|ghi}
  // replace $random with a random string from the list
  while (message.includes('$random')) {
    let start = message.indexOf('$random')
    let subMessage = message.substring(start + 7)
    if (subMessage.includes('}') && subMessage.charAt(0) == '{') {
      let postMessage = subMessage.substring(subMessage.indexOf('}') + 1)
      subMessage = subMessage.substring(1, subMessage.indexOf('}'))
      let messageArray = subMessage.split('|')
      message =
        message.substring(0, start) +
        messageArray[Math.floor(Math.random() * messageArray.length)] +
        postMessage
    } else {
      return message + '```ERROR: MISSING { } ON $random```'
    }
  }

  message = message
    .replaceAll('$commandCount', commands.bcfdCommands.length.toString())
    .replaceAll('$date', new Date().toLocaleString())
    .replaceAll(
      '$minutes',
      (new Date().getMinutes() < 10 ? '0' : '') + new Date().getMinutes().toString()
    )
    .replaceAll(
      '$hours',
      (new Date().getHours() < 10 ? '0' : '') + new Date().getHours().toString()
    )
    .replaceAll(
      '$seconds',
      (new Date().getSeconds() < 10 ? '0' : '') + new Date().getSeconds().toString()
    )

  // while $rollnum is in the message which is a command in the form $rollnum(1,10) it inserts a random number in the range inclusive.
  while (message.includes('$rollnum')) {
    let start = message.indexOf('$rollnum')
    let subMessage = message.substring(start + 8)

    if (subMessage.includes('(') && subMessage.includes(',') && subMessage.includes(')')) {
      let x = parseInt(subMessage.substring(1, subMessage.indexOf(',')).trim())
      let y = parseInt(
        subMessage.substring(subMessage.indexOf(',') + 1, subMessage.indexOf(')')).trim()
      )

      let result = Math.floor(Math.random() * (y - x + 1)) + x
      message =
        message.substring(0, start) +
        result.toString() +
        subMessage.substring(subMessage.indexOf(')') + 1)
    } else {
      return message + '```ERROR: MISSING ( ) ON $rollnum```'
    }
  }

  while (message.includes('$sum')) {
    let start = message.indexOf('$sum')
    let subMessage = message.substring(start + 4)
    if (subMessage.includes('}') && subMessage.charAt(0) == '{') {
      let postMessage = subMessage.substring(subMessage.indexOf('}') + 1)

      subMessage = subMessage.substring(1, subMessage.indexOf('}'))

      let numberArray = subMessage.split('|')

      try {
        let result = 0
        for (const number of numberArray) {
          result += parseInt(number)
        }

        message = message.substring(0, start) + result.toString() + postMessage
      } catch (error) {
        return message + '```ERROR: NOT A NUMBER ON $sum```'
      }
    } else {
      return message + '```ERROR: MISSING { } ON $sum```'
    }
  }

  return message
}

function stringInfoAddMessageContent(message: string, baseMessage: Message, command: BCFDCommand) {
  message = message
    .replaceAll('$message', baseMessage.content)
    .replaceAll('$messageAfterCommand', baseMessage.content.substring(command.command.length))

  return message
}

// Add this function to save stats periodically
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