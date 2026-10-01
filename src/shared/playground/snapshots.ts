import { PLAYGROUND_OPTION_NAME } from './optionName'
export { snapshotCommands } from './commandSnapshots'
import type {
  BCFDEmbedMessageTemplate,
  BCFDInteractionAction,
  BCFDInteractionButton,
  BCFDInteractionCommand,
  BCFDSlashCommandOption
} from '../../main/types/types'
import { PLAYGROUND_LIMITS } from './types'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed saved playground data')
  return value as Record<string, unknown>
}

export function snapshotInteractions(value: unknown): BCFDInteractionCommand[] {
  if (!Array.isArray(value) || value.length > PLAYGROUND_LIMITS.commands)
    throw new Error('Saved-interaction limit exceeded')
  let remaining = PLAYGROUND_LIMITS.requestBytes as number
  let nodes = 0
  const seen = new Set<object>()
  const text = (value: unknown, max: number = PLAYGROUND_LIMITS.template): string => {
    if (value === undefined) return ''
    if (typeof value !== 'string' || value.length > max)
      throw new Error('Saved interaction text exceeds the limit or is malformed')
    remaining -= value.length
    if (remaining < 0) throw new Error('Saved interactions exceed the total size limit')
    return value
  }
  const flag = (value: unknown): boolean => {
    if (value === undefined) return false
    if (typeof value !== 'boolean') throw new Error('Malformed saved action flag')
    return value
  }
  const number = (value: unknown, fallback = 0): number => {
    if (value === undefined) return fallback
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new Error('Malformed saved number')
    return value
  }
  const embed = (value: unknown): BCFDEmbedMessageTemplate => {
    const source = value === undefined ? {} : record(value)
    return {
      title: text(source.title),
      description: text(source.description),
      hexColor: text(source.hexColor),
      imageURL: text(source.imageURL),
      thumbnailURL: text(source.thumbnailURL),
      footer: text(source.footer)
    }
  }
  const action = (value: unknown, depth: number): BCFDInteractionAction => {
    const source = record(value)
    if (++nodes > 1000 || depth > 16 || seen.has(source))
      throw new Error('Saved button tree exceeds the limit or is cyclic')
    seen.add(source)
    const rawButtons = source.buttons ?? []
    if (!Array.isArray(rawButtons) || rawButtons.length > 25)
      throw new Error('Saved button count exceeds the limit')
    const buttons = rawButtons.map((value): BCFDInteractionButton => {
      const button = record(value),
        style = number(button.style)
      if (![1, 2, 3, 4, 5].includes(style)) throw new Error('Malformed saved button style')
      return {
        customId: text(button.customId, 100),
        label: text(button.label),
        style: style as BCFDInteractionButton['style'],
        emoji: text(button.emoji, 100),
        url: text(button.url),
        disabled: flag(button.disabled),
        action: action(button.action, depth + 1)
      }
    })
    seen.delete(source)
    return {
      sendChannelMessage: flag(source.sendChannelMessage),
      channelMessage: text(source.channelMessage),
      sendPrivateMessage: flag(source.sendPrivateMessage),
      privateMessage: text(source.privateMessage),
      sendChannelEmbed: flag(source.sendChannelEmbed),
      channelEmbed: embed(source.channelEmbed),
      sendPrivateEmbed: flag(source.sendPrivateEmbed),
      privateEmbed: embed(source.privateEmbed),
      isRoleAssigner: flag(source.isRoleAssigner),
      roleToAssign: text(source.roleToAssign),
      isKick: flag(source.isKick),
      isBan: flag(source.isBan),
      isVoiceMute: flag(source.isVoiceMute),
      targetUserOptionName: text(source.targetUserOptionName, 64),
      deleteX: flag(source.deleteX),
      deleteNum: number(source.deleteNum),
      ephemeral: flag(source.ephemeral),
      deferReply: flag(source.deferReply),
      buttons
    }
  }
  const ids = new Set<string>()
  const result = value.map((value): BCFDInteractionCommand => {
    const source = record(value),
      id = text(source.id, 100)
    if (!id || ids.has(id)) throw new Error('Missing or duplicate saved interaction ID')
    ids.add(id)
    if (!Array.isArray(source.options) || source.options.length > 25)
      throw new Error('Saved option count exceeds the limit')
    const optionNames = new Set<string>()
    const options = source.options.map((value): BCFDSlashCommandOption => {
      const option = record(value),
        type = number(option.type)
      const name = text(option.name, 64)
      if (!PLAYGROUND_OPTION_NAME.test(name) || optionNames.has(name.toLowerCase()))
        throw new Error('Invalid or duplicate saved option name')
      optionNames.add(name.toLowerCase())
      if (![3, 4, 5, 6, 7, 8, 10].includes(type)) throw new Error('Malformed saved option type')
      let choices: BCFDSlashCommandOption['choices']
      if (option.choices !== undefined) {
        if (!Array.isArray(option.choices) || option.choices.length > 25)
          throw new Error('Saved choice count exceeds the limit')
        choices = option.choices.map((value) => {
          const choice = record(value)
          return {
            name: text(choice.name, 100),
            value:
              typeof choice.value === 'number' ? number(choice.value) : text(choice.value, 6000)
          }
        })
      }
      return {
        name,
        description: text(option.description, 100),
        type: type as BCFDSlashCommandOption['type'],
        required: flag(option.required),
        choices
      }
    })
    return {
      id,
      commandName: text(source.commandName, 64),
      commandDescription: text(source.commandDescription, 100),
      options,
      rootAction: action(source.rootAction, 0),
      isRegistered: flag(source.isRegistered),
      guildId: text(source.guildId, 100),
      cooldown: number(source.cooldown),
      cooldownType: text(source.cooldownType, 100),
      cooldownMessage: text(source.cooldownMessage)
    }
  })
  if (JSON.stringify(result).length > PLAYGROUND_LIMITS.requestBytes)
    throw new Error('Saved interactions exceed the total size limit')
  return result
}
