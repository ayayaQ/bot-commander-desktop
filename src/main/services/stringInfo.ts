import { Client, Guild, GuildMember, Message, MessageReaction, OAuth2Scopes, OmitPartialGroupDMChannel, PartialMessageReaction, PermissionsBitField, TextChannel, User } from "discord.js"
import { BCFDCommand } from "../types/types"
import { getCommands, getContext } from "./botService"
import { stringInfoAddEval } from "../utils/virtual"

export function stringInfoAdd(
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
  
    message = stringInfoAddEval(message, getContext())
  
    return message
  }
  
  // string info add for reaction add event
  export function stringInfoAddReaction(message: string, reaction: MessageReaction | PartialMessageReaction, command: BCFDCommand): string {
  
    message = stringInfoAddClient(message, reaction.client)
    message = stringInfoAddGuild(message, reaction.message.guild)
    if (reaction.message.channel instanceof TextChannel) {
      message = stringInfoAddChannel(message, reaction.message.channel)
    }
  
    message = stringInfoAddGeneral(message)
  
    message = stringInfoAddMessageContent(message, reaction.message as Message<boolean>, command)
  
    message = stringInfoAddEval(message, getContext())
  
  
    return message
  }
  
  
  export function stringInfoAddUser(message: string, user: User): string {
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
  
  export function stringInfoAddMember(message: string, member: GuildMember | null): string {
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
  
  export function stringInfoAddClient(message: string, client: Client): string {
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
  
  export function stringInfoAddGuild(message: string, guild: Guild | null): string {
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
  
  export function stringInfoAddChannel(message: string, channel: TextChannel | null): string {
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
  
  export function stringInfoAddMentionedUser(message: string, user: User): string {
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
  
  export function stringInfoAddGeneral(message: string) {
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
      .replaceAll('$commandCount', getCommands().bcfdCommands.length.toString())
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
  
  export function stringInfoAddMessageContent(message: string, baseMessage: Message, command: BCFDCommand) {
    message = message
      .replaceAll('$message', baseMessage.content)
      .replaceAll('$messageAfterCommand', baseMessage.content.substring(command.command.length))
  
    return message
  }