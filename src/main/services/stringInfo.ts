import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  CommandInteractionOptionResolver,
  Guild,
  GuildMember,
  Message,
  MessageReaction,
  OmitPartialGroupDMChannel,
  TextChannel,
  User
} from 'discord.js'
import { BCFDCommand, BCFDInteractionCommand } from '../types/types'
import { getContext } from './botService'
import { getSettings } from './settingsService'
import { interpret, BCFDContext as InterpreterContext } from './bcfdLang'
import { rendererConsole } from '../utils/rendererConsole'

export type StringInfoContext = {
  message: string
  user?: User
  member?: GuildMember
  client?: Client
  guild?: Guild
  textChannel?: TextChannel
  mentionedUser?: User
  mentionedMember?: GuildMember
  messageEvent?: OmitPartialGroupDMChannel<Message<boolean>> | Message<boolean>
  command?: BCFDCommand
  interactionCommand?: BCFDInteractionCommand
  interactionOptions?: CommandInteractionOptionResolver
}

export function contextForMessageEvent(
  message: string,
  command: BCFDCommand,
  event: OmitPartialGroupDMChannel<Message<boolean>>
): StringInfoContext {
  return {
    message,
    user: event.author,
    member: event.member ?? undefined,
    client: event.client,
    guild: event.guild ?? undefined,
    textChannel: event.channel as TextChannel,
    mentionedUser: event.mentions.users.first(),
    mentionedMember: event.mentions.members?.first(),
    messageEvent: event,
    command
  }
}

export async function stringInfoAdd(ctx: StringInfoContext): Promise<string> {
  const cmdSource = ctx.command || ctx.interactionCommand
  const interpreterCtx: InterpreterContext = {
    user: ctx.user,
    member: ctx.member,
    client: ctx.client,
    guild: ctx.guild,
    textChannel: ctx.textChannel,
    mentionedUser: ctx.mentionedUser,
    mentionedMember: ctx.mentionedMember,
    messageEvent: ctx.messageEvent,
    command: ctx.command,
    interactionCommand: ctx.interactionCommand,
    interactionOptions: ctx.interactionOptions,
    vmContext: getContext(),
    wrapEvalInIIFE: !getSettings().useLegacyInterpreter,
    commandId: cmdSource?.id,
    cooldown: cmdSource?.cooldown,
    cooldownType: cmdSource?.cooldownType,
    userId: ctx.user?.id,
    guildId: ctx.guild?.id
  }

  const result = await interpret(ctx.message, interpreterCtx)

  if (result.errors.length > 0) {
    console.warn('BCFD Interpreter errors:', result.errors)
    for (const error of result.errors) {
      const location =
        error.lineNumber != null
          ? ` (JS line ${error.lineNumber}${
              error.columnNumber != null ? `, column ${error.columnNumber}` : ''
            })`
          : ''
      const context = error.sourceContext ? `\nNear:\n${error.sourceContext}` : ''
      rendererConsole.error(`Interpreter: ${error.message}${location}${context}`)
    }
  }

  return result.output
}

export function contextForReactionEvent(
  message: string,
  event: MessageReaction,
  command: BCFDCommand
): StringInfoContext {
  return {
    message,
    client: event.client,
    guild: event.message.guild ?? undefined,
    textChannel: event.message.channel as TextChannel,
    messageEvent: event.message as Message<boolean>,
    command
  }
}

export function contextForInteractionEvent(
  message: string,
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  command: BCFDInteractionCommand
): StringInfoContext {
  return {
    message,
    user: interaction.user,
    member: (interaction.member as GuildMember) ?? undefined,
    client: interaction.client,
    guild: interaction.guild ?? undefined,
    textChannel: (interaction.channel as TextChannel) ?? undefined,
    interactionCommand: command,
    interactionOptions: interaction.isChatInputCommand()
      ? (interaction.options as CommandInteractionOptionResolver)
      : undefined
  }
}
