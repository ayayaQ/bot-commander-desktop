<script lang="ts">
  import type { ModelCapabilities } from '@ayayaq/vivi/providers/models'
  import { agentContextLabel, agentContextTooltip } from '../../../shared/agentContext'
  import type { AppSettings } from '../types/types'
  import { onMount, tick } from 'svelte'
  import ModelPicker from './ModelPicker.svelte'
  import AgentApprovalDiff from './AgentApprovalDiff.svelte'
  import AgentValidationReport from './AgentValidationReport.svelte'
  import AgentRunSummary from './AgentRunSummary.svelte'
  import AgentToolPresentation from './AgentToolPresentation.svelte'
  import AgentToolCard from './AgentToolCard.svelte'
  import { agentToolPresentationInput } from '../utils/agentToolPresentation'
  import AgentSkillsPanel from './AgentSkillsPanel.svelte'
  import { renderMarkdown } from '../utils/markdown'
  import {
    agentProtocol,
    type AiModelInfo,
    type SelectedModelCapabilitySnapshot
  } from '../../../shared/aiModelTypes'
  import {
    currentSelectedCapabilities,
    reasoningChoices,
    reasoningConfigurationError,
    ModelCatalogRequestGate,
    catalogSettingsMatch,
    modelCapabilitySnapshotMatches
  } from '../utils/aiModelCapabilities'
  import { patchSettings, settingsDraftStore, settingsStore } from '../stores/settings'
  import {
    agentDrafts,
    canSubmitAgentDraft,
    setAgentDraft,
    submitAgentDraft
  } from '../stores/agentComposer'
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
    compactAgentSession,
    createAgentSession,
    deleteAgentSession,
    initializeAgentSessions,
    resolveAgentApproval,
    resolveAgentPlan,
    selectAgentSession,
    updateAgentSession,
    enrollAgentAutoReview,
    inspectAgentAutoReviewAudit
  } from '../stores/agent'
  import {
    AUTO_REVIEW_POLICY_REVISION,
    autoReviewReasonLabel
  } from '../../../shared/agentAutoReview'
  import type { AgentDecisionAuditInspection } from '../../../shared/agentAutoReview'
  import { AGENT_WEB_DISCLOSURE, AGENT_WEB_POLICY_REVISION } from '../../../shared/agentWeb'
  import { selectedReviewer } from '../../../shared/providerSelection'

  const defaultSessionsWidth = 208
  const minSessionsWidth = 200
  let panelWidth = $state(0)
  let dragWidth = $state<number | null>(null)
  let resizeStart: { pointerId: number; x: number; width: number } | undefined
  const maxSessionsWidth = $derived(Math.min(480, Math.max(minSessionsWidth, panelWidth - 360)))
  const savedSessionsWidth = $derived(
    Number.isFinite($settingsDraftStore.agentSessionsWidth)
      ? $settingsDraftStore.agentSessionsWidth
      : defaultSessionsWidth
  )
  const sessionsWidth = $derived(clampSessionsWidth(dragWidth ?? savedSessionsWidth))

  function clampSessionsWidth(width: number) {
    return Math.round(Math.min(maxSessionsWidth, Math.max(minSessionsWidth, width)))
  }

  function startSessionsResize(event: PointerEvent) {
    if (event.button !== 0 || resizeStart) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.focus()
    handle.setPointerCapture(event.pointerId)
    resizeStart = { pointerId: event.pointerId, x: event.clientX, width: sessionsWidth }
    dragWidth = sessionsWidth
  }

  function moveSessionsResize(event: PointerEvent) {
    if (resizeStart?.pointerId !== event.pointerId) return
    dragWidth = clampSessionsWidth(resizeStart.width + event.clientX - resizeStart.x)
  }

  function finishSessionsResize(event: PointerEvent) {
    if (resizeStart?.pointerId !== event.pointerId) return
    const width = sessionsWidth
    resizeStart = undefined
    void patchSettings({ agentSessionsWidth: width })
    dragWidth = null
  }

  function resizeSessionsWithKeyboard(event: KeyboardEvent) {
    let width: number
    if (event.key === 'ArrowLeft') width = sessionsWidth - (event.shiftKey ? 40 : 10)
    else if (event.key === 'ArrowRight') width = sessionsWidth + (event.shiftKey ? 40 : 10)
    else if (event.key === 'Home') width = minSessionsWidth
    else if (event.key === 'End') width = maxSessionsWidth
    else return
    event.preventDefault()
    void patchSettings({ agentSessionsWidth: clampSessionsWidth(width) })
  }

  let compactError = $state('')
  let compactBusy = $state(false)
  let compactErrorSessionId = $state('')
  async function compactCurrentContext() {
    const sessionId = $activeAgentSession?.id
    if (!sessionId || compactBusy) return
    compactBusy = true
    compactError = ''
    compactErrorSessionId = sessionId
    try {
      await compactAgentSession()
    } catch {
      compactError = 'Context compaction could not start'
    } finally {
      compactBusy = false
    }
  }

  const draft = $derived($agentDrafts[$activeAgentSession?.id || ''])
  const input = $derived(draft?.content || '')
  const steering = $derived(
    $activeAgentSession?.status === 'running' || $activeAgentSession?.status === 'waiting_approval'
  )
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
  type AutoReviewIntent = {
    sessionId: string
    forPlan: boolean
    planId?: string
    provider: 'openai' | 'openrouter'
    accountRevision?: string
    webAccountRevision?: string
  }
  let enrollmentIntent = $state<AutoReviewIntent | null>(null)
  let enrollmentBusy = $state(false)
  let enrollmentError = $state('')
  let auditInspection = $state<AgentDecisionAuditInspection | undefined>()
  let auditAcknowledged = $state(false)
  const automaticWebEnabled = $derived(
    $settingsStore.webProvider === 'deepseek' &&
      $activeAgentSession?.autoReviewEnrollment?.web?.policyRevision ===
        AGENT_WEB_POLICY_REVISION &&
      $activeAgentSession.autoReviewEnrollment.web.accountRevision ===
        $settingsStore.agentWebAccountRevision
  )
  $effect(() => {
    if (
      enrollmentIntent &&
      (enrollmentIntent.sessionId !== $activeAgentSession?.id ||
        running ||
        enrollmentIntent.provider !== selectedReviewer($settingsStore) ||
        enrollmentIntent.accountRevision !== $settingsStore.agentDecisionAccountRevision ||
        enrollmentIntent.webAccountRevision !==
          ($settingsStore.webProvider === 'deepseek'
            ? $settingsStore.agentWebAccountRevision
            : undefined))
    ) {
      enrollmentIntent = null
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
  let capabilityRequestInputs:
    { model: string; settings: AppSettings; models: AiModelInfo[] } | undefined
  $effect(() => {
    const model = $activeAgentSession?.model
    const settings = $settingsStore
    // Session mode changes and unchanged settings reloads do not invalidate model facts.
    // A new catalog still refreshes the selected snapshot and its expiry metadata.
    const catalog = models
    if (
      capabilityRequestInputs &&
      capabilityRequestInputs.model === model &&
      capabilityRequestInputs.models === catalog &&
      catalogSettingsMatch(capabilityRequestInputs.settings, settings)
    )
      return
    capabilityRequestInputs = { model, settings, models: catalog }
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

  const currentContext = $derived(
    $activeAgentSession?.context?.provider === ($settingsStore.aiProvider || 'openai') &&
      $activeAgentSession.context.model === $activeAgentSession.model
      ? $activeAgentSession.context
      : undefined
  )
  const running = $derived(
    $activeAgentSession?.status === 'running' ||
      $activeAgentSession?.status === 'waiting_approval' ||
      currentContext?.state === 'compacting'
  )
  const awaitingPlanDecision = $derived(
    $activeAgentSession?.planReady === true &&
      $activeAgentSession.mode === 'planning' &&
      $activeAgentSession.status === 'completed'
  )
  const composerUnavailable = $derived(
    !$activeAgentSession || !canSubmitAgentDraft($activeAgentSession) || resolvingPlan
  )
  const composerBlocked = $derived(composerUnavailable || enrollmentBusy)
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
        nextProvider === 'deepseek'
          ? `${Boolean(settings.deepseekKeyConfigured)}:${settings.deepseekChatAccountRevision || ''}`
          : nextProvider === 'openrouter'
            ? settings.openrouterApiKey
            : settings.openaiApiKey
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

  async function submit(mode: 'queue' | 'interrupt' = 'queue') {
    const session = $activeAgentSession
    if (composerBlocked || !session) return
    const sent = await submitAgentDraft(session, mode)
    if (sent && $activeAgentSession?.id === session.id) {
      await tick()
      scrollToBottom()
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
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

  async function setMode(mode: AgentMode) {
    if (!$activeAgentSession || running || enrollmentBusy) return
    if (mode === 'auto') {
      await beginEnrollment(false)
      return
    }
    enrollmentIntent = null
    enrollmentError = ''
    await updateAgentSession($activeAgentSession.id, { mode })
  }

  async function beginEnrollment(forPlan: boolean) {
    if (!$activeAgentSession || running || enrollmentBusy) return
    const provider = selectedReviewer($settingsStore)
    if (!provider) {
      enrollmentError = 'Choose OpenAI or OpenRouter as the Auto reviewer in Settings first.'
      return
    }
    const plan = [...$activeAgentSession.messages]
      .reverse()
      .find((message) => message.role === 'assistant')
    const intent: AutoReviewIntent = {
      sessionId: $activeAgentSession.id,
      forPlan,
      ...(forPlan && plan ? { planId: plan.id } : {}),
      provider,
      accountRevision: $settingsStore.agentDecisionAccountRevision,
      webAccountRevision:
        $settingsStore.webProvider === 'deepseek'
          ? $settingsStore.agentWebAccountRevision
          : undefined
    }
    enrollmentIntent = null
    enrollmentError = ''
    auditInspection = undefined
    auditAcknowledged = false
    enrollmentBusy = true
    try {
      const inspected = await inspectAgentAutoReviewAudit(intent.sessionId)
      if ($activeAgentSession?.id !== intent.sessionId) return
      validateAuditInspection(inspected, intent)
      if (inspected.recoveryRequired !== false) {
        enrollmentIntent = intent
        auditInspection = inspected
        return
      }
      await activateAutoReview(intent)
    } catch (error) {
      enrollmentError = error instanceof Error ? error.message : 'Could not enable Auto review'
    } finally {
      enrollmentBusy = false
    }
  }

  function validateAuditInspection(
    inspected: AgentDecisionAuditInspection,
    intent: AutoReviewIntent
  ) {
    if (
      inspected.provider !== intent.provider ||
      inspected.accountRevision !== intent.accountRevision ||
      inspected.policyRevision !== AUTO_REVIEW_POLICY_REVISION ||
      selectedReviewer($settingsStore) !== intent.provider ||
      $settingsStore.agentDecisionAccountRevision !== intent.accountRevision
    )
      throw new Error('Selected review account changed; select Auto review again')
  }

  async function activateAutoReview(intent: AutoReviewIntent, recoveryInspectionId?: string) {
    const web = $activeAgentSession?.autoReviewEnrollment?.web
    await enrollAgentAutoReview(
      intent.sessionId,
      {
        provider: intent.provider,
        accountRevision: intent.accountRevision,
        ...(web?.policyRevision === AGENT_WEB_POLICY_REVISION &&
        web.accountRevision === intent.webAccountRevision
          ? { web }
          : {}),
        ...(recoveryInspectionId ? { recoveryInspectionId } : {})
      },
      !intent.forPlan
    )
    enrollmentIntent = null
    if ($activeAgentSession?.id !== intent.sessionId) return
    if (intent.forPlan) await handlePlanDecision('auto', intent.planId)
  }

  async function updateAutomaticWeb(event: Event) {
    if (!$activeAgentSession || running || enrollmentBusy) return
    const provider = selectedReviewer($settingsStore)
    if (!provider) return
    const checkbox = event.currentTarget as HTMLInputElement
    const enabled = checkbox.checked
    enrollmentBusy = true
    enrollmentError = ''
    try {
      await enrollAgentAutoReview($activeAgentSession.id, {
        provider,
        accountRevision: $settingsStore.agentDecisionAccountRevision,
        ...(enabled
          ? {
              web: {
                policyRevision: AGENT_WEB_POLICY_REVISION,
                accountRevision: $settingsStore.agentWebAccountRevision
              }
            }
          : {})
      })
    } catch (error) {
      enrollmentError =
        error instanceof Error ? error.message : 'Could not update automatic web requests'
    } finally {
      enrollmentBusy = false
      checkbox.checked = automaticWebEnabled
    }
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
      validateAuditInspection(inspected, intent)
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
      (auditInspection?.rows.length && (!auditInspection.canAcknowledge || !auditAcknowledged)) ||
      enrollmentBusy ||
      intent.sessionId !== $activeAgentSession?.id
    )
      return
    enrollmentBusy = true
    try {
      await activateAutoReview(
        intent,
        auditInspection?.rows.length && auditAcknowledged ? auditInspection.id : undefined
      )
    } catch (error) {
      enrollmentError = error instanceof Error ? error.message : 'Auto review enrollment failed'
    } finally {
      enrollmentBusy = false
    }
  }

  async function handlePlanDecision(decision: AgentPlanDecision, acceptedPlanId?: string) {
    if (!$activeAgentSession || !awaitingPlanDecision || resolvingPlan) return
    if (decision === 'auto' && acceptedPlanId === undefined) {
      await beginEnrollment(true)
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

<div
  class="flex h-full min-h-0 bg-base-100"
  class:resizing-sessions={dragWidth !== null}
  bind:clientWidth={panelWidth}
>
  <aside
    id="agent-sessions"
    class="shrink-0 bg-base-200 flex flex-col min-h-0 min-w-0"
    style:width={`${sessionsWidth}px`}
  >
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
  <!-- A focusable separator is an interactive window splitter with keyboard resizing. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="sessions-resize-handle shrink-0 bg-base-300 hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
    class:active={dragWidth !== null}
    role="separator"
    tabindex="0"
    aria-label="Resize agent sessions"
    aria-orientation="vertical"
    aria-controls="agent-sessions"
    aria-valuemin={minSessionsWidth}
    aria-valuemax={maxSessionsWidth}
    aria-valuenow={sessionsWidth}
    title="Drag to resize agent sessions. Use arrow keys to resize, or double-click to reset."
    onpointerdown={startSessionsResize}
    onpointermove={moveSessionsResize}
    onpointerup={finishSessionsResize}
    onpointercancel={finishSessionsResize}
    onlostpointercapture={finishSessionsResize}
    onkeydown={resizeSessionsWithKeyboard}
    ondblclick={() => patchSettings({ agentSessionsWidth: defaultSessionsWidth })}
  ></div>

  {#if $activeAgentSession}
    <section class="grow min-w-0 flex flex-col min-h-0">
      <header
        class="min-h-14 px-4 py-2 border-b border-base-300 flex flex-wrap items-center gap-3 shrink-0"
        inert={enrollmentBusy}
        aria-busy={enrollmentBusy}
      >
        <div class="join shrink-0" aria-label="Agent execution mode">
          {#each [['manual', 'Manual'], ['auto', 'Auto review'], ['planning', 'Planning']] as option}
            <button
              class="btn btn-sm join-item {$activeAgentSession.mode === option[0]
                ? 'btn-primary'
                : 'btn-ghost'}"
              onclick={() => setMode(option[0] as AgentMode)}
              disabled={running || resolvingPlan}>{option[1]}</button
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
            disabled={running || resolvingPlan}
          />
          {#if selectedCapabilityError}
            <p class="mt-1 text-xs text-warning" role="status">{selectedCapabilityError}</p>
          {/if}
        </div>
        <div class="w-28">
          <select
            class="select select-bordered select-sm w-full"
            value={$activeAgentSession.reasoningEffort}
            disabled={running || resolvingPlan}
            onchange={updateReasoningChoice}
            aria-label="Reasoning effort"
            aria-invalid={reasoningError ? true : undefined}
            aria-describedby={reasoningError ? 'agent-reasoning-error' : undefined}
          >
            {#if reasoningError}
              <option value={$activeAgentSession.reasoningEffort}>Saved choice (unavailable)</option
              >
            {/if}
            {#each choices as choice}
              <option value={choice.value}>{choice.label}</option>
            {/each}
          </select>
          {#if reasoningError}
            <p id="agent-reasoning-error" class="mt-1 text-xs text-warning" role="status">
              {reasoningError}
            </p>
          {/if}
        </div>
        <div class="ml-auto shrink-0 flex items-center gap-2 text-xs tabular-nums">
          <span
            class="opacity-60"
            title={agentContextTooltip(currentContext, {
              execution: $activeAgentSession.tokenCount,
              summary: $activeAgentSession.compactionUsage?.totalTokens,
              summaryIncomplete: $activeAgentSession.compactionUsageIncomplete
            })}
          >
            {agentContextLabel(
              $activeAgentSession.context,
              $settingsStore.aiProvider || 'openai',
              $activeAgentSession.model,
              capabilities?.contextWindow
            )}
          </span>
          <button
            class="btn btn-ghost btn-xs"
            onclick={compactCurrentContext}
            disabled={running ||
              compactBusy ||
              resolvingPlan ||
              !$activeAgentSession.history?.length}
            title="Summarize older context while retaining the original conversation. Uses the selected model and may incur provider charges."
            >Compact</button
          >
        </div>
      </header>

      {#if compactError && compactErrorSessionId === $activeAgentSession.id}
        <p class="px-4 py-1 text-xs text-error" role="alert">{compactError}</p>
      {/if}
      {#if $activeAgentSession.context?.message && $activeAgentSession.context.provider === ($settingsStore.aiProvider || 'openai') && $activeAgentSession.context.model === $activeAgentSession.model}
        <p class="px-4 py-1 text-xs" role="status">{$activeAgentSession.context.message}</p>
      {/if}
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
                  {@const presentation = agentToolPresentationInput(
                    call,
                    $activeAgentSession.id,
                    message.id
                  )}
                  <AgentToolCard {call}>
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
                        suite={call.arguments.validation as
                          | import('../../../shared/agentValidationTypes').AgentValidationSuite
                          | undefined}
                      />
                    {/if}
                    {#if call.status === 'waiting_approval'}
                      {#if call.mcp}
                        <pre
                          class="p-3 text-xs whitespace-pre-wrap break-words max-h-80 overflow-auto">{call
                            .mcp.disclosure}</pre>
                      {:else}
                        <AgentApprovalDiff before={call.before} after={call.after} />
                      {/if}
                      <div class="p-3 border-t border-base-300 flex justify-end gap-2">
                        <button class="btn btn-sm btn-ghost" onclick={() => decide(call, false)}
                          >Reject</button
                        >
                        <button class="btn btn-sm btn-primary" onclick={() => decide(call, true)}
                          >Approve once</button
                        >
                      </div>
                    {:else if call.error}
                      <div
                        class="p-3 text-sm text-error border-t border-base-300 whitespace-pre-wrap break-all max-h-64 overflow-auto"
                      >
                        {call.error}
                      </div>
                    {/if}
                    <AgentToolPresentation
                      encoded={presentation.encoded}
                      fallback={presentation.fallback}
                    />
                  </AgentToolCard>
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
                {#if $activeAgentSession.context?.state !== 'compacting'}
                  <span class="tabular-nums" aria-label={`Elapsed time ${elapsedTime}`}
                    >{elapsedTime}</span
                  >
                {/if}
              </div>
            {/if}
            {#if $activeAgentSession.error}
              <div class="alert alert-error text-sm">{$activeAgentSession.error}</div>
            {/if}
          </div>
        {/if}
      </div>

      <footer class="p-4 border-t border-base-300 bg-base-100 shrink-0">
        <div class="max-w-4xl mx-auto space-y-3">
          {#if $activeAgentSession.lastRunMetrics}
            {#key $activeAgentSession.id}
              <AgentRunSummary metrics={$activeAgentSession.lastRunMetrics} />
            {/key}
          {/if}
          {#if $activeAgentSession.autoReviewMigrationRequired}
            <div class="alert alert-info text-sm">
              This session is in Manual. Select Auto review to enable it with the current account
              and check whether any interrupted changes need recovery.
            </div>
          {/if}
          {#if $activeAgentSession.mode === 'auto' && $settingsStore.webProvider === 'deepseek'}
            <label
              class="flex gap-2 items-center text-xs"
              title={AGENT_WEB_DISCLOSURE}
              inert={enrollmentBusy}
            >
              <input
                type="checkbox"
                class="checkbox checkbox-sm"
                checked={automaticWebEnabled}
                onchange={updateAutomaticWeb}
                disabled={running || !$settingsStore.agentWebAccountRevision}
              />
              Allow automatic DeepSeek web requests (may incur charges)
            </label>
          {/if}
          {#if enrollmentError && !enrollmentIntent}
            <div class="text-error text-sm" role="alert">{enrollmentError}</div>
          {/if}
          {#if enrollmentIntent}
            <div
              class="border border-base-300 rounded-md p-3 space-y-3"
              aria-label="Auto review recovery"
            >
              <div class="text-sm font-semibold">Recover Auto review</div>
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
                  }}>Cancel</button
                >
                <button
                  class="btn btn-sm btn-primary"
                  disabled={enrollmentBusy ||
                    (!!auditInspection?.rows.length &&
                      (!auditInspection.canAcknowledge || !auditAcknowledged))}
                  onclick={confirmEnrollment}
                  >{enrollmentIntent.forPlan
                    ? 'Recover and implement'
                    : 'Recover and enable'}</button
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
          {#if $activeAgentSession.pendingInputs?.length}
            <div class="rounded-md border border-base-300 bg-base-200 p-3 text-sm">
              <div class="font-semibold">
                Pending messages ({$activeAgentSession.pendingInputs.length})
              </div>
              <ol class="list-decimal pl-5 max-h-40 overflow-y-auto">
                {#each $activeAgentSession.pendingInputs as pending (pending.id)}
                  <li class="whitespace-pre-wrap break-words">{pending.content}</li>
                {/each}
              </ol>
              <p class="mt-2 text-xs opacity-70">
                Queued messages are delivered at a safe boundary. If the run ends first, they stay
                pending for the next run.
              </p>
            </div>
          {/if}
          {#if draft?.error}
            <div class="alert alert-error text-sm" role="alert">{draft.error}</div>
          {/if}
          {#if steering}
            <p class="text-xs opacity-70">
              Queue waits for a safe boundary. Interrupt and send requests cancellation, waits for
              cleanup, then delivers pending messages. Stop cancels without starting another run.
              Cancellation does not undo completed actions.
            </p>
          {/if}
          <div class="flex flex-wrap items-center gap-2">
            <textarea
              class="agent-input textarea textarea-bordered grow min-h-12 max-h-36 resize-none overflow-y-auto"
              rows="1"
              bind:this={inputElement}
              value={input}
              oninput={(event) => {
                if ($activeAgentSession)
                  setAgentDraft($activeAgentSession.id, event.currentTarget.value)
              }}
              onkeydown={handleKeydown}
              placeholder={steering
                ? 'Add guidance while the agent works...'
                : awaitingPlanDecision
                  ? 'Choose how to proceed with the completed plan...'
                  : $activeAgentSession.mode === 'planning'
                    ? 'Describe what you want planned...'
                    : 'Ask the agent...'}
              disabled={awaitingPlanDecision || resolvingPlan}
              aria-label="Message the agent"></textarea>
            {#if steering}
              <button
                class="btn btn-primary"
                onclick={() => submit('queue')}
                disabled={!input.trim() || composerUnavailable || draft?.submitting}
                inert={enrollmentBusy}>Queue</button
              >
              <button
                class="btn btn-outline"
                onclick={() => submit('interrupt')}
                disabled={!input.trim() || composerUnavailable || draft?.submitting}
                inert={enrollmentBusy}>Interrupt and send</button
              >
            {/if}
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
                onclick={() => submit()}
                disabled={!input.trim() || composerUnavailable || draft?.submitting}
                inert={enrollmentBusy}
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
  .sessions-resize-handle {
    position: relative;
    width: 1px;
    cursor: col-resize;
    touch-action: none;
  }

  .sessions-resize-handle::after {
    content: '';
    position: absolute;
    inset: 0 -4px;
    z-index: 10;
  }

  .sessions-resize-handle.active {
    background: var(--color-primary);
  }

  .resizing-sessions {
    user-select: none;
  }

  .resizing-sessions :global(*) {
    cursor: col-resize !important;
  }

  .agent-input {
    field-sizing: content;
  }
</style>
