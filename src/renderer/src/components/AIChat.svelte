<script lang="ts">
  import { createEventDispatcher, onMount, tick } from 'svelte'
  import { t } from '../stores/localisation'
  import { settingsStore } from '../stores/settings'
  import DiffViewer from './DiffViewer.svelte'
  import type { BCFDCommand } from '../types/types'
  import {
    chatMessages,
    isAiLoading,
    selectedModel,
    totalTokens,
    addMessage,
    clearChat,
    updateMessage,
    estimateTokens,
    generateCommandDiff,
    AI_MODELS,
    type CommandDiff
  } from '../stores/aiChat'

  export let command: BCFDCommand
  export let onCommandUpdate: (updated: BCFDCommand) => void

  const dispatch = createEventDispatcher<{
    close: void
  }>()

  let inputMessage = ''
  let messagesContainer: HTMLDivElement
  let inputElement: HTMLTextAreaElement

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
   - Write: \`let name = $namePlain;\`
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

When answering questions without changes:
- Set hasChanges to false
- Provide helpful explanations about BCFD language features
- Give examples when appropriate`

  async function sendMessage() {
    if (!inputMessage.trim() || $isAiLoading) return

    const userMessage = inputMessage.trim()
    inputMessage = ''

    // Add user message
    addMessage('user', userMessage)

    // Update token count
    totalTokens.update((t) => t + estimateTokens(userMessage))

    // Scroll to bottom
    await tick()
    scrollToBottom()

    // Set loading state
    isAiLoading.set(true)

    try {
      // Build conversation history
      const conversationHistory = $chatMessages.map((msg) => ({
        role: msg.role,
        content: msg.content
      }))

      // Call AI API
      const response = await (window as any).electron.ipcRenderer.invoke('ai-command-chat', {
        messages: conversationHistory,
        currentCommand: command,
        model: $selectedModel,
        systemPrompt: BCFD_SYSTEM_PROMPT
      })

      if (response.error) {
        addMessage('assistant', `Error: ${response.error}`)
      } else {
        let pendingChanges: CommandDiff | null = null

        // Check if AI is proposing changes
        if (response.hasChanges && response.updatedCommand) {
          // Merge with existing command to preserve fields not in the update
          const mergedCommand: BCFDCommand = {
            ...command,
            ...response.updatedCommand
          }
          pendingChanges = generateCommandDiff(command, mergedCommand)
        }

        addMessage('assistant', response.explanation, pendingChanges)

        // Update token count
        totalTokens.update((t) => t + (response.tokenCount || estimateTokens(response.explanation)))
      }
    } catch (error) {
      console.error('AI chat error:', error)
      addMessage(
        'assistant',
        `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
      )
    } finally {
      isAiLoading.set(false)
      await tick()
      scrollToBottom()
    }
  }

  function handleAcceptChanges(event: CustomEvent<CommandDiff>) {
    const diff = event.detail
    onCommandUpdate(diff.after)

    // Remove pending changes from the message
    chatMessages.update((msgs) =>
      msgs.map((msg) => (msg.pendingChanges === diff ? { ...msg, pendingChanges: null } : msg))
    )

    addMessage('system', `✓ ${$t('changes-applied')}`)
  }

  function handleRejectChanges(messageId: string) {
    updateMessage(messageId, { pendingChanges: null })
    addMessage('system', `✗ ${$t('changes-rejected')}`)
  }

  function scrollToBottom() {
    if (messagesContainer) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  }

  function handleNewChat() {
    clearChat()
    // Add initial context message
    addMessage(
      'system',
      `${$t('ai-chat-started')} "${command.commandDescription || command.command || 'New Command'}"`
    )
  }

  onMount(() => {
    // Initialize with context
    if ($chatMessages.length === 0) {
      handleNewChat()
    }
    inputElement?.focus()
  })

  $: hasApiKey = $settingsStore.openaiApiKey && $settingsStore.openaiApiKey.length > 0
</script>

<div class="ai-chat flex flex-col h-full bg-base-100 border-l border-base-300">
  <!-- Header -->
  <div
    class="chat-header p-3 border-b border-base-300 flex items-center justify-between bg-base-200"
  >
    <div class="flex items-center gap-2">
      <span class="material-symbols-outlined text-primary">smart_toy</span>
      <span class="font-bold">{$t('ai-assistant')}</span>
    </div>
    <div class="flex items-center gap-2">
      <!-- Model Picker -->
      <select
        bind:value={$selectedModel}
        class="select select-sm select-bordered w-32"
        title={$t('select-model')}
      >
        {#each AI_MODELS as model}
          <option value={model.id}>{model.name}</option>
        {/each}
      </select>

      <!-- Token Counter -->
      <div class="badge badge-ghost text-xs" title={$t('total-tokens')}>
        <span class="material-symbols-outlined text-xs mr-1">token</span>
        {$totalTokens.toLocaleString()}
      </div>

      <!-- New Chat -->
      <button
        class="btn btn-ghost btn-sm btn-circle"
        on:click={handleNewChat}
        title={$t('new-chat')}
      >
        <span class="material-symbols-outlined">refresh</span>
      </button>

      <!-- Close -->
      <button
        class="btn btn-ghost btn-sm btn-circle"
        on:click={() => dispatch('close')}
        title={$t('close')}
      >
        <span class="material-symbols-outlined">close</span>
      </button>
    </div>
  </div>

  <!-- API Key Warning -->
  {#if !hasApiKey}
    <div class="alert alert-warning m-3 text-sm">
      <span class="material-symbols-outlined">warning</span>
      <span>{$t('openai-key-required')}</span>
    </div>
  {/if}

  <!-- Messages -->
  <div bind:this={messagesContainer} class="flex-1 overflow-y-auto p-3 space-y-3">
    {#each $chatMessages as message (message.id)}
      <div class="chat {message.role === 'user' ? 'chat-end' : 'chat-start'}">
        {#if message.role !== 'system'}
          <div class="chat-image avatar placeholder">
            <div class="w-8 rounded-full {message.role === 'user' ? 'bg-primary' : 'bg-secondary'}">
              <span class="material-symbols-outlined text-sm text-base-100">
                {message.role === 'user' ? 'person' : 'smart_toy'}
              </span>
            </div>
          </div>

          <div
            class="chat-bubble {message.role === 'user'
              ? 'chat-bubble-primary'
              : 'chat-bubble-secondary'}"
          >
            <div class="whitespace-pre-wrap">{message.content}</div>
          </div>
        {:else}
          <div class=" text-xs py-1">
            <div class="whitespace-pre-wrap">{message.content}</div>
          </div>
        {/if}

        {#if message.pendingChanges && message.pendingChanges.changes.length > 0}
          <div class="w-full mt-2">
            <DiffViewer
              diff={message.pendingChanges}
              on:accept={handleAcceptChanges}
              on:reject={() => handleRejectChanges(message.id)}
            />
          </div>
        {/if}
      </div>
    {/each}

    {#if $isAiLoading}
      <div class="chat chat-start">
        <div class="chat-image avatar placeholder">
          <div class="w-8 rounded-full bg-secondary">
            <span class="material-symbols-outlined text-sm text-base-100">smart_toy</span>
          </div>
        </div>
        <div class="chat-bubble chat-bubble-secondary">
          <span class="loading loading-dots loading-sm"></span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Input -->
  <div class="chat-input p-3 border-t border-base-300 bg-base-200">
    <div class="flex gap-2">
      <textarea
        bind:this={inputElement}
        bind:value={inputMessage}
        on:keydown={handleKeydown}
        placeholder={hasApiKey ? $t('describe-changes') : $t('api-key-needed')}
        class="textarea textarea-bordered flex-1 resize-none min-h-[2.5rem] max-h-32"
        rows="1"
        disabled={!hasApiKey || $isAiLoading}
      ></textarea>
      <button
        class="btn btn-primary"
        on:click={sendMessage}
        disabled={!inputMessage.trim() || !hasApiKey || $isAiLoading}
      >
        {#if $isAiLoading}
          <span class="loading loading-spinner loading-sm"></span>
        {:else}
          <span class="material-symbols-outlined">send</span>
        {/if}
      </button>
    </div>

    <!-- Quick Actions -->
    <div class="flex flex-wrap gap-1 mt-2">
      <button
        class="btn btn-xs btn-ghost"
        on:click={() => {
          inputMessage = $t('quick-make-funnier')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        😄 {$t('make-funnier')}
      </button>
      <button
        class="btn btn-xs btn-ghost"
        on:click={() => {
          inputMessage = $t('quick-add-random')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        🎲 {$t('add-randomness')}
      </button>
      <button
        class="btn btn-xs btn-ghost"
        on:click={() => {
          inputMessage = $t('quick-add-mentions')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        @️ {$t('use-mentions')}
      </button>
      <button
        class="btn btn-xs btn-ghost"
        on:click={() => {
          inputMessage = $t('quick-add-counter')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        🔢 {$t('add-counter')}
      </button>
    </div>
  </div>
</div>

<style>
  .ai-chat {
    min-width: 320px;
  }

  .chat-bubble {
    max-width: 90%;
  }

  .chat-start .chat-bubble + :global(.diff-viewer) {
    margin-left: 2.5rem;
    max-width: calc(100% - 2.5rem);
  }

  textarea {
    field-sizing: content;
  }
</style>
