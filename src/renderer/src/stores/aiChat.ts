import { writable, get } from 'svelte/store'
import type { BCFDCommand } from '../types/types'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  tokenCount?: number
  pendingChanges?: CommandDiff | null
}

export interface CommandDiff {
  before: BCFDCommand
  after: BCFDCommand
  changes: DiffChange[]
}

export interface DiffChange {
  field: string
  fieldLabel: string
  oldValue: string | boolean | number
  newValue: string | boolean | number
}

export interface AIModel {
  id: string
  name: string
  description: string
  maxTokens?: number
}

export const AI_MODELS: AIModel[] = [
  { id: 'gpt-4.1', name: 'GPT-4.1', description: 'Most capable model', maxTokens: 128000 },
  {
    id: 'gpt-4.1-mini',
    name: 'GPT-4.1 Mini',
    description: 'Balanced performance',
    maxTokens: 128000
  },
  {
    id: 'gpt-4.1-nano',
    name: 'GPT-4.1 Nano',
    description: 'Fast and efficient',
    maxTokens: 128000
  },
  { id: 'gpt-5.1', name: 'GPT-5.1', description: 'Next-gen model' }
]

// Chat state
export const chatMessages = writable<ChatMessage[]>([])
export const isAiLoading = writable<boolean>(false)
export const selectedModel = writable<string>('gpt-4.1-nano')
export const totalTokens = writable<number>(0)
export const aiPanelOpen = writable<boolean>(false)

// Generate unique message ID
function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

// Add a message to the chat
export function addMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  pendingChanges?: CommandDiff | null
): ChatMessage {
  const message: ChatMessage = {
    id: generateId(),
    role,
    content,
    timestamp: new Date(),
    pendingChanges
  }

  chatMessages.update((msgs) => [...msgs, message])
  return message
}

// Clear all messages
export function clearChat(): void {
  chatMessages.set([])
  totalTokens.set(0)
}

// Update a message (e.g., to add token count or remove pending changes)
export function updateMessage(id: string, updates: Partial<ChatMessage>): void {
  chatMessages.update((msgs) => msgs.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg)))
}

// Calculate rough token estimate (4 chars ~= 1 token)
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// Get messages for API call (excluding system context that's added server-side)
export function getMessagesForAPI(): Array<{ role: string; content: string }> {
  return get(chatMessages)
    .filter((msg) => msg.role !== 'system')
    .map((msg) => ({ role: msg.role, content: msg.content }))
}

// Compare two commands and generate a diff
export function generateCommandDiff(before: BCFDCommand, after: BCFDCommand): CommandDiff {
  const changes: DiffChange[] = []

  const fieldLabels: Record<string, string> = {
    command: 'Command',
    commandDescription: 'Description',
    channelMessage: 'Channel Message',
    privateMessage: 'Private Message',
    type: 'Command Type',
    reaction: 'Reaction',
    specificChannel: 'Specific Channel',
    roleToAssign: 'Role to Assign',
    requiredRole: 'Required Role',
    deleteIfStrings: 'Delete If Contains',
    deleteNum: 'Delete Count',
    'channelEmbed.title': 'Embed Title',
    'channelEmbed.description': 'Embed Description',
    'channelEmbed.footer': 'Embed Footer',
    'channelEmbed.hexColor': 'Embed Color',
    'channelEmbed.imageURL': 'Embed Image',
    'channelEmbed.thumbnailURL': 'Embed Thumbnail',
    'privateEmbed.title': 'Private Embed Title',
    'privateEmbed.description': 'Private Embed Description',
    'privateEmbed.footer': 'Private Embed Footer',
    'privateEmbed.hexColor': 'Private Embed Color',
    'privateEmbed.imageURL': 'Private Embed Image',
    'privateEmbed.thumbnailURL': 'Private Embed Thumbnail'
  }

  // Compare simple fields
  const simpleFields = [
    'command',
    'commandDescription',
    'channelMessage',
    'privateMessage',
    'type',
    'reaction',
    'specificChannel',
    'roleToAssign',
    'requiredRole',
    'deleteIfStrings',
    'deleteNum',
    'phrase',
    'startsWith',
    'isNSFW',
    'isAdmin',
    'isReact',
    'isKick',
    'isBan',
    'isVoiceMute',
    'isRoleAssigner',
    'isRequiredRole',
    'deleteAfter',
    'deleteX',
    'deleteIf',
    'isSpecificChannel',
    'sendChannelEmbed',
    'sendPrivateEmbed'
  ]

  for (const field of simpleFields) {
    const beforeVal = (before as any)[field]
    const afterVal = (after as any)[field]
    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      changes.push({
        field,
        fieldLabel: fieldLabels[field] || field,
        oldValue: beforeVal,
        newValue: afterVal
      })
    }
  }

  // Compare actionArr
  if (JSON.stringify(before.actionArr) !== JSON.stringify(after.actionArr)) {
    changes.push({
      field: 'actionArr',
      fieldLabel: 'Actions',
      oldValue: JSON.stringify(before.actionArr),
      newValue: JSON.stringify(after.actionArr)
    })
  }

  // Compare embed fields
  const embedTypes = ['channelEmbed', 'privateEmbed'] as const
  const embedFields = ['title', 'description', 'footer', 'hexColor', 'imageURL', 'thumbnailURL']

  for (const embedType of embedTypes) {
    for (const field of embedFields) {
      const beforeVal = (before[embedType] as any)[field]
      const afterVal = (after[embedType] as any)[field]
      if (beforeVal !== afterVal) {
        const fullField = `${embedType}.${field}`
        changes.push({
          field: fullField,
          fieldLabel: fieldLabels[fullField] || fullField,
          oldValue: beforeVal,
          newValue: afterVal
        })
      }
    }
  }

  return { before, after, changes }
}
