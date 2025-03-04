export type BCFDCommand = {
  actionArr: boolean[]
  channelMessage: string
  command: string
  commandDescription: string
  deleteAfter: boolean
  deleteIf: boolean
  deleteIfStrings: string
  deleteNum: number
  deleteX: boolean
  ignoreErrorMessage: boolean
  isBan: boolean
  isKick: boolean
  isNSFW: boolean
  isReact: boolean
  isRequiredRole: boolean
  requiredRole: string
  isRoleAssigner: boolean
  isSpecificChannel: boolean
  isSpecificMessage: boolean
  isVoiceMute: boolean
  isAdmin: boolean
  phrase: boolean
  privateMessage: string
  reaction: string
  roleToAssign: string
  sendChannelEmbed: boolean
  sendPrivateEmbed: boolean
  specificChannel: string
  specificMessage: string
  type: BCFDCommandType
  channelEmbed: BCFDEmbedMessageTemplate
  privateEmbed: BCFDEmbedMessageTemplate
}

export function validateBCFDCommand(jsonString: string): BCFDCommand | null {
  try {
    const parsed = JSON.parse(jsonString)

    const requiredFields = [
      'actionArr',
      'channelMessage',
      'command',
      'commandDescription',
      'deleteAfter',
      'deleteIf',
      'deleteIfStrings',
      'deleteNum',
      'deleteX',
      'ignoreErrorMessage',
      'isBan',
      'isKick',
      'isNSFW',
      'isReact',
      'isRequiredRole',
      'requiredRole',
      'isRoleAssigner',
      'isSpecificChannel',
      'isSpecificMessage',
      'isVoiceMute',
      'isAdmin',
      'phrase',
      'privateMessage',
      'reaction',
      'roleToAssign',
      'sendChannelEmbed',
      'sendPrivateEmbed',
      'specificChannel',
      'specificMessage',
      'type',
      'channelEmbed',
      'privateEmbed'
    ]

    // Check if all required fields exist
    const hasAllFields = requiredFields.every((field) => field in parsed)

    // Check if there are no extra fields
    const hasNoExtraFields = Object.keys(parsed).every((key) => requiredFields.includes(key))

    // Validate embed templates
    const embedFields = ['title', 'description', 'hexColor', 'imageURL', 'thumbnailURL', 'footer']
    const hasValidEmbeds = embedFields.every(
      (field) => field in parsed.channelEmbed && field in parsed.privateEmbed
    )

    if (hasAllFields && hasNoExtraFields && hasValidEmbeds) {
      return parsed as BCFDCommand
    }

    return null
  } catch (error) {
    return null
  }
}

export type BCFDEmbedMessageTemplate = {
  title: string
  description: string
  hexColor: string
  imageURL: string
  thumbnailURL: string
  footer: string
}

export type BCFDCommandType =
  | TYPE_MESSAGE_RECEIVED
  | TYPE_PM_RECEIVED
  | TYPE_MEMBER_JOIN
  | TYPE_MEMBER_LEAVE
  | TYPE_MEMBER_BAN
  | TYPE_MEMBER_ADD
export type TYPE_MESSAGE_RECEIVED = 0
export type TYPE_PM_RECEIVED = 1
export type TYPE_MEMBER_JOIN = 2
export type TYPE_MEMBER_LEAVE = 3
export type TYPE_MEMBER_BAN = 4
export type TYPE_MEMBER_ADD = 5

export type AppSettings = {
  theme: string
  showToken: boolean
  language: string
  openaiApiKey: string
  openaiModel: 'gpt-4o' | 'gpt-4o-mini'
}

export type BotStatus = {
  status: string
  activity: string
  activityDetails: string
  streamUrl: string
}
