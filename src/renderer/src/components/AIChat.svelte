<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte'
  import { marked } from 'marked'
  import { t } from '../stores/localisation'
  import {
    getSelectedModelForProvider,
    saveSettings,
    settingsStore,
    withSelectedModelForProvider
  } from '../stores/settings'
  import DiffViewer from './DiffViewer.svelte'
  import ModelPicker from './ModelPicker.svelte'
  import type { BCFDCommand, ChatContext } from '../types/types'
  import {
    chatMessages,
    isAiLoading,
    selectedModel,
    selectedReasoningEffort,
    totalTokens,
    addMessage,
    updateMessage,
    estimateTokens,
    generateCommandDiff,
    applyCommandPatch,
    type CommandDiff,
    // Persistence and context
    activeChatId,
    selectedContexts,
    contextPickerOpen,
    initializeChats,
    fetchRecentChats,
    loadOrCreateChatForCommand,
    clearChatMessages,
    addContext,
    removeContext,
    buildContextString,
    // Thinking state (for streaming reasoning tokens)
    thinkingContent,
    isThinking,
    thinkingExpanded,
    isThinkingModel,
    initAiChatStreamListeners,
    type StreamingDoneResponse
  } from '../stores/aiChat'
  import { consoleStore } from '../stores/console'

  interface Props {
    command: BCFDCommand
    onCommandUpdate: (updated: BCFDCommand) => void
    allCommands?: BCFDCommand[]
  }

  let { command, onCommandUpdate, allCommands = [] }: Props = $props()

  const dispatch = createEventDispatcher<{
    close: void
  }>()

  let inputMessage = $state('')
  let messagesContainer: HTMLDivElement = $state()
  let inputElement: HTMLTextAreaElement = $state()
  let cleanupStreamListeners: (() => void) | null = null
  let aiModels: Array<{ id: string; name: string; supportsStructuredOutputs?: boolean }> = $state(
    []
  )
  let isLoadingModels = $state(false)
  let modelFetchError = $state('')
  let activeRequestId: string | null = null
  let lastProvider: 'openai' | 'openrouter' | null = null
  let lastProviderModel: string | null = null
  let componentDestroyed = false

  // Available context options
  let availableContexts = $derived([
    {
      type: 'command' as const,
      id: command.id,
      label: `Current: ${command.commandDescription || command.command}`,
      content: JSON.stringify(command, null, 2)
    },
    { type: 'startup-js' as const, label: 'Startup JavaScript' },
    { type: 'bot-state' as const, label: 'Bot State' },
    { type: 'all-commands' as const, label: 'All Commands' },
    ...allCommands
      .filter((cmd) => cmd.id !== command.id)
      .map((cmd) => ({
        type: 'command' as const,
        id: cmd.id,
        label: cmd.commandDescription || cmd.command,
        content: JSON.stringify(cmd, null, 2)
      }))
  ])

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
    activeRequestId = `ai_${Date.now()}_${Math.random().toString(36).slice(2)}`

    // Reset thinking state for thinking models
    if (isThinkingModel($selectedModel) && $selectedReasoningEffort !== 'none') {
      thinkingContent.set('')
      thinkingExpanded.set(true) // Expand while thinking
    }

    let isStreamingResponse = false

    try {
      // Build additional context from selected contexts
      const additionalContext = await buildContextString()

      // Build conversation history
      const conversationHistory = $chatMessages
        .filter((msg) => msg.role !== 'system')
        .map((msg) => ({
          role: msg.role,
          content: msg.content
        }))

      // Call AI API with context
      const response = await window.electron.ipcRenderer.invoke('ai-command-chat', {
        messages: conversationHistory,
        currentCommand: $state.snapshot(command),
        model: $selectedModel,
        reasoningEffort: $selectedReasoningEffort,
        requestId: activeRequestId,
        additionalContext: additionalContext
      })

      // For streaming responses, the stream listeners handle the response
      if (response.streaming) {
        // Response will come via IPC events (ai-chat:thinking, ai-chat:done)
        // The stream listeners will handle adding the message and updating state
        isStreamingResponse = true
        return
      }

      // Handle non-streaming response (regular models)
      if (response.error) {
        addMessage('assistant', `Error: ${response.error}`)
      } else {
        let pendingChanges: CommandDiff | null = null

        // Check if AI is proposing changes
        if (response.hasChanges && response.changes?.length) {
          const result = applyCommandPatch(command, response.changes)
          pendingChanges = result.diff
          if (result.warnings.length) {
            response.explanation += `\n\nSome proposed edits were ignored: ${result.warnings.join('; ')}`
          }
        } else if (response.hasChanges && response.updatedCommand) {
          pendingChanges = generateCommandDiff(command, response.updatedCommand)
        }

        addMessage('assistant', response.explanation, pendingChanges)
        activeRequestId = null

        // Update token count
        totalTokens.update((t) => t + (response.tokenCount || estimateTokens(response.explanation)))
      }
    } catch (error) {
      consoleStore.error('AI chat error:' + JSON.stringify(error))
      addMessage(
        'assistant',
        `Error: ${error instanceof Error ? error.message : 'Unknown error occurred'}`
      )
    } finally {
      // Only set loading to false for non-streaming responses
      // Streaming responses will set this in the done handler
      if (!isStreamingResponse) {
        isAiLoading.set(false)
        activeRequestId = null
      }
      await tick()
      scrollToBottom()
    }
  }

  async function handleAcceptChanges(event: CustomEvent<CommandDiff>) {
    const diff = event.detail
    onCommandUpdate(diff.after)

    // Find the message with this diff and update it to remove pending changes
    const messageWithDiff = $chatMessages.find((msg) => msg.pendingChanges === diff)
    if (messageWithDiff) {
      await updateMessage(messageWithDiff.id, { pendingChanges: null })
    }

    addMessage('system', `✓ ${$t('changes-applied')}`)
  }

  async function handleRejectChanges(messageId: string) {
    await updateMessage(messageId, { pendingChanges: null })
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

  async function handleClearChat() {
    await clearChatMessages()
    const commandLabel = command.commandDescription || command.command || 'New Command'
    addMessage('system', `${$t('ai-chat-started')} "${commandLabel}"`)
  }

  function toggleContext(ctx: ChatContext) {
    // Don't allow removing the current command context
    if (ctx.type === 'command' && ctx.id === command.id) {
      return
    }
    const exists = $selectedContexts.some((c) => c.type === ctx.type && c.id === ctx.id)
    if (exists) {
      removeContext(ctx)
    } else {
      addContext(ctx)
    }
  }

  function isCurrentCommandContext(ctx: ChatContext): boolean {
    return ctx.type === 'command' && ctx.id === command.id
  }

  function isContextSelected(ctx: ChatContext): boolean {
    return $selectedContexts.some((c) => c.type === ctx.type && c.id === ctx.id)
  }

  function handleModelChange(model: string) {
    if (!model) return
    const provider = $settingsStore.aiProvider || 'openai'
    lastProviderModel = model
    selectedModel.set(model)
    saveSettings(withSelectedModelForProvider($settingsStore, provider, model))
  }

  function handleReasoningChange(event: Event) {
    selectedReasoningEffort.set((event.target as HTMLSelectElement).value as any)
  }

  async function refreshAiModels() {
    if (($settingsStore.aiProvider || 'openai') === 'openai' && !$settingsStore.openaiApiKey) {
      aiModels = []
      modelFetchError = 'Add an OpenAI API key in Settings to fetch OpenAI models.'
      return
    }
    isLoadingModels = true
    modelFetchError = ''
    try {
      aiModels = await window.electron.ipcRenderer.invoke('fetch-ai-models')
    } catch (error) {
      modelFetchError = error instanceof Error ? error.message : 'Failed to fetch models'
    } finally {
      isLoadingModels = false
    }
  }

  $effect(() => {
    const provider = $settingsStore.aiProvider || 'openai'
    const providerModel = getSelectedModelForProvider($settingsStore, provider)

    if (providerModel !== lastProviderModel) {
      lastProviderModel = providerModel
      selectedModel.set(providerModel)
    }

    if (provider !== lastProvider) {
      lastProvider = provider
      refreshAiModels()
    }
  })

  onMount(async () => {
    componentDestroyed = false
    const provider = $settingsStore.aiProvider || 'openai'
    lastProvider = provider
    lastProviderModel = getSelectedModelForProvider($settingsStore, provider)
    selectedModel.set(lastProviderModel)
    refreshAiModels()

    // Initialize chats from storage
    await initializeChats()
    if (componentDestroyed) return
    await fetchRecentChats()
    if (componentDestroyed) return

    // Load or create the single chat for this command
    const commandLabel = command.commandDescription || command.command || 'New Command'
    const commandContext: ChatContext = {
      type: 'command',
      id: command.id,
      label: `Current: ${commandLabel}`,
      content: JSON.stringify(command, null, 2)
    }
    await loadOrCreateChatForCommand(command.id, commandLabel, commandContext)
    if (componentDestroyed) return

    // Add initial system message if chat is empty
    if ($chatMessages.length === 0) {
      addMessage('system', `${$t('ai-chat-started')} "${commandLabel}"`)
    }
    if (componentDestroyed) return

    // Initialize stream listeners for thinking models
    cleanupStreamListeners = initAiChatStreamListeners(
      async (response: StreamingDoneResponse, pendingChanges: CommandDiff | null) => {
        if (response.warnings?.length) {
          response.explanation += `\n\nSome proposed edits were ignored: ${response.warnings.join('; ')}`
        }
        // Add the assistant message with thinking content
        addMessage('assistant', response.explanation, pendingChanges, response.thinkingContent)

        // Update token count
        totalTokens.update((t) => t + (response.tokenCount || estimateTokens(response.explanation)))

        // Finish loading
        isAiLoading.set(false)
        activeRequestId = null

        await tick()
        scrollToBottom()
      },
      () => $state.snapshot(command), // Provide current command for diff generation (snapshot to avoid proxy issues)
      () => activeRequestId
    )

    await tick()
    if (componentDestroyed) return
    scrollToBottom()
    inputElement?.focus()
  })

  onDestroy(() => {
    componentDestroyed = true
    activeRequestId = null

    // Clean up stream listeners
    if (cleanupStreamListeners) {
      cleanupStreamListeners()
      cleanupStreamListeners = null
    }

    // Clear the local state when component is destroyed
    activeChatId.set(null)
    chatMessages.set([])
    selectedContexts.set([])

    // Clear thinking state
    thinkingContent.set('')
    isThinking.set(false)
    thinkingExpanded.set(false)
    isAiLoading.set(false)
  })

  let hasApiKey = $derived(
    $settingsStore.aiProvider === 'openrouter'
      ? !!$settingsStore.openrouterApiKey && !!$settingsStore.openaiApiKey
      : !!$settingsStore.openaiApiKey
  )
  let apiKeyWarning = $derived(
    $settingsStore.aiProvider === 'openrouter'
      ? 'Add your OpenRouter API key and OpenAI moderation key in Settings to use the AI assistant.'
      : $t('openai-key-required')
  )

  // Render markdown to HTML
  function renderMarkdown(content: string): string {
    return marked.parse(content, { async: false }) as string
  }
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
    <div class="flex items-center gap-1">
      <!-- Token Counter -->
      <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('total-tokens')}>
        <div class="badge badge-ghost text-xs">
          <span class="material-symbols-outlined text-xs mr-1">token</span>
          {$totalTokens.toLocaleString()}
        </div>
      </span>

      <!-- Clear Chat -->
      <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('clear-chat')}>
        <button class="btn btn-ghost btn-sm btn-circle" onclick={handleClearChat}>
          <span class="material-symbols-outlined">delete_sweep</span>
        </button>
      </span>

      <!-- Close -->
      <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('close')}>
        <button class="btn btn-ghost btn-sm btn-circle" onclick={() => dispatch('close')}>
          <span class="material-symbols-outlined">close</span>
        </button>
      </span>
    </div>
  </div>

  <!-- API Key Warning -->
  {#if !hasApiKey}
    <div class="alert alert-warning m-3 text-sm">
      <span class="material-symbols-outlined">warning</span>
      <span>{apiKeyWarning}</span>
    </div>
  {/if}

  <!-- Messages -->
  <div bind:this={messagesContainer} class="flex-1 overflow-y-auto p-3 space-y-3">
    {#each $chatMessages as message (message.id)}
      <div class="chat {message.role === 'user' ? 'chat-end' : 'chat-start'}">
        {#if message.role !== 'system'}
          <div class="chat-image avatar placeholder">
            <div
              class="w-8 rounded-full flex items-center justify-center {message.role === 'user'
                ? 'bg-primary'
                : 'bg-secondary'}"
            >
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
            {#if message.role === 'assistant' && message.thinkingContent}
              <!-- Collapsible thinking section for completed messages -->
              <details class="thinking-section mb-2 border-b border-base-content/10 pb-2">
                <summary
                  class="flex items-center gap-1 text-xs opacity-70 hover:opacity-100 transition-opacity cursor-pointer list-none"
                >
                  <span class="material-symbols-outlined text-xs">psychology</span>
                  <span>View reasoning</span>
                </summary>
                <div
                  class="thinking-content prose prose-sm mt-2 p-2 bg-base-300/50 rounded text-xs max-h-40 overflow-y-auto"
                >
                  {@html renderMarkdown(message.thinkingContent)}
                </div>
              </details>
            {/if}
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
          <div class="w-8 rounded-full bg-secondary flex items-center justify-center">
            <span class="material-symbols-outlined text-sm text-base-100">smart_toy</span>
          </div>
        </div>
        <div class="chat-bubble chat-bubble-secondary">
          {#if $isThinking && $thinkingContent}
            <!-- Collapsible thinking section while streaming -->
            <div class="thinking-section mb-2">
              <button
                class="flex items-center gap-1 text-xs opacity-70 hover:opacity-100 transition-opacity"
                onclick={() => thinkingExpanded.update((v) => !v)}
              >
                <span
                  class="material-symbols-outlined text-xs transition-transform"
                  class:rotate-180={$thinkingExpanded}
                >
                  expand_more
                </span>
                <span class="material-symbols-outlined text-xs animate-pulse">psychology</span>
                <span>Thinking...</span>
              </button>
              {#if $thinkingExpanded}
                <div
                  class="thinking-content prose prose-sm mt-2 p-2 bg-base-300/50 rounded text-xs max-h-40 overflow-y-auto"
                >
                  {@html renderMarkdown($thinkingContent)}
                </div>
              {/if}
            </div>
          {/if}
          <span class="loading loading-dots loading-sm"></span>
        </div>
      </div>
    {/if}
  </div>

  <!-- Input -->
  <div class="chat-input p-3 border-t border-base-300 bg-base-200">
    {#if $contextPickerOpen}
      <div
        class="context-picker-panel mb-2 border border-base-300 bg-base-100 p-3 max-h-48 overflow-y-auto"
      >
        <div class="text-xs font-semibold mb-2 text-base-content/70">Select Context</div>
        <div class="space-y-1">
          {#each availableContexts as ctx}
            <label
              class="flex items-center gap-2 p-1 rounded"
              class:cursor-pointer={!isCurrentCommandContext(ctx)}
              class:hover:bg-base-200={!isCurrentCommandContext(ctx)}
              class:opacity-60={isCurrentCommandContext(ctx)}
            >
              <input
                type="checkbox"
                class="checkbox checkbox-xs checkbox-primary"
                checked={isContextSelected(ctx)}
                disabled={isCurrentCommandContext(ctx)}
                onchange={() => toggleContext(ctx)}
              />
              <span class="text-sm truncate">{ctx.label}</span>
              {#if isCurrentCommandContext(ctx)}
                <span class="badge badge-xs badge-secondary">Locked</span>
              {:else if ctx.type === 'startup-js'}
                <span class="badge badge-xs badge-ghost">JS</span>
              {:else if ctx.type === 'bot-state'}
                <span class="badge badge-xs badge-ghost">State</span>
              {:else if ctx.type === 'all-commands'}
                <span class="badge badge-xs badge-ghost">All</span>
              {:else if ctx.type === 'command'}
                <span class="badge badge-xs badge-ghost">Cmd</span>
              {/if}
            </label>
          {/each}
        </div>
      </div>
    {/if}

    <div class="composer border border-base-300 bg-base-100 p-2">
      {#if $selectedContexts.length > 0}
        <div class="flex flex-wrap gap-1 mb-2">
          {#each $selectedContexts as ctx}
            <div
              class="badge gap-1 p-3"
              class:badge-primary={!isCurrentCommandContext(ctx)}
              class:badge-secondary={isCurrentCommandContext(ctx)}
            >
              {#if isCurrentCommandContext(ctx)}
                <span class="material-symbols-outlined text-xs">lock</span>
              {/if}
              <span class="text-xs truncate max-w-32">{ctx.label}</span>
              {#if !isCurrentCommandContext(ctx)}
                <button class="hover:text-error" onclick={() => removeContext(ctx)}>
                  <span class="material-symbols-outlined text-xs">close</span>
                </button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <textarea
        bind:this={inputElement}
        bind:value={inputMessage}
        onkeydown={handleKeydown}
        placeholder={hasApiKey ? $t('describe-changes') : $t('api-key-needed')}
        class="textarea textarea-ghost w-full resize-none min-h-10 max-h-32 p-2 focus:outline-none"
        rows="1"
        disabled={!hasApiKey || $isAiLoading}
      ></textarea>

      <div class="flex flex-wrap items-center justify-between gap-2 pt-2">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <!-- Context Picker -->
          <span class="tooltip tooltip-primary tooltip-top" data-tip={$t('select-context')}>
            <button
              class="btn btn-ghost btn-sm btn-circle"
              class:btn-active={$contextPickerOpen}
              onclick={() => contextPickerOpen.update((v) => !v)}
            >
              <span class="material-symbols-outlined">attach_file</span>
            </button>
          </span>

          <!-- Model Picker -->
          <span class="tooltip tooltip-primary tooltip-top" data-tip={$t('select-model')}>
            <div class="w-44 max-w-[45vw]">
              <ModelPicker
                value={$selectedModel}
                models={aiModels}
                provider={$settingsStore.aiProvider || 'openai'}
                title="Select assistant model"
                placeholder={$settingsStore.aiProvider === 'openrouter'
                  ? 'openai/gpt-5.2'
                  : 'gpt-4.1-nano'}
                disabled={isLoadingModels}
                error={modelFetchError}
                isLoading={isLoadingModels}
                onRefresh={refreshAiModels}
                buttonClass="btn btn-sm btn-ghost justify-between w-full"
                onChange={handleModelChange}
              />
            </div>
          </span>

          <!-- Reasoning Picker -->
          <span class="tooltip tooltip-primary tooltip-top" data-tip="Reasoning effort">
            <select
              value={$selectedReasoningEffort}
              onchange={handleReasoningChange}
              class="select select-ghost select-sm w-32"
            >
              <option value="none">No reasoning</option>
              <option value="minimal">Minimal</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh</option>
            </select>
          </span>
        </div>

        <button
          class="btn btn-primary btn-sm btn-circle"
          onclick={sendMessage}
          disabled={!inputMessage.trim() || !hasApiKey || $isAiLoading}
        >
          {#if $isAiLoading}
            <span class="loading loading-spinner loading-sm"></span>
          {:else}
            <span class="material-symbols-outlined">send</span>
          {/if}
        </button>
      </div>
    </div>

    <!-- Quick Actions -->
    <div class="flex flex-wrap gap-1 mt-2">
      <button
        class="btn btn-xs btn-ghost"
        onclick={() => {
          inputMessage = $t('quick-suggest-improvements')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        {$t('suggest-improvements')}
      </button>
      <button
        class="btn btn-xs btn-ghost"
        onclick={() => {
          inputMessage = $t('quick-make-funnier')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        😄 {$t('make-funnier')}
      </button>
      <button
        class="btn btn-xs btn-ghost"
        onclick={() => {
          inputMessage = $t('quick-add-random')
          sendMessage()
        }}
        disabled={!hasApiKey || $isAiLoading}
      >
        🎲 {$t('add-randomness')}
      </button>
      <button
        class="btn btn-xs btn-ghost"
        onclick={() => {
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

  /* Thinking section styles */
  .thinking-content {
    animation: fadeIn 0.2s ease-out;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      max-height: 0;
    }
    to {
      opacity: 1;
      max-height: 160px;
    }
  }

  /* Hide default details marker */
  details.thinking-section > summary::-webkit-details-marker {
    display: none;
  }
</style>
