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
  startsWith: boolean
  type: BCFDCommandType
  channelEmbed: BCFDEmbedMessageTemplate
  privateEmbed: BCFDEmbedMessageTemplate
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

export type BCFDSlashCommand = {
  commandName: string
  commandDescription: string
  commandReply: string
}

export type AppSettings = {
  theme: string
  showToken: boolean
  language: string
  openaiApiKey: string
  openaiModel: 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano'
  developerPrompt: string
  useCustomApi: boolean
  useLegacyInterpreter: boolean // Use old string replacement instead of new interpreter
}

export type BotStatus = {
  status: string
  activity: string
  activityDetails: string
  streamUrl: string
}
