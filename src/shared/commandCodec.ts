import { commandCapabilities, hasEmbedContent, type CommandEmbed } from './commandCapabilities'

export type CanonicalBCFDCommand = {
  id: string
  channelMessage: string
  command: string
  commandDescription: string
  deleteAfter: boolean
  deleteIfStrings: string
  deleteNum: number
  ignoreErrorMessage: boolean
  isBan: boolean
  isKick: boolean
  isNSFW: boolean
  requiredRole: string
  isVoiceMute: boolean
  isAdmin: boolean
  phrase: boolean
  privateMessage: string
  reaction: string
  roleToAssign: string
  specificChannel: string
  specificMessage: string
  startsWith: boolean
  type: 0 | 1 | 2 | 3 | 4 | 5
  channelEmbed: CommandEmbed
  privateEmbed: CommandEmbed
  cooldown?: number
  cooldownType?: string
  cooldownMessage?: string
  channelMessageAsReply?: boolean
  channelEmbedAsReply?: boolean
  channelMessageTyping?: boolean
  channelEmbedTyping?: boolean
  channelWhitelist?: string
  serverWhitelist?: string
}

export type CommandDecodeResult = {
  command: CanonicalBCFDCommand
  migrated: boolean
  droppedFields: string[]
}

const canonicalFields = new Set([
  'id', 'channelMessage', 'command', 'commandDescription', 'deleteAfter', 'deleteIfStrings',
  'deleteNum', 'ignoreErrorMessage', 'isBan', 'isKick', 'isNSFW', 'requiredRole',
  'isVoiceMute', 'isAdmin', 'phrase', 'privateMessage', 'reaction', 'roleToAssign',
  'specificChannel', 'specificMessage', 'startsWith', 'type', 'channelEmbed', 'privateEmbed',
  'cooldown', 'cooldownType', 'cooldownMessage', 'channelMessageAsReply',
  'channelEmbedAsReply', 'channelMessageTyping', 'channelEmbedTyping', 'channelWhitelist',
  'serverWhitelist'
])

const legacyFields = new Set([
  'actionArr', 'deleteIf', 'deleteX', 'isReact', 'isRequiredRole', 'isRoleAssigner',
  'isSpecificChannel', 'isSpecificMessage', 'sendChannelEmbed', 'sendPrivateEmbed',
  'isChannelWhitelist', 'isServerWhitelist', 'ignoreErrorMessages'
])

const blankEmbed = (): CommandEmbed => ({
  title: '', description: '', hexColor: '', imageURL: '', thumbnailURL: '', footer: ''
})

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, path: string, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') throw new Error(`${path} must be a string`)
  return value
}

function boolean(value: unknown, path: string, fallback = false): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
  return value
}

function number(value: unknown, path: string, fallback = 0): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be a number`)
  return value
}

function embed(value: unknown, path: string): CommandEmbed {
  if (value === undefined || value === null) return blankEmbed()
  const source = object(value, path)
  return {
    title: string(source.title, `${path}.title`),
    description: string(source.description, `${path}.description`),
    hexColor: string(source.hexColor, `${path}.hexColor`),
    imageURL: string(source.imageURL, `${path}.imageURL`),
    thumbnailURL: string(source.thumbnailURL, `${path}.thumbnailURL`),
    footer: string(source.footer, `${path}.footer`)
  }
}

function legacyEnabled(
  source: Record<string, unknown>,
  key: string,
  payloadActive: boolean,
  path: string
): boolean {
  if (!(key in source)) return payloadActive
  const enabled = boolean(source[key], path)
  if (enabled && !payloadActive) throw new Error(`${path} is enabled but its payload is empty`)
  return enabled
}

export function decodeBCFDCommand(
  value: unknown,
  createId: () => string = () => globalThis.crypto.randomUUID()
): CommandDecodeResult {
  const source = object(value, 'command')
  for (const field of ['command', 'commandDescription', 'type', 'channelMessage', 'privateMessage', 'channelEmbed', 'privateEmbed']) {
    if (!(field in source)) throw new Error(`${field} is required`)
  }
  const channelEmbed = embed(source.channelEmbed, 'channelEmbed')
  const privateEmbed = embed(source.privateEmbed, 'privateEmbed')
  let channelMessage = string(source.channelMessage, 'channelMessage')
  let privateMessage = string(source.privateMessage, 'privateMessage')
  let deleteIfStrings = string(source.deleteIfStrings, 'deleteIfStrings')
  let deleteNum = number(source.deleteNum, 'deleteNum')
  let requiredRole = string(source.requiredRole, 'requiredRole')
  let roleToAssign = string(source.roleToAssign, 'roleToAssign')
  let specificChannel = string(source.specificChannel, 'specificChannel')
  let specificMessage = string(source.specificMessage, 'specificMessage')
  let reaction = string(source.reaction, 'reaction')
  let channelWhitelist = string(source.channelWhitelist, 'channelWhitelist')
  let serverWhitelist = string(source.serverWhitelist, 'serverWhitelist')

  if ('actionArr' in source) {
    if (!Array.isArray(source.actionArr) || source.actionArr.length < 2 ||
        source.actionArr.slice(0, 2).some((item) => typeof item !== 'boolean')) {
      throw new Error('actionArr must contain two booleans')
    }
    if (!source.actionArr[0]) channelMessage = ''
    else if (!commandCapabilities.sendsChannelMessage({ channelMessage })) throw new Error('actionArr[0] is enabled but channelMessage is empty')
    if (!source.actionArr[1]) privateMessage = ''
    else if (!commandCapabilities.sendsPrivateMessage({ privateMessage })) throw new Error('actionArr[1] is enabled but privateMessage is empty')
  }

  const normalizedChannelEmbed = legacyEnabled(source, 'sendChannelEmbed', hasEmbedContent(channelEmbed), 'sendChannelEmbed') ? channelEmbed : blankEmbed()
  const normalizedPrivateEmbed = legacyEnabled(source, 'sendPrivateEmbed', hasEmbedContent(privateEmbed), 'sendPrivateEmbed') ? privateEmbed : blankEmbed()
  if (!legacyEnabled(source, 'deleteIf', commandCapabilities.deletesIfMatched({ deleteIfStrings }), 'deleteIf')) deleteIfStrings = ''
  if (!legacyEnabled(source, 'deleteX', commandCapabilities.deletesMessages({ deleteNum }), 'deleteX')) deleteNum = 0
  if (!legacyEnabled(source, 'isRequiredRole', commandCapabilities.hasRequiredRole({ requiredRole }), 'isRequiredRole')) requiredRole = ''
  if (!legacyEnabled(source, 'isRoleAssigner', commandCapabilities.assignsRole({ roleToAssign }), 'isRoleAssigner')) roleToAssign = ''
  if (!legacyEnabled(source, 'isSpecificChannel', commandCapabilities.usesSpecificChannel({ specificChannel }), 'isSpecificChannel')) specificChannel = ''
  if (!legacyEnabled(source, 'isSpecificMessage', commandCapabilities.usesSpecificMessage({ specificMessage }), 'isSpecificMessage')) specificMessage = ''
  if (!legacyEnabled(source, 'isReact', commandCapabilities.reacts({ reaction }), 'isReact')) reaction = ''
  if (!legacyEnabled(source, 'isChannelWhitelist', commandCapabilities.limitsChannels({ channelWhitelist }), 'isChannelWhitelist')) channelWhitelist = ''
  if (!legacyEnabled(source, 'isServerWhitelist', commandCapabilities.limitsServers({ serverWhitelist }), 'isServerWhitelist')) serverWhitelist = ''

  const type = number(source.type, 'type')
  if (!Number.isInteger(type) || type < 0 || type > 5) throw new Error('type must be an integer from 0 to 5')

  const command: CanonicalBCFDCommand = {
    id: string(source.id, 'id') || createId(),
    channelMessage,
    command: string(source.command, 'command'),
    commandDescription: string(source.commandDescription, 'commandDescription'),
    deleteAfter: boolean(source.deleteAfter, 'deleteAfter'),
    deleteIfStrings,
    deleteNum,
    ignoreErrorMessage: boolean(source.ignoreErrorMessage ?? source.ignoreErrorMessages, 'ignoreErrorMessage'),
    isBan: boolean(source.isBan, 'isBan'),
    isKick: boolean(source.isKick, 'isKick'),
    isNSFW: boolean(source.isNSFW, 'isNSFW'),
    requiredRole,
    isVoiceMute: boolean(source.isVoiceMute, 'isVoiceMute'),
    isAdmin: boolean(source.isAdmin, 'isAdmin'),
    phrase: boolean(source.phrase, 'phrase'),
    privateMessage,
    reaction,
    roleToAssign,
    specificChannel,
    specificMessage,
    startsWith: boolean(source.startsWith, 'startsWith'),
    type: type as CanonicalBCFDCommand['type'],
    channelEmbed: normalizedChannelEmbed,
    privateEmbed: normalizedPrivateEmbed
  }

  const optionalStrings = ['cooldownType', 'cooldownMessage'] as const
  const optionalBooleans = ['channelMessageAsReply', 'channelEmbedAsReply', 'channelMessageTyping', 'channelEmbedTyping'] as const
  for (const key of optionalStrings) if (key in source) command[key] = string(source[key], key)
  for (const key of optionalBooleans) if (key in source) command[key] = boolean(source[key], key)
  if ('cooldown' in source) command.cooldown = number(source.cooldown, 'cooldown')
  if (channelWhitelist) command.channelWhitelist = channelWhitelist
  if (serverWhitelist) command.serverWhitelist = serverWhitelist

  const droppedFields = Object.keys(source).filter((key) => !canonicalFields.has(key) && !legacyFields.has(key))
  const migrated = Object.keys(source).some((key) => legacyFields.has(key)) || droppedFields.length > 0 || !source.id
  return { command, migrated, droppedFields }
}

export function decodeBCFDCommandArray(value: unknown): CommandDecodeResult[] {
  if (!Array.isArray(value)) throw new Error('Commands JSON must be an array')
  return value.map((item, index) => {
    try {
      return decodeBCFDCommand(item)
    } catch (error) {
      throw new Error(`Command ${index + 1}: ${(error as Error).message}`)
    }
  })
}
