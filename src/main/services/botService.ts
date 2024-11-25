import { ActivityType, ChannelType, Client, DMChannel, EmbedBuilder, Events, GuildBan, GuildMember, IntentsBitField, Interaction, Message, MessageReaction, NewsChannel, OmitPartialGroupDMChannel, PartialDMChannel, PartialGuildMember, PartialMessageReaction, Partials, PartialUser, PermissionsBitField, PresenceStatusData, PrivateThreadChannel, PublicThreadChannel, StageChannel, TextChannel, User, VoiceChannel } from "discord.js";
import { BCFDCommand, BCFDSlashCommand, BotStatus } from "../types/types";
import { getBotStateContext, loadBotState, saveBotState } from "../virtual";
import vm from 'node:vm'
import { session } from "electron";
import { getBotStatus } from "./statusService";
import { stringInfoAdd, stringInfoAddReaction } from "./stringInfo";
import { getStatsInstance, Stats } from "../stats";

let client: Client | null = null
let connection: boolean = false
let commands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] } = {
  bcfdCommands: [],
  bcfdSlashCommands: []
}
let context: vm.Context
let stats: Stats;

export function setCommands(newCommands: { bcfdCommands: BCFDCommand[]; bcfdSlashCommands: BCFDSlashCommand[] }) {
    commands = newCommands
}

export function getCommands() {
  return commands
}

export function getContext() {
  return context;
}

export function getClient() {
  return client
}

export function Connect(event: Electron.IpcMainEvent, token: string) {
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
      applyBotStatus(getBotStatus())
  
      stats = getStatsInstance()
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

  export function Disconnect(event: Electron.IpcMainEvent) {
    if (client) {
      saveBotState() // Save bot state before disconnecting
      client.destroy()
      client = null
      connection = false
    }
  
    return event.reply('disconnect')
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
  
  export function applyBotStatus(botStatus: BotStatus) {
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
    if (message.partial) {
      try {
        await message.fetch()
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