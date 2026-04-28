import { writable, get, derived } from 'svelte/store'
import type {
  BCFDCommand,
  ChatContext,
  SavedChat,
  ChatMessageData,
  ChatsData
} from '../types/types'
import { consoleStore } from './console'
import {
  applyCommandPatch,
  generateCommandDiff,
  type CommandDiff,
  type CommandPatchChange,
  type DiffChange
} from '../../../shared/commandPatch'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: Date
  tokenCount?: number
  pendingChanges?: CommandDiff | null
  thinkingContent?: string
}

export type { CommandDiff, CommandPatchChange, DiffChange }

export interface AIModel {
  id: string
  name: string
  description: string
  maxTokens?: number
  reasoning?: boolean // For thinking models: whether reasoning is enabled
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
  {
    id: 'gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    description: 'Default fast model'
  },
  { id: 'gpt-5.1', name: 'GPT-5.1', description: 'Next-gen model' },
  { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Latest model' }
]

// Parse a model selection ID to get the actual model ID and reasoning preference
export function parseModelSelection(selectionId: string): {
  modelId: string
  useReasoning: boolean
} {
  if (selectionId.endsWith(':reasoning')) {
    return { modelId: selectionId.replace(':reasoning', ''), useReasoning: true }
  }
  if (selectionId.endsWith(':fast')) {
    return { modelId: selectionId.replace(':fast', ''), useReasoning: false }
  }
  // Default: check if it's a thinking model
  const isThinking = THINKING_MODELS.some((m) => selectionId.startsWith(m))
  return { modelId: selectionId, useReasoning: isThinking }
}

// Chat state
export const chatMessages = writable<ChatMessage[]>([])
export const isAiLoading = writable<boolean>(false)
export const selectedModel = writable<string>('gpt-5.4-nano')
export const selectedReasoningEffort = writable<
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
>('none')
export const totalTokens = writable<number>(0)
export const aiPanelOpen = writable<boolean>(false)

// Persistence state
export const allChats = writable<SavedChat[]>([])
export const activeChatId = writable<string | null>(null)

// Context state
export const selectedContexts = writable<ChatContext[]>([])
export const contextPickerOpen = writable<boolean>(false)

// Thinking state (for streaming reasoning tokens from thinking models)
export const thinkingContent = writable<string>('')
export const isThinking = writable<boolean>(false)
export const thinkingExpanded = writable<boolean>(true)

// Derived store for active chat
export const activeChat = derived(
  [allChats, activeChatId],
  ([$allChats, $activeChatId]) => $allChats.find((c) => c.id === $activeChatId) || null
)

// Generate unique message ID
function generateId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

// Convert ChatMessage to ChatMessageData for storage
function messageToData(msg: ChatMessage): ChatMessageData {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    timestamp: msg.timestamp.toISOString(),
    pendingChanges: msg.pendingChanges,
    thinkingContent: msg.thinkingContent
  }
}

// Convert ChatMessageData to ChatMessage
function dataToMessage(data: ChatMessageData): ChatMessage {
  return {
    id: data.id,
    role: data.role,
    content: data.content,
    timestamp: new Date(data.timestamp),
    pendingChanges: data.pendingChanges,
    thinkingContent: data.thinkingContent
  }
}

// Initialize from stored chats
export async function initializeChats(): Promise<void> {
  try {
    const data: ChatsData = await window.electron.ipcRenderer.invoke('get-chats')
    allChats.set(data.chats || [])
    activeChatId.set(data.activeChat)

    // Load active chat messages if there's an active chat
    if (data.activeChat) {
      const chat = data.chats.find((c) => c.id === data.activeChat)
      if (chat) {
        chatMessages.set(chat.messages.map(dataToMessage))
        selectedContexts.set(chat.contexts || [])
      }
    }
  } catch (error) {
    console.error('Failed to initialize chats:', error)
  }
}

// Create a new chat
export async function createNewChat(
  title: string = 'New Chat',
  commandId?: string,
  initialContexts: ChatContext[] = []
): Promise<SavedChat | null> {
  try {
    const chat: SavedChat = await window.electron.ipcRenderer.invoke('create-chat', {
      title,
      commandId,
      contexts: initialContexts
    })

    allChats.update((chats) => [chat, ...chats])
    activeChatId.set(chat.id)
    chatMessages.set([])
    selectedContexts.set(initialContexts)
    totalTokens.set(0)

    return chat
  } catch (error) {
    console.error('Failed to create chat:', error)
    return null
  }
}

// Load or create the single chat for a command
export async function loadOrCreateChatForCommand(
  commandId: string,
  commandLabel: string,
  commandContext: ChatContext
): Promise<SavedChat | null> {
  try {
    // First, check if a chat exists for this command
    const chats = get(allChats)
    const existingChat = chats.find((c) => c.commandId === commandId)

    if (existingChat) {
      // Load the existing chat
      await loadChat(existingChat.id)
      // Ensure the command context is always present and updated
      const contexts = get(selectedContexts)
      const hasCommandContext = contexts.some((c) => c.type === 'command' && c.id === commandId)
      if (!hasCommandContext) {
        // Add the command context at the beginning
        selectedContexts.update((ctxs) => [
          commandContext,
          ...ctxs.filter((c) => c.id !== commandId)
        ])
        await persistContexts()
      } else {
        // Update the command context content (in case command was edited)
        selectedContexts.update((ctxs) =>
          ctxs.map((c) => (c.type === 'command' && c.id === commandId ? commandContext : c))
        )
        await persistContexts()
      }
      return existingChat
    } else {
      // Create a new chat for this command
      return await createNewChat(commandLabel, commandId, [commandContext])
    }
  } catch (error) {
    console.error('Failed to load or create chat for command:', error)
    return null
  }
}

// Clear all messages from the current chat (but keep the chat itself)
export async function clearChatMessages(): Promise<void> {
  const currentChatId = get(activeChatId)
  if (!currentChatId) return

  try {
    await window.electron.ipcRenderer.invoke('clear-chat-messages', currentChatId)
    chatMessages.set([])
    totalTokens.set(0)

    // Update the chat in allChats to reflect empty messages
    allChats.update((chats) =>
      chats.map((c) =>
        c.id === currentChatId ? { ...c, messages: [], updatedAt: new Date().toISOString() } : c
      )
    )
  } catch (error) {
    console.error('Failed to clear chat messages:', error)
  }
}

// Load a chat by ID
export async function loadChat(chatId: string): Promise<void> {
  try {
    const chat: SavedChat | null = await window.electron.ipcRenderer.invoke('get-chat', chatId)
    if (chat) {
      activeChatId.set(chat.id)
      chatMessages.set(chat.messages.map(dataToMessage))
      selectedContexts.set(chat.contexts || [])

      console.log(`Loaded chat: ${chat.title} (${chat.id})`)
      console.log(JSON.stringify(chat, null, 2))

      // Update active chat on backend
      await window.electron.ipcRenderer.invoke('set-active-chat', chatId)
    }
  } catch (error) {
    console.error('Failed to load chat:', error)
  }
}

// Delete a chat
export async function deleteStoredChat(chatId: string): Promise<boolean> {
  try {
    const result = await window.electron.ipcRenderer.invoke('delete-chat', chatId)
    if (result) {
      allChats.update((chats) => chats.filter((c) => c.id !== chatId))

      // If we deleted the active chat, clear the UI
      if (get(activeChatId) === chatId) {
        activeChatId.set(null)
        chatMessages.set([])
        selectedContexts.set([])
        totalTokens.set(0)
      }
    }
    return result
  } catch (error) {
    console.error('Failed to delete chat:', error)
    return false
  }
}

// Add a message to the chat (and persist)
export async function addMessage(
  role: 'user' | 'assistant' | 'system',
  content: string,
  pendingChanges?: CommandDiff | null,
  thinkingContent?: string
): Promise<ChatMessage> {
  const message: ChatMessage = {
    id: generateId(),
    role,
    content,
    timestamp: new Date(),
    pendingChanges,
    thinkingContent
  }

  chatMessages.update((msgs) => [...msgs, message])

  // Persist to backend if there's an active chat
  const currentChatId = get(activeChatId)
  if (currentChatId) {
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'add-message-to-chat',
        currentChatId,
        messageToData(message)
      )

      // Update the chat in allChats
      if (result) {
        allChats.update((chats) => chats.map((c) => (c.id === currentChatId ? result : c)))
      }
    } catch (error) {
      console.error('Failed to persist message:', error)
    }
  }

  return message
}

// Clear all messages (for current session, not persisted)
export function clearChat(): void {
  chatMessages.set([])
  totalTokens.set(0)
  activeChatId.set(null)
  selectedContexts.set([])
}

// Update a message (e.g., to add token count or remove pending changes)
export async function updateMessage(id: string, updates: Partial<ChatMessage>): Promise<void> {
  chatMessages.update((msgs) => msgs.map((msg) => (msg.id === id ? { ...msg, ...updates } : msg)))

  // Persist to backend if there's an active chat
  const currentChatId = get(activeChatId)
  if (currentChatId) {
    try {
      // Convert updates to serializable format
      const serializedUpdates: Partial<ChatMessageData> = {}
      if ('pendingChanges' in updates) {
        serializedUpdates.pendingChanges = updates.pendingChanges
      }
      if ('content' in updates) {
        serializedUpdates.content = updates.content
      }

      await window.electron.ipcRenderer.invoke(
        'update-message-in-chat',
        currentChatId,
        id,
        serializedUpdates
      )
    } catch (error) {
      console.error('Failed to persist message update:', error)
    }
  }
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

// Context management functions
export function addContext(context: ChatContext): void {
  selectedContexts.update((contexts) => {
    // Prevent duplicates
    if (contexts.some((c) => c.type === context.type && c.id === context.id)) {
      return contexts
    }
    return [...contexts, context]
  })

  // Persist contexts
  persistContexts()
}

export function removeContext(context: ChatContext): void {
  selectedContexts.update((contexts) =>
    contexts.filter((c) => !(c.type === context.type && c.id === context.id))
  )

  // Persist contexts
  persistContexts()
}

export function clearContexts(): void {
  selectedContexts.set([])
  persistContexts()
}

async function persistContexts(): Promise<void> {
  const currentChatId = get(activeChatId)
  if (currentChatId) {
    try {
      await window.electron.ipcRenderer.invoke(
        'update-chat-contexts',
        currentChatId,
        get(selectedContexts)
      )
    } catch (error) {
      console.error('Failed to persist contexts:', error)
    }
  }
}

// Build context string for AI from selected contexts
export async function buildContextString(): Promise<string> {
  const contexts = get(selectedContexts)
  if (contexts.length === 0) return ''

  const contextParts: string[] = []

  for (const ctx of contexts) {
    switch (ctx.type) {
      case 'startup-js':
        try {
          const startupJs = await window.electron.ipcRenderer.invoke('get-startup-js')
          if (startupJs) {
            contextParts.push(`=== Startup JavaScript ===\n${startupJs}`)
          }
        } catch (error) {
          console.error('Failed to load startup JS:', error)
        }
        break

      case 'bot-state':
        try {
          const botState = await window.electron.ipcRenderer.invoke('getBotState')
          if (botState) {
            contextParts.push(`=== Bot State ===\n${JSON.stringify(botState, null, 2)}`)
          }
        } catch (error) {
          console.error('Failed to load bot state:', error)
        }
        break

      case 'all-commands':
        try {
          const commands = await window.electron.ipcRenderer.invoke('get-commands')
          if (commands?.bcfdCommands) {
            contextParts.push(
              `=== All Commands ===\n${JSON.stringify(commands.bcfdCommands, null, 2)}`
            )
          }
        } catch (error) {
          console.error('Failed to load commands:', error)
        }
        break

      case 'command':
        if (ctx.content) {
          contextParts.push(`=== Command: ${ctx.label} ===\n${ctx.content}`)
        }
        break
    }
  }

  return contextParts.join('\n\n')
}

// Get recent chats for the history panel
export async function fetchRecentChats(limit: number = 20): Promise<SavedChat[]> {
  try {
    const chats = await window.electron.ipcRenderer.invoke('get-recent-chats', limit)
    allChats.set(chats)
    return chats
  } catch (error) {
    console.error('Failed to fetch recent chats:', error)
    return []
  }
}

// Search chats
export async function searchStoredChats(query: string): Promise<SavedChat[]> {
  try {
    return await window.electron.ipcRenderer.invoke('search-chats', query)
  } catch (error) {
    console.error('Failed to search chats:', error)
    return []
  }
}

export { applyCommandPatch, generateCommandDiff }

// Thinking models that support reasoning tokens
const THINKING_MODELS = ['gpt-5.1', 'gpt-5.2']

export function isThinkingModel(modelId: string): boolean {
  return THINKING_MODELS.some((m) => modelId.startsWith(m))
}

// Streaming response type from thinking models
export interface StreamingDoneResponse {
  requestId?: string
  thinkingContent: string
  explanation: string
  hasChanges: boolean
  changes?: CommandPatchChange[]
  updatedCommand?: BCFDCommand | null
  tokenCount: number
  warnings?: string[]
}

// Initialize IPC listeners for streaming AI chat responses
// Call this once when the AIChat component mounts
export function initAiChatStreamListeners(
  onDone: (response: StreamingDoneResponse, pendingChanges: CommandDiff | null) => void,
  getCurrentCommand: () => any,
  getActiveRequestId: () => string | null = () => null
) {
  const electron = window.electron

  if (!electron?.ipcRenderer) {
    console.warn('IPC renderer not available for AI chat streaming')
    return () => {}
  }

  function shouldIgnoreEvent(requestId?: string): boolean {
    const activeRequestId = getActiveRequestId()

    // All current AI chat requests include a request id. If this listener belongs
    // to an old component instance, it will have no active id and must ignore it.
    if (requestId) return activeRequestId !== requestId

    return false
  }

  // Handler for thinking token deltas
  const thinkingHandler = (
    _event: any,
    data: { requestId?: string; delta: string; accumulated: string }
  ) => {
    if (shouldIgnoreEvent(data.requestId)) return
    console.log('[aiChat] thinkingHandler received:', data)
    isThinking.set(true)
    thinkingContent.set(data.accumulated)
  }

  // Handler for completed response
  const doneHandler = (_event: any, response: StreamingDoneResponse) => {
    if (shouldIgnoreEvent(response.requestId)) return
    console.log('[aiChat] doneHandler received:', response)
    isThinking.set(false)
    thinkingExpanded.set(false) // Auto-collapse when complete

    // Generate pending changes if the AI proposed updates
    let pendingChanges: CommandDiff | null = null
    if (response.hasChanges && response.changes?.length) {
      const currentCommand = getCurrentCommand()
      const result = applyCommandPatch(currentCommand, response.changes)
      pendingChanges = result.diff
      response.warnings = result.warnings
    } else if (response.hasChanges && response.updatedCommand) {
      const currentCommand = getCurrentCommand()
      pendingChanges = generateCommandDiff(currentCommand, response.updatedCommand)
    }

    onDone(response, pendingChanges)

    // Clear streaming state
    thinkingContent.set('')
  }

  // Handler for errors
  const errorHandler = (_event: any, data: { requestId?: string; error: string }) => {
    if (shouldIgnoreEvent(data.requestId)) return
    console.log('[aiChat] errorHandler received:', data)
    isThinking.set(false)
    thinkingContent.set('')
    thinkingExpanded.set(false)
    isAiLoading.set(false)
    consoleStore.error('AI chat streaming error:' + data.error)
    addMessage('assistant', `Error: ${data.error}`)
  }

  // Register listeners
  console.log(
    '[aiChat] Registering IPC listeners for ai-chat:thinking, ai-chat:done, ai-chat:error'
  )
  electron.ipcRenderer.on('ai-chat:thinking', thinkingHandler)
  electron.ipcRenderer.on('ai-chat:done', doneHandler)
  electron.ipcRenderer.on('ai-chat:error', errorHandler)
  console.log('[aiChat] IPC listeners registered')

  // Return cleanup function
  return () => {
    electron.ipcRenderer.removeListener('ai-chat:thinking', thinkingHandler)
    electron.ipcRenderer.removeListener('ai-chat:done', doneHandler)
    electron.ipcRenderer.removeListener('ai-chat:error', errorHandler)
  }
}
