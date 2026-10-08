<script lang="ts">
  import type { ModelCapabilities } from '@ayayaq/vivi/providers/models'
  import type { AppSettings } from '../types/types'
  import { onMount, tick } from 'svelte'
  import ModelPicker from './ModelPicker.svelte'
  import AgentApprovalDiff from './AgentApprovalDiff.svelte'
  import AgentValidationReport from './AgentValidationReport.svelte'
  import AgentRunSummary from './AgentRunSummary.svelte'
  import AgentSkillsPanel from './AgentSkillsPanel.svelte'
  import { renderMarkdown } from '../utils/markdown'
  import { agentToolLabel } from '../utils/agentToolLabel'
  import {
    agentProtocol,
    type AiModelInfo,
    type SelectedModelCapabilitySnapshot
  } from '../../../shared/aiModelTypes'
  import {
    currentSelectedCapabilities,
    reasoningChoices,
    reasoningConfigurationError,
    reasoningCapabilityLabel,
    ModelCatalogRequestGate,
    catalogSettingsMatch,
    modelCapabilitySnapshotMatches
  } from '../utils/aiModelCapabilities'
  import { settingsStore } from '../stores/settings'
  import type {
    AgentMode,
    AgentPlanDecision,
    AgentToolCall,
    AgentReasoningEffort
  } from '../../../shared/agentTypes'
  import {
    activeAgentSession,
    activeAgentProgress,
    agentSessions,
    cancelAgentRun,
    createAgentSession,
    deleteAgentSession,
    initializeAgentSessions,
    resolveAgentApproval,
    resolveAgentPlan,
    selectAgentSession,
    sendAgentMessage,
    updateAgentSession,
    enrollAgentAutoReview,
    inspectAgentAutoReviewAudit
  } from '../stores/agent'
  import {
    AUTO_REVIEW_DISCLOSURE,
    AUTO_REVIEW_POLICY_REVISION,
    autoReviewReasonLabel
  } from '../../../shared/agentAutoReview'
  import type { AgentDecisionAuditInspection } from '../../../shared/agentAutoReview'

  let input = $state('')
  let inputElement: HTMLTextAreaElement = $state()
  let messagesElement: HTMLDivElement = $state()
  let models: AiModelInfo[] = $state([])
  const catalogGate = new ModelCatalogRequestGate()
  const selectedGate = new ModelCatalogRequestGate()
  let selectedCapabilities: ModelCapabilities | undefined = $state()
  let selectedCapabilityError = $state('')
  let selectedExpiresAt: number | undefined = $state()
  let capabilityExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let catalogExpiryTimer: ReturnType<typeof setTimeout> | undefined
  let loadingModels = $state(false)
  let modelError = $state('')
  let currentTime = $state(Date.now())
  let spinnerFrameIndex = $state(0)
  let resolvingPlan = $state(false)
  let planActionError = $state('')
  let planActionErrorSessionId = $state('')
  let enrollmentIntent = $state<{
    sessionId: string
    forPlan: boolean
    planId?: string
    provider: 'openai' | 'openrouter'
    accountRevision?: string
  } | null>(null)
  let enrollmentAcknowledged = $state(false)
  let enrollmentBusy = $state(false)
  let enrollmentError = $state('')
  let auditInspection = $state<AgentDecisionAuditInspection | undefined>()
  let auditAcknowledged = $state(false)
  $effect(() => {
    if (enrollmentIntent && (enrollmentIntent.sessionId !== $activeAgentSession?.id || running)) {
      enrollmentIntent = null
      enrollmentAcknowledged = false
    }
  })

  const capabilities = $derived(
    currentSelectedCapabilities(
      selectedCapabilities,
      $settingsStore.aiProvider || 'openai',
      agentProtocol($settingsStore.aiProvider || 'openai'),
      $activeAgentSession?.model || '',
      selectedExpiresAt,
      currentTime
    )
  )
  $effect(() => {
    const model = $activeAgentSession?.model
    const settings = $settingsStore
    // Refetch the pure selected snapshot after a host catalog refresh updates cache metadata.
    models
    if (model) void refreshSelectedCapabilities(model, settings)
    else {
      selectedGate.invalidate()
      clearTimeout(capabilityExpiryTimer)
      selectedCapabilities = undefined
    }
  })

  async function refreshSelectedCapabilities(model: string, settings: AppSettings) {
    const request = selectedGate.begin()
    clearTimeout(capabilityExpiryTimer)
    selectedCapabilities = undefined
    selectedExpiresAt = undefined
    selectedCapabilityError = ''
    const provider = settings.aiProvider || 'openai'
    try {
      const result = (await window.electron.ipcRenderer.invoke('get-ai-model-capabilities', {
        model,
        provider,
        purpose: 'agent'
      })) as SelectedModelCapabilitySnapshot
      if (
        selectedGate.current(request) &&
        $activeAgentSession?.model === model &&
        catalogSettingsMatch(settings, $settingsStore) &&
        modelCapabilitySnapshotMatches(
          result.capabilities,
          provider,
          agentProtocol(provider),
          model
        )
      ) {
        selectedCapabilities = result.capabilities
        selectedExpiresAt = result.expiresAt
        if (result.expiresAt !== undefined && Number.isFinite(result.expiresAt))
          capabilityExpiryTimer = setTimeout(
            () => {
              if (!(
                selectedGate.current(request) &&
                $activeAgentSession?.model === model &&
                catalogSettingsMatch(settings, $settingsStore)
              ))
                return
              selectedGate.invalidate()
              selectedCapabilities = undefined
              models = []
              void refreshSelectedCapabilities(model, $settingsStore)
            },
            Math.max(0, result.expiresAt - Date.now())
          )
      }
    } catch (error) {
      if (selectedGate.current(request))
        selectedCapabilityError =
          error instanceof Error ? error.message : 'Selected model capabilities unavailable'
    }
  }

  const choices = $derived(reasoningChoices(capabilities))
  const reasoningError = $derived(
    reasoningConfigurationError(capabilities, $activeAgentSession?.reasoningEffort || 'none')
  )
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  const running = $derived(
    $activeAgentSession?.status === 'running' || $activeAgentSession?.status === 'waiting_approval'
  )
  const awaitingPlanDecision = $derived(
    $activeAgentSession?.planReady === true &&
      $activeAgentSession.mode === 'planning' &&
      $activeAgentSession.status === 'completed'
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
    let provider: string | undefined
    let key: string | undefined
    const unsubscribeSettings = settingsStore.subscribe((settings) => {
      const nextProvider = settings.aiProvider || 'openai'
      const nextKey =
        nextProvider === 'openrouter' ? settings.openrouterApiKey : settings.openaiApiKey
      if (provider === nextProvider && key === nextKey) return
      provider = nextProvider
      key = nextKey
      catalogGate.invalidate()
      selectedGate.invalidate()
      selectedCapabilities = undefined
      models = []
      void refreshModels()
    })
    return () => {
      catalogGate.invalidate()
      selectedGate.invalidate()
      clearTimeout(capabilityExpiryTimer)
      clearTimeout(catalogExpiryTimer)
      unsubscribeSettings()
    }
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

  function scheduleCatalogExpiry(result: AiModelInfo[], request: number) {
    clearTimeout(catalogExpiryTimer)
    const expiries = result
      .map((model) => model.capabilityExpiresAt)
      .filter((at): at is number => Number.isFinite(at))
    if (!expiries.length) return
    catalogExpiryTimer = setTimeout(
      () => {
        if (!catalogGate.current(request)) return
        catalogGate.invalidate()
        models = []
        loadingModels = false
        modelError = 'Provider catalog metadata expired. Refresh the model catalog.'
        selectedGate.invalidate()
        selectedCapabilities = undefined
        if ($activeAgentSession)
          void refreshSelectedCapabilities($activeAgentSession.model, $settingsStore)
      },
      Math.max(0, Math.min(...expiries) - Date.now())
    )
  }

  async function refreshModels() {
    const request = catalogGate.begin()
    clearTimeout(catalogExpiryTimer)
    loadingModels = true
    models = []
    modelError = ''
    try {
      const result = await window.electron.ipcRenderer.invoke('fetch-ai-models', {
        purpose: 'agent'
      })
      if (catalogGate.current(request)) {
        models = result
        scheduleCatalogExpiry(result, request)
      }
    } catch (error) {
      if (catalogGate.current(request))
        modelError = error instanceof Error ? error.message : String(error)
    } finally {
      if (catalogGate.current(request)) loadingModels = false
    }
  }

  function updateReasoningChoice(event: Event) {
    if (!$activeAgentSession) return
    const value = (event.currentTarget as HTMLSelectElement).value as AgentReasoningEffort
    const current = currentSelectedCapabilities(
      selectedCapabilities,
      $settingsStore.aiProvider || 'openai',
      agentProtocol($settingsStore.aiProvider || 'openai'),
      $activeAgentSession.model,
      selectedExpiresAt
    )
    const error = reasoningConfigurationError(current, value)
    if (error) {
      selectedCapabilityError = error
      void refreshSelectedCapabilities($activeAgentSession.model, $settingsStore)
      return
    }
    void updateAgentSession($activeAgentSession.id, { reasoningEffort: value })
  }

  async function submit() {
    if (!input.trim() || running || awaitingPlanDecision || resolvingPlan || !$activeAgentSession)
      return
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
    if (!$activeAgentSession) return
    if (mode === 'auto') {
      beginEnrollment(false)
      return
    }
    enrollmentIntent = null
    await updateAgentSession($activeAgentSession.id, { mode })
  }

  function beginEnrollment(forPlan: boolean) {
    if (!$activeAgentSession || running) return
    const plan = [...$activeAgentSession.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    enrollmentIntent = {
      sessionId: $activeAgentSession.id,
      forPlan,
      ...(forPlan && plan ? { planId: plan.id } : {}),
      provider: $settingsStore.aiProvider || 'openai',
      accountRevision: $settingsStore.agentDecisionAccountRevision
    }
    enrollmentAcknowledged = false
    enrollmentError = ''
    auditInspection = undefined
    auditAcknowledged = false
  }

  async function inspectAudit() {
    const intent = enrollmentIntent
    if (!intent || enrollmentBusy) return
    enrollmentBusy = true
    enrollmentError = ''
    auditAcknowledged = false
    try {
      const inspected = await inspectAgentAutoReviewAudit(intent.sessionId)
      if (enrollmentIntent !== intent || $activeAgentSession?.id !== intent.sessionId) return
      if (
        inspected.provider !== intent.provider ||
        inspected.accountRevision !== intent.accountRevision ||
        inspected.policyRevision !== AUTO_REVIEW_POLICY_REVISION
      )
        throw new Error('Selected review account changed; reopen Auto review')
      auditInspection = inspected
    } catch (error) {
      enrollmentError = error instanceof Error ? error.message : 'Audit inspection failed'
    } finally {
      enrollmentBusy = false
    }
  }

  async function confirmEnrollment() {
    const intent = enrollmentIntent
    if (
      !intent ||
      !enrollmentAcknowledged ||
      (auditInspection?.rows.length && (!auditInspection.canAcknowledge || !auditAcknowledged)) ||
      enrollmentBusy ||
      intent.sessionId !== $activeAgentSession?.id
    )
      return
    enrollmentBusy = true
    try {
      await enrollAgentAutoReview(
        intent.sessionId,
        {
          provider: intent.provider,
          accountRevision: intent.accountRevision,
          ...(auditInspection?.rows.length && auditAcknowledged
            ? { recoveryInspectionId: auditInspection.id }
            : {})
        },
        !intent.forPlan
      )
      enrollmentIntent = null
      if ($activeAgentSession?.id !== intent.sessionId) return
      if (intent.forPlan) await handlePlanDecision('auto', intent.planId)
    } catch (error) {
      enrollmentError = error instanceof Error ? error.message : 'Auto review enrollment failed'
    } finally {
      enrollmentBusy = false
    }
  }

  async function handlePlanDecision(decision: AgentPlanDecision, acceptedPlanId?: string) {
    if (!$activeAgentSession || !awaitingPlanDecision || resolvingPlan) return
    if (decision === 'auto' && acceptedPlanId === undefined) {
      beginEnrollment(true)
      return
    }
    const sessionId = $activeAgentSession.id
    resolvingPlan = true
    planActionError = ''
    planActionErrorSessionId = ''
    try {
      const planId =
        acceptedPlanId ??
        [...$activeAgentSession.messages].reverse().find((message) => message.role === 'assistant')
          ?.id
      await resolveAgentPlan(decision, planId)
      await tick()
      if (decision === 'continue') inputElement?.focus()
      else scrollToBottom()
    } catch (error) {
      planActionError = error instanceof Error ? error.message : String(error)
      planActionErrorSessionId = sessionId
    } finally {
      resolvingPlan = false
    }
  }

  async function closeSession(event: MouseEvent, sessionId: string) {
    event.stopPropagation()
    await deleteAgentSession(sessionId)
    if ($agentSessions.sessions.length === 0) await createAgentSession()
  }

  async function decide(call: AgentToolCall, approved: boolean) {
    await resolveAgentApproval(call.id, approved, call.approvalId)
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
    <AgentSkillsPanel />
  </aside>

  {#if $activeAgentSession}
    <section class="grow min-w-0 flex flex-col min-h-0">
      <header class="h-14 px-4 border-b border-base-300 flex items-center gap-3 shrink-0">
        <div class="join shrink-0" aria-label="Agent execution mode">
          {#each [['manual', 'Manual'], ['auto', 'Auto review'], ['planning', 'Planning']] as option}
            <button
              class="btn btn-sm join-item {$activeAgentSession.mode === option[0]
                ? 'btn-primary'
                : 'btn-ghost'}"
              onclick={() => setMode(option[0] as AgentMode)}
              disabled={running || resolvingPlan || enrollmentBusy}>{option[1]}</button
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
            disabled={running || resolvingPlan || enrollmentBusy}
          />
        </div>
        <select
          class="select select-bordered select-sm w-28"
          value={$activeAgentSession.reasoningEffort}
          disabled={running || resolvingPlan || enrollmentBusy}
          onchange={updateReasoningChoice}
          aria-label="Reasoning effort"
        >
          {#if reasoningError}
            <option value={$activeAgentSession.reasoningEffort}>Saved choice (unavailable)</option>
          {/if}
          {#each choices as choice}
            <option value={choice.value}>{choice.label}</option>
          {/each}
        </select>
        <div class="ml-auto text-xs opacity-60 tabular-nums">
          {$activeAgentSession.tokenCount.toLocaleString()} tokens
        </div>
      </header>

      <div class="px-4 py-2 text-xs border-b border-base-300" aria-live="polite">
        {reasoningCapabilityLabel(capabilities)} · Tools {capabilities?.tools || 'unknown'}
        {#if !models.some((model) => model.id === $activeAgentSession.model)}
          · Catalog membership and account access unverified{/if}
        {#if !capabilities || capabilities.chat === 'unknown'}
          · Text conversation capability unknown{/if}
        {#if capabilities?.stream === 'unsupported'}
          · Streaming unavailable; using non-stream transport{/if}
        {#if selectedCapabilityError}<div class="text-warning mt-1">
            {selectedCapabilityError}
          </div>{/if}
        {#if reasoningError}<div class="text-warning mt-1">{reasoningError}</div>{/if}
      </div>
      <div class="grow overflow-y-auto px-5 py-4" bind:this={messagesElement}>
        {#if $activeAgentSession.messages.length === 0}
          <div class="h-full flex items-center justify-center text-base-content/50">
            <span class="material-symbols-outlined text-3xl mr-3">terminal</span>
            <span>
              {#if capabilities?.chat === 'unsupported'}
                Choose a model that supports text conversation through this API.
              {:else if capabilities?.tools === 'supported'}
                Ask the agent to inspect or change your bot.
              {:else}
                Tool support is unverified or unsupported. Try a text conversation with
                provider-default reasoning.
              {/if}
            </span>
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
                            : 'badge-ghost'}"
                        >{call.status === 'reviewing'
                          ? 'Reviewing change'
                          : call.status.replace('_', ' ')}</span
                      >
                    </div>
                    {#if call.decision}
                      <div class="p-3 border-t border-base-300 text-xs space-y-1">
                        <div>
                          {call.decision.source === 'automatic'
                            ? 'Automatic approval'
                            : call.decision.source === 'human_once'
                              ? 'Human approved once'
                              : call.decision.source === 'human_rejected'
                                ? 'Human rejected'
                                : call.decision.recommendation === 'deny'
                                  ? 'AI recommends rejecting; manual approval is available'
                                  : 'Needs your review'}: {call.decision.reasonCode}
                        </div>
                        <div>
                          Policy {call.decision.policyRevision}{call.decision.model
                            ? ` · ${call.decision.provider}/${call.decision.model}`
                            : ''}
                        </div>
                        <div>{autoReviewReasonLabel(call.decision.reasonCode)}</div>
                        {#if call.decision.usage}
                          <div>
                            Judge usage (separate): {call.decision.usage.inputTokens} input / {call
                              .decision.usage.outputTokens} output{call.decision.usage.costUsd ===
                            undefined
                              ? ''
                              : ` · $${call.decision.usage.costUsd.toFixed(6)} reported`}
                          </div>
                        {/if}
                        {#if call.decision.checks?.length}
                          <details>
                            <summary class="cursor-pointer">Review estimates (uncalibrated)</summary
                            >
                            {#each call.decision.checks as check}<div>
                                {check.name}: {check.probability}
                              </div>{/each}
                          </details>
                        {/if}
                        {#if call.decision.auditUncertain}<div class="text-warning">
                            The change outcome is shown above; durability or audit settlement is
                            uncertain. Further automatic writes are suspended.
                          </div>{/if}
                      </div>
                    {/if}
                    {#if call.validation}
                      <AgentValidationReport
                        report={call.validation}
                        binding={call.validationBinding}
                        candidate={call.after}
                      />
                    {/if}
                    {#if call.status === 'waiting_approval'}
                      <AgentApprovalDiff before={call.before} after={call.after} />
                      <div class="p-3 border-t border-base-300 flex justify-end gap-2">
                        <button class="btn btn-sm btn-ghost" onclick={() => decide(call, false)}
                          >Reject</button
                        >
                        <button class="btn btn-sm btn-primary" onclick={() => decide(call, true)}
                          >Approve once</button
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
            {#if $activeAgentProgress}
              <div
                class="rounded-box bg-base-200 p-4 text-sm whitespace-pre-wrap break-words"
                aria-live="polite"
                aria-label="Agent response in progress"
              >
                {$activeAgentProgress}
              </div>
            {/if}
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
            {#if $activeAgentSession.lastRunMetrics}
              <AgentRunSummary metrics={$activeAgentSession.lastRunMetrics} />
            {/if}
          </div>
        {/if}
      </div>

      <footer class="p-4 border-t border-base-300 bg-base-100 shrink-0">
        <div class="max-w-4xl mx-auto space-y-3">
          {#if $activeAgentSession.autoReviewMigrationRequired}
            <div class="alert alert-info text-sm">
              Auto review needs a current acknowledgment or local audit recovery. This session is in
              Manual. Choose Auto review to inspect current audit revisions and acknowledge its
              scope.
            </div>
          {/if}
          {#if $activeAgentSession.mode === 'auto'}
            <div class="text-xs opacity-70">
              Auto review uses {($settingsStore.aiProvider || 'openai') === 'openai'
                ? 'OpenAI gpt-6-luna'
                : 'OpenRouter / TypeSafe typesafe/jev-1.13'} for eligible changes. Saved commands change
              the live bot. Excluded changes still require manual approval.
            </div>
          {/if}
          {#if enrollmentIntent}
            <div
              class="border border-base-300 rounded-md p-3 space-y-3"
              aria-label="Auto review enrollment"
            >
              <div class="text-sm font-semibold">
                {enrollmentIntent.forPlan
                  ? 'Implement this plan with Auto review'
                  : 'Enable Auto review'}
              </div>
              <p class="text-sm">{AUTO_REVIEW_DISCLOSURE}</p>
              <div class="text-xs">
                Policy {AUTO_REVIEW_POLICY_REVISION}. Selected provider: {enrollmentIntent.provider}
              </div>
              <label class="flex gap-2 items-start text-sm"
                ><input
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  bind:checked={enrollmentAcknowledged}
                  disabled={enrollmentBusy}
                />I consent to the disclosed data sharing and bounded review flow for this session</label
              >
              {#if enrollmentError}<div class="text-error text-sm">{enrollmentError}</div>{/if}
              <button
                class="btn btn-sm btn-outline"
                disabled={enrollmentBusy}
                onclick={inspectAudit}>Inspect current audit resource revisions</button
              >
              {#if auditInspection}
                {#if auditInspection.rows.length === 0}
                  <div class="text-xs">No unknown audit outcomes need reconciliation</div>
                {:else}
                  <div class="border border-base-300 rounded-md p-3 space-y-2 text-xs">
                    <div class="font-semibold">Earlier outcomes are unknown</div>
                    <div>
                      These current metadata and revisions do not prove whether the earlier changes
                      committed. No resource contents are shown. Acknowledgment permits only fresh
                      future actions; no stored approval will run.
                    </div>
                    {#each auditInspection.rows as row}
                      <div class="break-all">
                        {row.tool} · {row.targetType || 'unbound target'}
                        {row.targetId || ''}<br />Current resource: {row.currentResourceRevision ||
                          'unavailable'}<br />Current target: {row.currentTargetRevision ===
                        undefined
                          ? 'unavailable'
                          : row.currentTargetRevision === null
                            ? 'absent'
                            : row.currentTargetRevision} · Proposed revision: {row.candidateRevision ||
                          'unavailable'} · Outcome: unknown
                      </div>
                    {/each}
                    {#if auditInspection.canAcknowledge}
                      <label class="flex gap-2 items-start"
                        ><input
                          type="checkbox"
                          class="checkbox checkbox-sm"
                          bind:checked={auditAcknowledged}
                          disabled={enrollmentBusy}
                        />I inspected these current revisions and acknowledge the unknown outcomes
                        before enabling fresh Auto review</label
                      >
                    {:else}<div class="text-warning">
                        {auditInspection.reasonCode}: resource binding or storage recovery is
                        required. Keep using Manual.
                      </div>{/if}
                  </div>
                {/if}
              {/if}
              <div class="flex gap-2 justify-end">
                <button
                  class="btn btn-sm btn-ghost"
                  disabled={enrollmentBusy}
                  onclick={() => {
                    enrollmentIntent = null
                    enrollmentAcknowledged = false
                  }}>Cancel</button
                >
                <button
                  class="btn btn-sm btn-primary"
                  disabled={!enrollmentAcknowledged ||
                    enrollmentBusy ||
                    (!!auditInspection?.rows.length &&
                      (!auditInspection.canAcknowledge || !auditAcknowledged))}
                  onclick={confirmEnrollment}
                  >{enrollmentIntent.forPlan
                    ? 'Acknowledge and implement'
                    : 'Acknowledge and enable'}</button
                >
              </div>
            </div>
          {/if}
          {#if awaitingPlanDecision}
            <div class="border border-base-300 rounded-md bg-base-200 p-3">
              <div class="text-sm font-semibold mb-3">Plan ready to implement</div>
              <div class="flex flex-wrap gap-2">
                <button
                  class="btn btn-sm btn-primary"
                  onclick={() => handlePlanDecision('auto')}
                  disabled={resolvingPlan || enrollmentBusy}>Implement with Auto review</button
                >
                <button
                  class="btn btn-sm btn-outline"
                  onclick={() => handlePlanDecision('manual')}
                  disabled={resolvingPlan || enrollmentBusy}>Implement in Manual</button
                >
                <button
                  class="btn btn-sm btn-ghost"
                  onclick={() => handlePlanDecision('continue')}
                  disabled={resolvingPlan || enrollmentBusy}>Continue Planning</button
                >
              </div>
            </div>
          {/if}
          {#if planActionError && planActionErrorSessionId === $activeAgentSession.id}
            <div class="alert alert-error text-sm">{planActionError}</div>
          {/if}
          <div class="flex items-center gap-2">
            <textarea
              class="agent-input textarea textarea-bordered grow min-h-12 max-h-36 resize-none overflow-y-auto"
              rows="1"
              bind:this={inputElement}
              bind:value={input}
              onkeydown={handleKeydown}
              placeholder={awaitingPlanDecision
                ? 'Choose how to proceed with the completed plan...'
                : $activeAgentSession.mode === 'planning'
                  ? 'Describe what you want planned...'
                  : 'Ask the agent...'}
              disabled={running || awaitingPlanDecision || resolvingPlan || enrollmentBusy}
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
                disabled={!input.trim() || awaitingPlanDecision || resolvingPlan || enrollmentBusy}
                title="Send"
                aria-label="Send"
              >
                <span class="material-symbols-outlined">arrow_upward</span>
              </button>
            {/if}
          </div>
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
