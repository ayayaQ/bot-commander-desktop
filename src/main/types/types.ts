export type BCFDCommand = {
  id: string
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
  cooldown?: number // Cooldown duration in seconds
  cooldownType?: string // "User", "Server", or "Global"
  cooldownMessage?: string // Custom BCFD template message when on cooldown
  channelMessageAsReply?: boolean // Send channel message as a reply to the triggering message
  channelEmbedAsReply?: boolean // Send channel embed as a reply to the triggering message
  channelWhitelist?: string // Comma-separated channel IDs; command only runs in these channels
  serverWhitelist?: string // Comma-separated guild IDs; command only runs in these servers
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

// =============================================================================
// Interaction Command Types (Slash Commands with Buttons)
// =============================================================================

// Button styles (mirrors discord.js ButtonStyle)
export type BCFDButtonStyle = 1 | 2 | 3 | 4 | 5 // Primary, Secondary, Success, Danger, Link

// Forward declaration for recursive type
export type BCFDInteractionButton = {
  customId: string
  label: string
  style: BCFDButtonStyle
  emoji?: string
  url?: string // Only for Link style
  disabled: boolean
  action: BCFDInteractionAction
}

// Reusable action definition for slash commands and buttons
export type BCFDInteractionAction = {
  sendChannelMessage: boolean
  channelMessage: string
  sendPrivateMessage: boolean
  privateMessage: string
  sendChannelEmbed: boolean
  channelEmbed: BCFDEmbedMessageTemplate
  sendPrivateEmbed: boolean
  privateEmbed: BCFDEmbedMessageTemplate
  isRoleAssigner: boolean
  roleToAssign: string
  ephemeral: boolean // Response only visible to user
  deferReply: boolean // For long-running actions
  buttons: BCFDInteractionButton[] // Nested buttons for this action's response
}

// BCFDInteractionButton is defined above with BCFDInteractionAction for recursive typing

// Slash command option types (mirrors discord.js ApplicationCommandOptionType)
export type BCFDSlashCommandOptionType = 3 | 4 | 5 | 6 | 7 | 8 | 10 // String, Integer, Boolean, User, Channel, Role, Number

// Slash command option
export type BCFDSlashCommandOption = {
  name: string
  description: string
  type: BCFDSlashCommandOptionType
  required: boolean
  choices?: { name: string; value: string | number }[]
}

// Main interaction command type
export type BCFDInteractionCommand = {
  id: string
  commandName: string
  commandDescription: string
  options: BCFDSlashCommandOption[]
  rootAction: BCFDInteractionAction
  isRegistered: boolean
  guildId?: string
  cooldown?: number
  cooldownType?: string
  cooldownMessage?: string
}

export type AppSettings = {
  theme: string
  showToken: boolean
  hideOutput: boolean
  language: string
  aiProvider?: 'openai' | 'openrouter'
  openaiApiKey: string
  openrouterApiKey?: string
  selectedAiModel?: string
  selectedOpenAiModel?: string
  selectedOpenRouterModel?: string
  selectedCommandOpenAiModel?: string
  selectedCommandOpenRouterModel?: string
  aiReasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  openaiModel: string
  developerPrompt: string
  useCustomApi: boolean
  useLegacyInterpreter: boolean // Use old string replacement instead of new interpreter
  disableReasoningApi: boolean // Disable streaming reasoning API for thinking models
}

export type BotStatus = {
  status: string
  activity: string
  activityDetails: string
  streamUrl: string
}
export interface WebhookPreset {
  id: string
  alias: string
  webhookUrl: string
  name: string
  avatarUrl: string
  messageType: 'message' | 'embed'
  message: string
  embedTitle?: string
  embedDescription?: string
  embedColor?: string
  embedFooter?: string
  embedImageUrl?: string
  embedThumbnailUrl?: string
}

export interface OnboardingState {
  stepperDismissed: boolean
  botHostedOnce: boolean
  dismissedTips: string[]
}
