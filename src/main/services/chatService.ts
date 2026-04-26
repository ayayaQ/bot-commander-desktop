import { app } from 'electron'
import { join } from 'path'
import fs from 'fs/promises'
import OpenAI from 'openai'
import type { BCFDCommand } from '../types/types'

// Thinking models that support reasoning tokens
const THINKING_MODELS = ['gpt-5.1', 'gpt-5.2']

export function isThinkingModel(modelId: string): boolean {
  return THINKING_MODELS.some((m) => modelId.startsWith(m))
}

// Parse model selection ID (e.g., "gpt-5.1:reasoning" or "gpt-5.1:fast")
export function parseModelSelection(selectionId: string): { modelId: string; useReasoning: boolean } {
  if (selectionId.endsWith(':reasoning')) {
    return { modelId: selectionId.replace(':reasoning', ''), useReasoning: true }
  }
  if (selectionId.endsWith(':fast')) {
    return { modelId: selectionId.replace(':fast', ''), useReasoning: false }
  }
  // Default: check if it's a thinking model (backwards compatibility)
  const isThinking = isThinkingModel(selectionId)
  return { modelId: selectionId, useReasoning: isThinking }
}

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

// ============================================================================
// AI Command Chat
// ============================================================================

 // BCFD Language system prompt
  const BCFD_SYSTEM_PROMPT = `You are an expert Discord bot command editor. You help users create and modify commands using the BCFD Template Language.

## BCFD Template Language Overview:

### Variables (prefix with $):
- User: $name (mention), $namePlain, $avatar, $id, $tag, $discriminator
- Bot: $botName, $botNamePlain, $ping, $serverCount, $botAvatar
- Server: $server, $memberCount, $serverIcon, $serverDescription
- Channel: $channel, $channelID, $channelAsMention
- Message: $message, $messageAfterCommand, $args(index), $argsCount
- Mentioned: $mentionedName, $mentionedID, $mentionedNamePlain

### Functions:
- $random{opt1|opt2|opt3} - Random selection from pipe-separated options
- $rollnum(min, max) - Random integer in range (inclusive)
- $sum(n1, n2, ...) - Sum of numbers
- $args(index) - Get argument at position (0-based)
- $argsCount - Total number of arguments
- $chat(prompt) - AI response (requires API key)
- $date, $hours, $minutes, $seconds - Date/time values

### Variable Storage Functions:
**$set(name, value)** and **$get(name)** work with the global JavaScript context:
- $set(choice, $message) - Stores the message content in the JS context variable "choice"
- Inside JavaScript: Access as \`choice\` (NO $ prefix) - e.g., \`return choice;\`
- These are for JavaScript context storage ONLY
- You CANNOT use $choice in template strings - use $get(choice) instead
- Example flow:
  1. $set(userInput, $messageAfterCommand) - Store user's message
  2. Inside $eval block: \`let input = userInput;\` - Access in JS
  3. In template: $get(userInput) - Retrieve for display

### JavaScript Evaluation (Advanced):
JavaScript code blocks execute in a sandboxed VM with persistent state:

\`\`\`
$eval
  // botState is a persistent object across all command executions
  botState.counter = (botState.counter || 0) + 1;
  botState.lastUser = $namePlain; // <- Note: $ variables evaluated BEFORE JS runs as strings!
  
  // You can use stored values (from $set)
  // e.g., if you did $set(savedMsg, $message), access as: savedMsg
  
  // Use return to output text
  return "Count: " + botState.counter + " by " + botState.lastUser;
$halt
\`\`\`

**Key JavaScript Rules:**
1. **ALL $ variables are evaluated BEFORE JavaScript execution**
   - Write: \`let name = $namePlain;\` NOT \`let name = "$namePlain";\`
   - The $ variables become their values as strings before JS sees the code
2. **botState object persists** across all command executions (saved to disk)
3. **$set variables accessed without $** - If $set(foo, bar), use \`foo\` in JS
4. **Must use return** to output text, otherwise block returns empty string
5. **Available globals**: Math, Date, JSON, String, Number, Array, Object
6. **Blocked for security**: require, process, fs, child_process
7. **Timeout**: 2 seconds max execution time

**Evaluation Order Example:**
\`\`\`
Message: "$name said: $messageAfterCommand"
$eval
  let user = $namePlain; // $namePlain replaced BEFORE JS runs
  return user.toUpperCase();
$halt
\`\`\`
If user is "John" and typed "hello":
1. $name -> "<@123>" (mention)
2. $messageAfterCommand -> "hello"
3. $namePlain -> "John"
4. JS sees: \`let user = "John"; return user.toUpperCase();\`
5. Output: "<@123> said: hello JOHN"

## Command Types:
- 0: Message received in server
- 1: PM received
- 2: Member join
- 3: Member leave
- 4: Member ban
- 5: Reaction add

## Your Role:
You respond in a structured format with:
1. **explanation**: A brief, friendly explanation of what you'll change or why something works a certain way
2. **hasChanges**: true if you're proposing command modifications, false if just answering questions
3. **updatedCommand**: The complete modified command object (only when hasChanges is true)

When making changes:
- Always provide the FULL command object with ALL fields
- Explain the changes clearly in the explanation field
- Use BCFD language features creatively (variables, functions, $eval blocks)
- Keep explanations concise but informative
- The startsWith fields should be enabled if we are using $args or $messageAfterCommand
- The phrase field should be enabled if the command can appear anywhere in the message
- Neither startsWith nor phrase should be enabled for commands triggered by just the command name with no extra text

When answering questions without changes:
- Set hasChanges to false
- Provide helpful explanations about BCFD language features
- Give examples when appropriate`

// Structured output schema for command updates
const COMMAND_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    explanation: {
      type: 'string',
      description: 'A brief explanation of the changes being made'
    },
    hasChanges: {
      type: 'boolean',
      description: 'Whether any changes are being proposed to the command'
    },
    updatedCommand: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            command: { type: 'string' },
            commandDescription: { type: 'string' },
            type: { type: 'number' },
            channelMessage: { type: 'string' },
            privateMessage: { type: 'string' },
            channelEmbed: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                hexColor: { type: 'string' },
                imageURL: { type: 'string' },
                thumbnailURL: { type: 'string' },
                footer: { type: 'string' }
              },
              required: [
                'title',
                'description',
                'hexColor',
                'imageURL',
                'thumbnailURL',
                'footer'
              ],
              additionalProperties: false
            },
            privateEmbed: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                description: { type: 'string' },
                hexColor: { type: 'string' },
                imageURL: { type: 'string' },
                thumbnailURL: { type: 'string' },
                footer: { type: 'string' }
              },
              required: [
                'title',
                'description',
                'hexColor',
                'imageURL',
                'thumbnailURL',
                'footer'
              ],
              additionalProperties: false
            },
            specificChannel: { type: 'string' },
            channelWhitelist: { type: 'string' },
            serverWhitelist: { type: 'string' },
            reaction: { type: 'string' },
            deleteIfStrings: { type: 'string' },
            deleteAfter: { type: 'boolean' },
            deleteNum: { type: 'number' },
            roleToAssign: { type: 'string' },
            isKick: { type: 'boolean' },
            isBan: { type: 'boolean' },
            isVoiceMute: { type: 'boolean' },
            requiredRole: { type: 'string' },
            isAdmin: { type: 'boolean' },
            phrase: { type: 'boolean' },
            startsWith: { type: 'boolean' },
            isNSFW: { type: 'boolean' },
            specificMessage: { type: 'string' },
            ignoreErrorMessage: { type: 'boolean' }
          },
          required: [
            'command',
            'commandDescription',
            'type',
            'channelMessage',
            'privateMessage',
            'channelEmbed',
            'privateEmbed',
            'specificChannel',
            'reaction',
            'deleteIfStrings',
            'deleteAfter',
            'deleteNum',
            'roleToAssign',
            'isKick',
            'isBan',
            'isVoiceMute',
            'requiredRole',
            'isAdmin',
            'phrase',
            'startsWith',
            'isNSFW',
            'specificMessage',
            'ignoreErrorMessage'
          ],
          additionalProperties: false
        }
      ],
      description:
        'The updated command object with changes applied (null when hasChanges is false)'
    }
  },
  required: ['explanation', 'hasChanges', 'updatedCommand'],
  additionalProperties: false
} as const

export interface AiCommandChatPayload {
  messages: Array<{ role: string; content: string }>
  currentCommand: BCFDCommand
  model: string
  additionalContext?: string
}

export interface AiCommandChatSettings {
  openaiApiKey: string
  openaiModel?: string
  disableReasoningApi?: boolean
}

export interface AiChatStreamCallbacks {
  onThinking: (delta: string, accumulated: string) => void
  onDone: (result: {
    thinkingContent: string
    explanation: string
    hasChanges: boolean
    updatedCommand: BCFDCommand | null
    tokenCount: number
  }) => void
  onError: (error: string) => void
}

export async function executeAiCommandChat(
  payload: AiCommandChatPayload,
  settings: AiCommandChatSettings,
  callbacks: AiChatStreamCallbacks
): Promise<void> {
  const selection = parseModelSelection(payload.model || settings.openaiModel || 'gpt-4.1-nano')
  const modelId = selection.modelId
  // Use reasoning if model selection requests it, unless globally disabled
  const useReasoning = selection.useReasoning && !settings.disableReasoningApi

  console.log('[AI-Chat] Model:', modelId, '| Reasoning:', useReasoning)

  const openai = new OpenAI({ apiKey: settings.openaiApiKey })

  // Build system content
  let systemContent = BCFD_SYSTEM_PROMPT
  systemContent += `\n\nCurrent command state:\n${JSON.stringify(payload.currentCommand, null, 2)}`

  if (payload.additionalContext) {
    systemContent += `\n\nAdditional context:\n${payload.additionalContext}`
  }

  // Build conversation messages
  const inputMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
    { role: 'system', content: systemContent }
  ]

  for (const msg of payload.messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      inputMessages.push({
        role: msg.role as 'user' | 'assistant',
        content: msg.content
      })
    }
  }

  let thinkingContent = ''
  let outputContent = ''

  const stream = await openai.responses.create({
    model: modelId,
    input: inputMessages,
    stream: true,
    text: {
      format: {
        type: 'json_schema',
        name: 'command_update_response',
        strict: true,
        schema: COMMAND_RESPONSE_SCHEMA
      }
    },
    ...(useReasoning && { reasoning: { summary: 'auto', effort: 'low' } })
  })

  let eventTypesLogged = new Set<string>()

  for await (const event of stream) {

    if (!eventTypesLogged.has(event.type)) {
      console.log('[AI-Chat] Stream event type:', event.type)
      eventTypesLogged.add(event.type)
    }

    if (event.type === 'response.reasoning_summary_text.delta') {
      thinkingContent += event.delta
      callbacks.onThinking(event.delta, thinkingContent)
    } else if (event.type === 'response.output_text.delta') {
      outputContent += event.delta
    } else if (event.type === 'response.completed') {
      try {
        const parsed = JSON.parse(outputContent)
        const tokenCount = event.response?.usage?.total_tokens || 0

        callbacks.onDone({
          thinkingContent,
          explanation: parsed.explanation,
          hasChanges: parsed.hasChanges,
          updatedCommand: parsed.hasChanges ? parsed.updatedCommand : null,
          tokenCount
        })
        return
      } catch (parseError) {
        console.error('[AI-Chat] Failed to parse response:', parseError)
        callbacks.onError('Failed to parse AI response')
        return
      }
    }
  }

  // Fallback: stream ended without response.completed
  if (outputContent) {
    try {
      const parsed = JSON.parse(outputContent)
      callbacks.onDone({
        thinkingContent,
        explanation: parsed.explanation,
        hasChanges: parsed.hasChanges,
        updatedCommand: parsed.hasChanges ? parsed.updatedCommand : null,
        tokenCount: 0
      })
    } catch (parseError) {
      console.error('[AI-Chat] Fallback parse failed:', parseError)
      callbacks.onError('Stream ended unexpectedly without a valid response')
    }
  } else {
    callbacks.onError('Stream ended without receiving a response')
  }
}
