<script lang="ts">
  import { onMount, tick } from 'svelte'
  import ModelPicker from './ModelPicker.svelte'
  import AgentApprovalDiff from './AgentApprovalDiff.svelte'
  import { renderMarkdown } from '../utils/markdown'
  import { agentToolLabel } from '../utils/agentToolLabel'
  import { settingsStore } from '../stores/settings'
  import type { AgentMode, AgentToolCall } from '../../../shared/agentTypes'
  import {
    activeAgentSession,
    agentSessions,
    cancelAgentRun,
    createAgentSession,
    deleteAgentSession,
    initializeAgentSessions,
    resolveAgentApproval,
    selectAgentSession,
    sendAgentMessage,
    updateAgentSession
  } from '../stores/agent'

  let input = $state('')
  let messagesElement: HTMLDivElement = $state()
  let models: Array<{ id: string; name?: string; supportsReasoning?: boolean }> = $state([])
  let loadingModels = $state(false)
  let modelError = $state('')
  let currentTime = $state(Date.now())
  let spinnerFrameIndex = $state(0)

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  const running = $derived(
    $activeAgentSession?.status === 'running' || $activeAgentSession?.status === 'waiting_approval'
  )
  const elapsedTime = $derived.by(() => {
    if ($activeAgentSession?.status !== 'running') return '0:00'
    const startedAt = [...$activeAgentSession.messages]
      .reverse()
      .find((message) => message.role === 'user')?.timestamp
    if (!startedAt) return '0:00'
    return formatElapsedTime(Math.max(0, currentTime - new Date(startedAt).getTime()))
  })

  onMount(() => {
    void initializeAgentSessions().then(async () => {
      if ($agentSessions.sessions.length === 0) await createAgentSession()
      await tick()
      scrollToBottom()
    })
    void refreshModels()
  })

  onMount(() => {
    const timer = window.setInterval(() => {
      currentTime = Date.now()
    }, 1000)
    const spinnerTimer = window.setInterval(() => {
      if (running) spinnerFrameIndex = (spinnerFrameIndex + 1) % spinnerFrames.length
    }, 80)
    return () => {
      window.clearInterval(timer)
      window.clearInterval(spinnerTimer)
    }
  })

  function formatElapsedTime(milliseconds: number): string {
    const totalSeconds = Math.floor(milliseconds / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    return hours > 0
      ? `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
      : `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  async function refreshModels() {
    loadingModels = true
    modelError = ''
    try {
      models = await window.electron.ipcRenderer.invoke('fetch-ai-models')
    } catch (error) {
      modelError = error instanceof Error ? error.message : String(error)
    } finally {
      loadingModels = false
    }
  }

  async function submit() {
    if (!input.trim() || running || !$activeAgentSession) return
    const content = input.trim()
    input = ''
    await sendAgentMessage(content)
    await tick()
    scrollToBottom()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  function scrollToBottom() {
    messagesElement?.scrollTo({ top: messagesElement.scrollHeight, behavior: 'smooth' })
  }

  function statusIcon(status: string): string {
    if (status === 'running') return 'progress_activity'
    if (status === 'waiting_approval') return 'approval'
    if (status === 'error') return 'error'
    if (status === 'completed') return 'check_circle'
    if (status === 'interrupted') return 'pause_circle'
    return 'chat_bubble'
  }

  function statusClass(status: string): string {
    if (status === 'error') return 'text-error'
    if (status === 'waiting_approval') return 'text-warning'
    if (status === 'running') return 'text-info animate-spin'
    if (status === 'completed') return 'text-success'
    return 'opacity-60'
  }

  function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2)
  }

  async function setMode(mode: AgentMode) {
    if ($activeAgentSession) await updateAgentSession($activeAgentSession.id, { mode })
  }

  async function closeSession(event: MouseEvent, sessionId: string) {
    event.stopPropagation()
    await deleteAgentSession(sessionId)
    if ($agentSessions.sessions.length === 0) await createAgentSession()
  }

  async function decide(call: AgentToolCall, approved: boolean) {
    await resolveAgentApproval(call.id, approved)
  }
</script>

<div class="flex h-full min-h-0 bg-base-100">
  <aside class="w-52 shrink-0 border-r border-base-300 bg-base-200 flex flex-col min-h-0">
    <div class="h-14 px-3 border-b border-base-300 flex items-center justify-between">
      <h2 class="font-semibold text-sm">Agent sessions</h2>
      <span class="tooltip tooltip-bottom" data-tip="New session">
        <button
          class="btn btn-ghost btn-sm btn-circle"
          onclick={() => createAgentSession()}
          aria-label="New session"
        >
          <span class="material-symbols-outlined">add</span>
        </button>
      </span>
    </div>
    <div class="grow overflow-y-auto py-2">
      {#each $agentSessions.sessions as session (session.id)}
        <div
          class="h-12 flex items-center border-l-2 hover:bg-base-300 group {session.id ===
          $agentSessions.activeSessionId
            ? 'bg-base-300 border-primary'
            : 'border-transparent'}"
        >
          <button
            class="h-full min-w-0 grow px-3 flex items-center gap-2 text-left"
            onclick={() => selectAgentSession(session.id)}
          >
            <span class="material-symbols-outlined text-base {statusClass(session.status)}"
              >{statusIcon(session.status)}</span
            >
            <span class="text-sm truncate grow">{session.title}</span>
          </button>
          <span class="tooltip tooltip-left" data-tip="Close session">
            <button
              class="btn btn-ghost btn-xs btn-circle mr-2 opacity-0 group-hover:opacity-60 hover:opacity-100"
              onclick={(event) => closeSession(event, session.id)}
              aria-label="Close session"
              ><span class="material-symbols-outlined text-base">close</span></button
            >
          </span>
        </div>
      {/each}
    </div>
  </aside>

  {#if $activeAgentSession}
    <section class="grow min-w-0 flex flex-col min-h-0">
      <header class="h-14 px-4 border-b border-base-300 flex items-center gap-3 shrink-0">
        <div class="join shrink-0" aria-label="Agent execution mode">
          {#each [['manual', 'Manual'], ['auto', 'Auto'], ['planning', 'Planning']] as option}
            <button
              class="btn btn-sm join-item {$activeAgentSession.mode === option[0]
                ? 'btn-primary'
                : 'btn-ghost'}"
              onclick={() => setMode(option[0] as AgentMode)}
              disabled={running}>{option[1]}</button
            >
          {/each}
        </div>
        <div class="w-56 min-w-0">
          <ModelPicker
            value={$activeAgentSession.model}
            {models}
            provider={$settingsStore.aiProvider || 'openai'}
            buttonClass="btn btn-sm btn-outline justify-between w-full"
            error={modelError}
            isLoading={loadingModels}
            onRefresh={refreshModels}
            onChange={(model) => updateAgentSession($activeAgentSession!.id, { model })}
            disabled={running}
          />
        </div>
        <select
          class="select select-bordered select-sm w-28"
          value={$activeAgentSession.reasoningEffort}
          disabled={running}
          onchange={(event) =>
            updateAgentSession($activeAgentSession!.id, {
              reasoningEffort: event.currentTarget.value as any
            })}
          aria-label="Reasoning effort"
        >
          <option value="none">No reasoning</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
        <div class="ml-auto text-xs opacity-60 tabular-nums">
          {$activeAgentSession.tokenCount.toLocaleString()} tokens
        </div>
      </header>

      <div class="grow overflow-y-auto px-5 py-4" bind:this={messagesElement}>
        {#if $activeAgentSession.messages.length === 0}
          <div class="h-full flex items-center justify-center text-base-content/50">
            <span class="material-symbols-outlined text-3xl mr-3">terminal</span>
            <span>Ask the agent to inspect or change your bot.</span>
          </div>
        {:else}
          <div class="max-w-4xl mx-auto space-y-5">
            {#each $activeAgentSession.messages as message (message.id)}
              {#if message.role === 'user'}
                <div class="flex justify-end">
                  <div
                    class="max-w-[78%] bg-primary text-primary-content rounded-md px-4 py-3 whitespace-pre-wrap break-words"
                  >
                    {message.content}
                  </div>
                </div>
              {:else if message.role === 'assistant'}
                <div class="border-l-2 border-base-300 pl-4 min-w-0">
                  <div class="prose prose-sm max-w-none break-words">
                    {@html renderMarkdown(message.content)}
                  </div>
                </div>
              {:else if message.role === 'tool'}
                {#each message.toolCalls || [] as call (call.id)}
                  <div class="border border-base-300 rounded-md overflow-hidden">
                    <div class="h-10 px-3 bg-base-200 flex items-center gap-2">
                      <span class="material-symbols-outlined text-base">build</span>
                      <code
                        class="text-sm font-semibold min-w-0 truncate"
                        title={agentToolLabel(call)}>{agentToolLabel(call)}</code
                      >
                      <span
                        class="badge badge-sm ml-auto shrink-0 {call.status === 'error'
                          ? 'badge-error'
                          : call.status === 'waiting_approval'
                            ? 'badge-warning'
                            : 'badge-ghost'}">{call.status.replace('_', ' ')}</span
                      >
                    </div>
                    {#if call.status === 'waiting_approval'}
                      <AgentApprovalDiff before={call.before} after={call.after} />
                      <div class="p-3 border-t border-base-300 flex justify-end gap-2">
                        <button class="btn btn-sm btn-ghost" onclick={() => decide(call, false)}
                          >Reject</button
                        >
                        <button class="btn btn-sm btn-primary" onclick={() => decide(call, true)}
                          >Approve</button
                        >
                      </div>
                    {:else if call.error}
                      <div class="p-3 text-sm text-error border-t border-base-300">
                        {call.error}
                      </div>
                    {:else if call.result !== undefined}
                      <details class="border-t border-base-300">
                        <summary class="px-3 py-2 cursor-pointer text-xs opacity-70"
                          >Tool result</summary
                        >
                        <pre
                          class="px-3 pb-3 text-xs overflow-auto max-h-64 whitespace-pre-wrap break-words">{pretty(
                            call.result
                          )}</pre>
                      </details>
                    {/if}
                  </div>
                {/each}
              {/if}
            {/each}
            {#if $activeAgentSession.status === 'running'}
              <div class="flex items-center gap-2 text-sm opacity-60">
                <span
                  class="inline-block w-3 font-mono text-primary text-base leading-none"
                  aria-hidden="true">{spinnerFrames[spinnerFrameIndex]}</span
                >
                <span>Agent is working</span>
                <span class="tabular-nums" aria-label={`Elapsed time ${elapsedTime}`}
                  >{elapsedTime}</span
                >
              </div>
            {/if}
            {#if $activeAgentSession.error}
              <div class="alert alert-error text-sm">{$activeAgentSession.error}</div>
            {/if}
          </div>
        {/if}
      </div>

      <footer class="p-4 border-t border-base-300 bg-base-100 shrink-0">
        <div class="max-w-4xl mx-auto flex items-center gap-2">
          <textarea
            class="agent-input textarea textarea-bordered grow min-h-12 max-h-36 resize-none overflow-y-auto"
            rows="1"
            bind:value={input}
            onkeydown={handleKeydown}
            placeholder={$activeAgentSession.mode === 'planning'
              ? 'Describe what you want planned...'
              : 'Ask the agent...'}
            disabled={running}
          ></textarea>
          {#if running}
            <button
              class="btn btn-square btn-error"
              onclick={cancelAgentRun}
              title="Stop run"
              aria-label="Stop run"
            >
              <span class="material-symbols-outlined">stop</span>
            </button>
          {:else}
            <button
              class="btn btn-square btn-primary"
              onclick={submit}
              disabled={!input.trim()}
              title="Send"
              aria-label="Send"
            >
              <span class="material-symbols-outlined">arrow_upward</span>
            </button>
          {/if}
        </div>
      </footer>
    </section>
  {/if}
</div>

<style>
  .agent-input {
    field-sizing: content;
  }
</style>
