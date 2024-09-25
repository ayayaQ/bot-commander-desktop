import { app, shell, BrowserWindow, ipcMain, session } from 'electron'
import { join } from 'path'
import vm from 'node:vm'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  ActivityType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  IntentsBitField,
  Interaction,
  Message,
  OmitPartialGroupDMChannel,
  PresenceStatusData,
  TextChannel,
  User,
  WebhookClient
} from 'discord.js'
import fs from 'fs/promises'
import { AppSettings, BCFDCommand, BCFDSlashCommand, BotStatus } from './types'
import { OAuth2Scopes, PermissionsBitField } from 'discord.js'
import { stringInfoAddEval } from './virtual'

let client: Client | null = null
let connection: boolean = false
let commands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] } = {
  bcfdCommands: [],
  bcfdSlashCommands: []
}
let context: vm.Context
let settings: AppSettings = { theme: 'light' } // Default settings
let botStatus: BotStatus = {
  status: 'online',
  activity: 'Playing',
  activityDetails: 'with BCFD',
  streamUrl: ''
} // Default bot status

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

  await loadSettings()
  await loadBotStatus()

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
    applyBotStatus(botStatus);
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

  // send a webhook using discord.js
  ipcMain.on('send-webhook', async (event, webhook) => {
    const webhookClient = new WebhookClient({ url: webhook.webhookUrl })
    await webhookClient.send({
      username: webhook.name ?? undefined,
      avatarURL: webhook.avatarUrl ?? undefined,
      content: webhook.message ?? undefined
    })
    webhookClient.destroy()
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

    context = vm.createContext()

    // Use our bot status to set the presence of the bot
    applyBotStatus(botStatus);

    connection = true

    return event.reply('connect', {
      user: client.user.username,
      avatar: client.user.avatarURL()
    })
  })

  client.on('messageCreate', (message) => {
    onMessageCreate(message)
  })

  client.on('interactionCreate', (interaction) => {
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

async function onMessageCreate(message: OmitPartialGroupDMChannel<Message<boolean>>) {
  if (message.author.bot) return

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
    if (command.isRequiredRole) {
      // Check if the user has the required role
      if (!message.member?.roles.cache.has(command.roleToAssign)) {
        // User does not have the required role, skip the command
        if (!command.ignoreErrorMessage) {
          message.reply('```' + `${command.command} requires role: ${command.roleToAssign}` + '```')
        }
        continue
      }
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

    if (command.deleteIf) {
      let deleteStrings = command.deleteIfStrings.split('|')
      for (const deleteString of deleteStrings) {
        if (message.content.includes(deleteString)) {
          message.delete()
          break
        }
      }
    }

    if (command.deleteX) {
      // check if user has permission to manage messages
      if (
        !message.member?.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
        !(message.channel instanceof TextChannel)
      ) {
        continue
      }

      let deleteAmount = command.deleteNum
      // get the previous x messages
      let messages = await message.channel.messages.fetch({ limit: deleteAmount })
      // delete the messages
      message.channel.bulkDelete(messages)
    }

    if (command.actionArr[0]) {
      // reply to message
      message.channel.send(stringInfoAdd(command.channelMessage, message, command))
    }

    if (command.actionArr[1]) {
      // sends a private message to the user
      message.author.send(stringInfoAdd(command.privateMessage, message, command))
    }

    if (command.isKick && command.command == firstItem && messageWordCount == 2) {
      // check if user has permission to kick
      if (!message.member?.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        continue
      }

      let mentioned = message.mentions?.users?.first()

      if (mentioned) {
        // kick the user
        message.guild?.members.kick(mentioned)
      }
    }

    if (command.isBan && command.command == firstItem && messageWordCount == 2) {
      // check if user has permission to ban
      if (!message.member?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        continue
      }

      let mentioned = message.mentions?.users?.first()

      if (mentioned) {
        // ban the user
        message.guild?.members.ban(mentioned)
      }
    }

    if (command.isVoiceMute && command.command == firstItem && messageWordCount == 2) {
      // check if user has permission to mute
      if (!message.member?.permissions.has(PermissionsBitField.Flags.MuteMembers)) {
        continue
      }

      let mentioned = message.mentions?.users?.first()

      if (mentioned) {
        let userID = mentioned.id
        let guild = message.guild

        if (!guild) {
          continue
        }

        let member = await guild.members.fetch(userID)

        // mute the user
        member.voice.setMute(true, 'Muted by bot command')
      }
    }

    if (command.isRoleAssigner) {
      let role = stringInfoAdd(command.roleToAssign, message, command)

      // add the role to the member if they dont have it, and if they have it remove it
      if (!message.member?.roles.cache.has(role)) {
        message.member?.roles.add(role)
      } else {
        message.member?.roles.remove(role)
      }
    }

    if (command.sendChannelEmbed) {
      // builds an embed with our embed template
      let embed = new EmbedBuilder()

      if (command.channelEmbed.title != '') {
        embed.setTitle(stringInfoAdd(command.channelEmbed.title, message, command))
      }

      if (command.channelEmbed.description != '') {
        embed.setDescription(stringInfoAdd(command.channelEmbed.description, message, command))
      }

      if (command.channelEmbed.hexColor != '') {
        // convert our hex color string to 'color'
        let color = parseInt(stringInfoAdd(command.channelEmbed.hexColor, message, command), 16)
        embed.setColor(color)
      }

      if (command.channelEmbed.imageURL != '') {
        embed.setImage(stringInfoAdd(command.channelEmbed.imageURL, message, command))
      }

      if (command.channelEmbed.thumbnailURL != '') {
        embed.setThumbnail(stringInfoAdd(command.channelEmbed.thumbnailURL, message, command))
      }

      if (command.channelEmbed.footer != '') {
        embed.setFooter({ text: stringInfoAdd(command.channelEmbed.footer, message, command) })
      }

      // send the embed
      message.channel.send({ embeds: [embed] })
    }

    if (command.sendPrivateEmbed) {
      // builds an embed with our embed template
      let embed = new EmbedBuilder()

      if (command.privateEmbed.title != '') {
        embed.setTitle(stringInfoAdd(command.privateEmbed.title, message, command))
      }

      if (command.privateEmbed.description != '') {
        embed.setDescription(stringInfoAdd(command.privateEmbed.description, message, command))
      }

      if (command.privateEmbed.hexColor != '') {
        // convert our hex color string to 'color'
        let color = parseInt(stringInfoAdd(command.privateEmbed.hexColor, message, command), 16)
        embed.setColor(color)
      }

      if (command.privateEmbed.imageURL != '') {
        embed.setImage(stringInfoAdd(command.privateEmbed.imageURL, message, command))
      }

      if (command.privateEmbed.thumbnailURL != '') {
        embed.setThumbnail(stringInfoAdd(command.privateEmbed.thumbnailURL, message, command))
      }

      if (command.privateEmbed.footer != '') {
        embed.setFooter({ text: stringInfoAdd(command.privateEmbed.footer, message, command) })
      }

      // send the embed
      message.author.send({ embeds: [embed] })
    }

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

    if (command.deleteAfter) {
      // delete the message
      message.delete()
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
