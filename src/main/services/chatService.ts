import { app } from 'electron'
import { join } from 'path'
import fs from 'fs/promises'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  pendingChanges?: any | null
}

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
  messages: ChatMessage[]
  contexts: ChatContext[]
  commandId?: string // The command this chat was opened with (if any)
}

export interface ChatsData {
  chats: SavedChat[]
  activeChat: string | null
}

const CHATS_FILENAME = 'chats.json'

// In-memory state
let chatsData: ChatsData = {
  chats: [],
  activeChat: null
}

function getChatsPath(): string {
  return join(app.getPath('userData'), CHATS_FILENAME)
}

export async function loadChats(): Promise<ChatsData> {
  const path = getChatsPath()
  try {
    const data = await fs.readFile(path, 'utf-8')
    chatsData = JSON.parse(data) as ChatsData
    return chatsData
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, create with empty data
      chatsData = { chats: [], activeChat: null }
      await saveChats()
      return chatsData
    }
    console.error('Error loading chats:', error)
    throw error
  }
}

export async function saveChats(): Promise<void> {
  const path = getChatsPath()
  try {
    await fs.writeFile(path, JSON.stringify(chatsData, null, 2))
  } catch (error) {
    console.error('Error saving chats:', error)
    throw error
  }
}

export function getChats(): ChatsData {
  return chatsData
}

export function setChats(data: ChatsData): void {
  chatsData = data
}

export function getChat(chatId: string): SavedChat | undefined {
  return chatsData.chats.find((c) => c.id === chatId)
}

export function createChat(
  title: string,
  commandId?: string,
  initialContexts: ChatContext[] = []
): SavedChat {
  const now = new Date().toISOString()
  const chat: SavedChat = {
    id: `chat_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    title,
    createdAt: now,
    updatedAt: now,
    messages: [],
    contexts: initialContexts,
    commandId
  }
  chatsData.chats.unshift(chat) // Add to beginning
  chatsData.activeChat = chat.id
  return chat
}

export function updateChat(chatId: string, updates: Partial<SavedChat>): SavedChat | null {
  const chatIndex = chatsData.chats.findIndex((c) => c.id === chatId)
  if (chatIndex === -1) return null

  chatsData.chats[chatIndex] = {
    ...chatsData.chats[chatIndex],
    ...updates,
    updatedAt: new Date().toISOString()
  }
  return chatsData.chats[chatIndex]
}

export function deleteChat(chatId: string): boolean {
  const chatIndex = chatsData.chats.findIndex((c) => c.id === chatId)
  if (chatIndex === -1) return false

  chatsData.chats.splice(chatIndex, 1)

  // If we deleted the active chat, clear the active chat
  if (chatsData.activeChat === chatId) {
    chatsData.activeChat = chatsData.chats.length > 0 ? chatsData.chats[0].id : null
  }

  return true
}

export function addMessageToChat(chatId: string, message: ChatMessage): SavedChat | null {
  const chat = getChat(chatId)
  if (!chat) return null

  chat.messages.push(message)
  chat.updatedAt = new Date().toISOString()

  // Update title from first user message if it's still the default
  if (chat.title === 'New Chat' && message.role === 'user') {
    chat.title = message.content.slice(0, 50) + (message.content.length > 50 ? '...' : '')
  }

  return chat
}

export function updateChatContexts(chatId: string, contexts: ChatContext[]): SavedChat | null {
  return updateChat(chatId, { contexts })
}

export function updateMessageInChat(
  chatId: string,
  messageId: string,
  updates: Partial<ChatMessage>
): SavedChat | null {
  const chat = getChat(chatId)
  if (!chat) return null

  const messageIndex = chat.messages.findIndex((m) => m.id === messageId)
  if (messageIndex === -1) return null

  chat.messages[messageIndex] = {
    ...chat.messages[messageIndex],
    ...updates
  }
  chat.updatedAt = new Date().toISOString()

  return chat
}

export function clearChatMessages(chatId: string): SavedChat | null {
  const chat = getChat(chatId)
  if (!chat) return null

  chat.messages = []
  chat.updatedAt = new Date().toISOString()
  return chat
}

export function setActiveChat(chatId: string | null): void {
  chatsData.activeChat = chatId
}

export function getActiveChat(): SavedChat | null {
  if (!chatsData.activeChat) return null
  return getChat(chatsData.activeChat) || null
}

// Get recent chats for history display
export function getRecentChats(limit: number = 20): SavedChat[] {
  return chatsData.chats.slice(0, limit)
}

// Search chats by title or message content
export function searchChats(query: string): SavedChat[] {
  const lowerQuery = query.toLowerCase()
  return chatsData.chats.filter(
    (chat) =>
      chat.title.toLowerCase().includes(lowerQuery) ||
      chat.messages.some(
        (msg) => msg.role !== 'system' && msg.content.toLowerCase().includes(lowerQuery)
      )
  )
}
