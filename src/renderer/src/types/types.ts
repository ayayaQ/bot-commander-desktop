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

    // id is optional (added at runtime, stripped on export)
    const allowedFields = [...requiredFields, 'id']

    // Check if all required fields exist
    const hasAllFields = requiredFields.every((field) => field in parsed)

    // Check if there are no extra fields (allowing optional id field)
    const hasNoExtraFields = Object.keys(parsed).every((key) => allowedFields.includes(key))

    // Validate embed templates
    const embedFields = ['title', 'description', 'hexColor', 'imageURL', 'thumbnailURL', 'footer']
    const hasValidEmbeds = embedFields.every(
      (field) => field in parsed.channelEmbed && field in parsed.privateEmbed
    )

    if (hasAllFields && hasNoExtraFields && hasValidEmbeds) {
      // Add id if missing
      if (!parsed.id) {
        parsed.id = crypto.randomUUID()
      }
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
}

// Factory function to create default interaction action
export function createDefaultInteractionAction(): BCFDInteractionAction {
  return {
    sendChannelMessage: false,
    channelMessage: '',
    sendPrivateMessage: false,
    privateMessage: '',
    sendChannelEmbed: false,
    channelEmbed: {
      title: '',
      description: '',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    },
    sendPrivateEmbed: false,
    privateEmbed: {
      title: '',
      description: '',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    },
    isRoleAssigner: false,
    roleToAssign: '',
    ephemeral: false,
    deferReply: false,
    buttons: []
  }
}

// Factory function to create default interaction command
export function createDefaultInteractionCommand(): BCFDInteractionCommand {
  return {
    id: crypto.randomUUID(),
    commandName: '',
    commandDescription: '',
    options: [],
    rootAction: createDefaultInteractionAction(),
    isRegistered: false
  }
}

// Factory function to create default button
export function createDefaultInteractionButton(): BCFDInteractionButton {
  return {
    customId: crypto.randomUUID(),
    label: '',
    style: 1, // Primary
    disabled: false,
    action: createDefaultInteractionAction()
  }
}

export type AppSettings = {
  theme: string
  showToken: boolean
  hideOutput: boolean
  language: string
  openaiApiKey: string
  openaiModel: 'gpt-4.1' | 'gpt-4.1-mini' | 'gpt-4.1-nano'
  developerPrompt: string
  useCustomApi: boolean
  useLegacyInterpreter: boolean
  disableReasoningApi: boolean
}

export type BotStatus = {
  status: string
  activity: string
  activityDetails: string
  streamUrl: string
}

// AI Chat Context Types
export interface ChatContext {
  type: 'command' | 'startup-js' | 'bot-state' | 'all-commands'
  id?: string // For command context, the command identifier
  label: string
  content?: string // The actual content to include
}

export interface SavedChat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ChatMessageData[]
  contexts: ChatContext[]
  commandId?: string // The command this chat was opened with (if any)
}

export interface ChatMessageData {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  pendingChanges?: any | null
  thinkingContent?: string
}

export interface ChatsData {
  chats: SavedChat[]
  activeChat: string | null
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
