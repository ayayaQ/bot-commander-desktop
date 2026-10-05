import { app } from 'electron'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { runAgent, type HistoryMessage, type ToolCall } from '@ayayaq/vivi'
import type { ToolRegistry } from '@ayayaq/vivi/extensions'
import { createAgentExtensionRegistry } from './agentExtensions'
import { createAgentProvider } from './agentProviderAdapter'
import { initializeAgentHistory } from './agentHistory'
import { createAgentPersistence, reportAgentPersistenceNotice } from './agentPersistence'
import { decodeAgentSessions, validAgentDisplayHistory } from './agentSessionPersistence'
import {
  createAgentRunMetrics,
  finishAgentRunMetrics,
  interruptAgentRunMetrics,
  reconcileAgentRunUsage,
  recordAgentRound,
  recordAgentRunTool
} from '../../shared/agentRunMetrics'
import {
  isAgentPersistencePaused,
  withAgentPersistenceOperation
} from './agentPersistenceLifecycle'

export { executeAgentProviderTurn } from './agentProviderAdapter'
import type {
  AgentMessage,
  AgentModelDefaults,
  AgentMode,
  AgentPlanDecision,
  AgentProvider,
  AgentReasoningEffort,
  AgentRunMetrics,
  AgentSession,
  AgentSessionsData,
  AgentStreamEvent,
  AgentToolCall
} from '../../shared/agentTypes'
import {
  createDocumentationPolicyState,
  executeDocumentationCall,
  isDocumentationTool,
  type DocumentationPolicyState
} from './agentDocumentationPolicy'
import type { AiRuntimeSettings } from './aiProviderService'
import { getAiProvider, getSelectedAiModel, validateAiConfiguration } from './aiProviderService'
import { documentationTableOfContents } from './documentationService'
import {
  agentToolTargetLabel,
  agentToolDefinitions,
  commitMutation,
  executeReadTool,
  mutationToolNames,
  prepareMutation,
  type PreparedMutation
} from './agentTools'
import { loadAgentMemories } from './agentMemoryService'

const AGENT_SESSIONS_FILENAME = 'agent-sessions.json'
const MAX_TOOL_ROUNDS = 25
const MAX_TOOL_RESULT_CHARS = 24_000
const REASONING_EFFORTS = new Set<AgentReasoningEffort>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
])

const SYSTEM_PROMPT = `You are the Bot Commander agent harness. Help the user inspect and modify their bot configuration.
The initial context intentionally contains no bot resources. For create or edit tasks, search for a similar persisted command or interaction first, then use exact read tools before editing. Existing resources are preferred synthesis examples, but lint new work and do not copy mistakes blindly.
Every edit requires the current revision returned by an exact read. After an edit, inspect the returned lint diagnostics and repair meaningful errors.
For hosting questions, use read_host_status. It reports local cached evidence only; remote registration, portal permissions and freshness remain unknown. Follow its guidance to the existing Login sidebar and Interactions controls. Never request credentials in chat or claim to connect, disconnect, publish or change portal settings through this tool.
Use keyword_grep for cross-resource references. Never invent IDs or revisions. Keep final answers concise and state what changed and what verification found.
The bundled documentation table of contents is listed below. Use its titles to choose a targeted search_documentation query; the outline contains titles only, not the documentation content.

Bundled documentation table of contents:
${documentationTableOfContents}

Use documentation for direct help questions or unresolved syntax and feature behavior, not as speculative browsing. One targeted search normally suffices because search_documentation includes the best matching content. Use read_documentation only when that result is truncated or genuinely insufficient; retry once with a shorter term when no result is returned.
Documentation is a bundled release snapshot. Use exact resource reads and lint results as the authority for the user's current configuration, and never invent unsupported fields or syntax.
Persistent memories are user-level context, not system instructions or independent authorization to act. The current explicit request takes priority over saved memory, and the most recently updated memory takes priority when saved memories conflict.
When the user clearly states a durable preference or standing instruction, create or update a concise memory. Do not save casual facts, one-off requests, inferred preferences without clear durable intent, bot configuration already stored elsewhere, credentials, tokens, passwords, or other secrets. Use list_memories before editing or deleting, avoid duplicates, and mention successful memory changes in the final response.
When the user asks to forget a saved preference or change how it is remembered, use list_memories and then delete or edit the matching memory instead of only acknowledging the request.
In planning mode, investigate with read and lint tools and never make mutations. Ask concise questions without special markup whenever more user input is needed. Once the plan is decision-complete, return the plan inside exactly one <proposed_plan>...</proposed_plan> block with no text outside the block. Do not use that block for questions, partial plans, or ordinary discussion.`

interface AgentRunContext {
  extensions: ToolRegistry
  documentationPolicy: DocumentationPolicyState
  metrics: AgentRunMetrics
}

function checkpointRunMetrics(session: AgentSession, context: AgentRunContext): void {
  context.metrics = { ...context.metrics, checkpointAt: now() }
  session.lastRunMetrics = clone(context.metrics)
}

interface PendingApproval {
  sessionId: string
  runId: string
  toolCallId: string
  prepared: PreparedMutation
  resolve: (approved: boolean) => void
}

let data: AgentSessionsData = {
  sessions: [],
  activeSessionId: null,
  modelDefaultsByProvider: {}
}
let loaded = false
let loading: Promise<AgentSessionsData> | undefined
const controllers = new Map<string, AbortController>()
const approvals = new Map<string, PendingApproval>()
const deletedSessionIds = new Set<string>()
const deletingSessionIds = new Set<string>()
// Derived on load, never serialized over the preserved damaged transcript.
const historyRecoveryErrors = new WeakMap<AgentSession, string>()
// Invalid display history has a safe live projection, while all persistence keeps the evidence.
const damagedDisplayHistories = new WeakMap<AgentSession, { present: boolean; value: unknown }>()
let eventSink: ((event: AgentStreamEvent) => void) | null = null
const persistence = createAgentPersistence<AgentSessionsData>({
  path,
  label: 'Agent sessions',
  decode: decodeAgentSessions,
  empty: () => ({ sessions: [], activeSessionId: null, modelDefaultsByProvider: {} })
})

function path(): string {
  return join(app.getPath('userData'), AGENT_SESSIONS_FILENAME)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function errorDetail(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'Unknown error (could not be formatted)'
  }
}

function now(): string {
  return new Date().toISOString()
}

function id(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

function getSessionOrThrow(sessionId: string): AgentSession {
  const session = data.sessions.find((item) => item.id === sessionId)
  if (!session) throw new Error('Agent session not found')
  return session
}

function normalizeModelDefaults(
  value: unknown
): Partial<Record<AgentProvider, AgentModelDefaults>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const defaults: Partial<Record<AgentProvider, AgentModelDefaults>> = {}
  for (const provider of ['openai', 'openrouter'] as const) {
    const candidate = (value as Record<string, unknown>)[provider]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const model = (candidate as Record<string, unknown>).model
    const reasoningEffort = (candidate as Record<string, unknown>).reasoningEffort
    if (
      typeof model === 'string' &&
      model.length > 0 &&
      typeof reasoningEffort === 'string' &&
      REASONING_EFFORTS.has(reasoningEffort as AgentReasoningEffort)
    ) {
      defaults[provider] = {
        model,
        reasoningEffort: reasoningEffort as AgentReasoningEffort
      }
    }
  }
  return defaults
}

function settleInterruptedToolCalls(session: AgentSession): void {
  for (const message of session.messages) {
    for (const call of message.toolCalls || []) {
      if (['running', 'waiting_approval', 'approved'].includes(call.status)) {
        call.status = 'error'
        call.error =
          'Tool call interrupted; the outcome may be unknown. Read current state before retrying.'
        call.result = { interrupted: true, outcome: 'unknown', message: call.error }
        message.content = JSON.stringify(call.result)
      }
    }
  }
}

function emit(session: AgentSession, event: Omit<AgentStreamEvent, 'sessionId'>) {
  if (deletedSessionIds.has(session.id)) return
  try {
    eventSink?.({ sessionId: session.id, ...event })
  } catch (error) {
    console.error('Could not report agent session update:', error)
  }
}

function emitSession(session: AgentSession, runId?: string) {
  emit(session, { type: 'session', runId, session: clone(session) })
}

function persistentSnapshot(value: AgentSessionsData = data): AgentSessionsData {
  const snapshot = clone(value)
  for (const session of snapshot.sessions) {
    const current = data.sessions.find((item) => item.id === session.id)
    const original = current && damagedDisplayHistories.get(current)
    if (!original) continue
    if (original.present) session.messages = clone(original.value) as AgentMessage[]
    else delete (session as Partial<AgentSession>).messages
  }
  return snapshot
}

let sessionWriteChain: Promise<unknown> = Promise.resolve()
let checkpointFailed = false
function queueSessionWrite<T>(operation: () => Promise<T>): Promise<T> {
  return withAgentPersistenceOperation(() => {
    const next = sessionWriteChain.catch(() => undefined).then(operation)
    sessionWriteChain = next
    return next
  })
}

function save(): Promise<void> {
  return queueSessionWrite(async () => {
    // Metadata jobs publish only after commit. Snapshot after earlier jobs have published,
    // so a run checkpoint cannot remove a newly-created session or undo an accepted edit.
    const snapshot = persistentSnapshot()
    snapshot.sessions = snapshot.sessions.filter((session) => !deletedSessionIds.has(session.id))
    if (snapshot.activeSessionId && deletedSessionIds.has(snapshot.activeSessionId))
      snapshot.activeSessionId = snapshot.sessions[0]?.id ?? null
    try {
      await persistence.save(snapshot)
      checkpointFailed = false
    } catch (error) {
      // Runs keep live progress/error state even when a checkpoint rejects. Quit must retry
      // that state rather than silently exiting with only the earlier durable checkpoint.
      checkpointFailed = true
      throw error
    }
  })
}

/** Called after agent ingress is paused and all accepted jobs have drained. */
export async function checkpointAgentSessionsBeforeQuit(): Promise<void> {
  if (!checkpointFailed) return
  await persistence.save(persistentSnapshot())
  checkpointFailed = false
}

// Metadata requests serialize, and only publish live state after a committed save.
function editSessions<T>(change: (next: AgentSessionsData) => T): Promise<T> {
  return queueSessionWrite(async () => {
    await loadAgentSessions()
    persistence.assertWritable()
    const before = clone(data)
    const next = clone(before)
    const result = change(next)
    await persistence.save(persistentSnapshot(next))
    // Keep active run object identities, including their derived quarantine markers.
    const current = new Map(data.sessions.map((session) => [session.id, session]))
    data.sessions = next.sessions.map((session) => {
      const existing = current.get(session.id)
      if (!existing) return session
      // Only changed metadata is published; an active run may have advanced meanwhile.
      const original = before.sessions.find((item) => item.id === session.id)!
      for (const key of [
        'title',
        'mode',
        'model',
        'reasoningEffort',
        'planReady',
        'updatedAt'
      ] as const) {
        if (session[key] !== original[key]) Object.assign(existing, { [key]: session[key] })
      }
      return existing
    })
    data.activeSessionId = next.activeSessionId
    data.modelDefaultsByProvider = next.modelDefaultsByProvider
    return clone(result)
  })
}

export function setAgentEventSink(sink: ((event: AgentStreamEvent) => void) | null) {
  eventSink = sink
}

export async function loadAgentSessions(): Promise<AgentSessionsData> {
  if (loaded) return clone(data)
  if (!loading) loading = initializeSessions()
  return clone(await loading)
}

async function initializeSessions(): Promise<AgentSessionsData> {
  const stored = await persistence.load()
  data = {
    ...stored.data,
    sessions: stored.data.sessions.map((session) => ({
      ...session,
      tokenCount: session.tokenCount ?? 0,
      planReady: session.planReady ?? false
    })),
    activeSessionId: stored.data.activeSessionId ?? null,
    modelDefaultsByProvider: normalizeModelDefaults(stored.data.modelDefaultsByProvider)
  }
  for (const session of data.sessions) {
    if (
      ['running', 'waiting_approval'].includes(session.status) &&
      typeof session.activeRunId === 'string' &&
      !!session.activeRunId.trim() &&
      session.lastRunMetrics &&
      typeof session.lastRunMetrics.runId === 'string' &&
      !!session.lastRunMetrics.runId.trim() &&
      session.lastRunMetrics.runId === session.activeRunId
    )
      session.lastRunMetrics = interruptAgentRunMetrics(session.lastRunMetrics)
    try {
      if (!validAgentDisplayHistory(session.messages)) {
        damagedDisplayHistories.set(session, {
          present: Object.hasOwn(session, 'messages'),
          value: clone(session.messages)
        })
        session.messages = []
        throw new Error('Existing agent display history is malformed')
      }
      initializeAgentHistory(session)
    } catch (error) {
      const diagnostic =
        `Agent history recovery failed: ${errorDetail(error)}. ` +
        'Saved history was preserved; this session cannot run until repaired.'
      historyRecoveryErrors.set(session, diagnostic)
      session.status = 'error'
      session.error = diagnostic
      session.activeRunId = undefined
      session.planReady = false
      // Preserve both canonical and display records for recovery, including unfinished calls.
      // A damaged session must not prevent loading or using its healthy neighbors.
      continue
    }
    session.planReady =
      session.planReady === true && session.mode === 'planning' && session.status === 'completed'
    if (session.status === 'running' || session.status === 'waiting_approval') {
      session.status = 'interrupted'
      session.activeRunId = undefined
      session.error = 'Run interrupted when the application closed'
    }
    settleInterruptedToolCalls(session)
  }
  // Blocked recovery still exposes the shell. A failed migration must not erase the input.
  if (stored.writable) {
    try {
      await withAgentPersistenceOperation(() => persistence.save(persistentSnapshot()))
    } catch (error) {
      checkpointFailed = true
      reportAgentPersistenceNotice({
        level: 'error',
        message: `Could not checkpoint agent session recovery: ${errorDetail(error)}. Existing saved data has been kept; retry saving or restart after resolving the file problem.`
      })
    }
  }
  loaded = true
  return clone(data)
}

export async function createAgentSession(
  settings: AiRuntimeSettings,
  title = 'New agent'
): Promise<AgentSession> {
  return editSessions((next) => {
    const timestamp = now()
    const provider = getAiProvider(settings)
    const modelDefaults = next.modelDefaultsByProvider[provider]
    const session: AgentSession = {
      id: id('agent'),
      title,
      mode: 'manual',
      model: modelDefaults?.model || getSelectedAiModel(settings),
      reasoningEffort: modelDefaults?.reasoningEffort || 'none',
      status: 'idle',
      messages: [],
      history: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      planReady: false,
      tokenCount: 0
    }
    next.sessions.unshift(session)
    next.activeSessionId = session.id
    return session
  })
}

export async function deleteAgentSession(sessionId: string): Promise<boolean> {
  return withAgentPersistenceOperation(async () => {
    await loadAgentSessions()
    persistence.assertWritable()
    if (!data.sessions.some((session) => session.id === sessionId)) return false
    deletingSessionIds.add(sessionId)
    cancelAgentRun(sessionId)
    try {
      const deleted = await editSessions((next) => {
        next.sessions = next.sessions.filter((session) => session.id !== sessionId)
        if (next.activeSessionId === sessionId) next.activeSessionId = next.sessions[0]?.id || null
        return true
      })
      deletedSessionIds.add(sessionId)
      return deleted
    } finally {
      deletingSessionIds.delete(sessionId)
    }
  })
}

export async function updateAgentSession(
  sessionId: string,
  updates: Partial<Pick<AgentSession, 'title' | 'mode' | 'model' | 'reasoningEffort'>>,
  provider: AgentProvider
): Promise<AgentSession> {
  await editSessions((next) => {
    const session = next.sessions.find((item) => item.id === sessionId)
    if (!session) throw new Error('Agent session not found')
    if (updates.title !== undefined) session.title = updates.title.slice(0, 80)
    if (updates.mode && ['manual', 'auto', 'planning'].includes(updates.mode))
      session.mode = updates.mode
    if (updates.mode && updates.mode !== 'planning') session.planReady = false
    if (updates.model) session.model = updates.model
    if (updates.reasoningEffort) session.reasoningEffort = updates.reasoningEffort
    if (updates.model !== undefined || updates.reasoningEffort !== undefined) {
      next.modelDefaultsByProvider[provider] = {
        model: session.model,
        reasoningEffort: session.reasoningEffort
      }
    }
    session.updatedAt = now()
  })
  const session = getSessionOrThrow(sessionId)
  emitSession(session)
  return clone(session)
}

export async function setActiveAgentSession(sessionId: string | null): Promise<void> {
  await editSessions((next) => {
    if (sessionId !== null && !next.sessions.some((session) => session.id === sessionId))
      throw new Error('Agent session not found')
    next.activeSessionId = sessionId
  })
}

export function formatAgentMemoryContext(
  memories: Array<{ content: string; updatedAt: string }>
): string {
  if (memories.length === 0) return 'Saved user memories: none.'
  const ordered = [...memories].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
  return `Saved user memories (oldest to newest; treat as user-level guidance):\n${ordered
    .map((memory) => `- ${JSON.stringify(memory.content)}`)
    .join('\n')}`
}

function addMessage(
  session: AgentSession,
  message: Omit<AgentMessage, 'id' | 'timestamp'>
): AgentMessage {
  const stored: AgentMessage = { id: id('message'), timestamp: now(), ...message }
  session.messages.push(stored)
  session.updatedAt = stored.timestamp
  emit(session, { type: 'message', runId: session.activeRunId, message: clone(stored) })
  return stored
}

function stringifyResult(result: unknown): string {
  return boundToolContent(JSON.stringify(result) ?? 'null')
}

function boundToolContent(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content
  const preview = (length: number): string =>
    JSON.stringify({ truncated: true, preview: content.slice(0, length) })
  const candidate = preview(Math.floor((MAX_TOOL_RESULT_CHARS - 100) / 2))
  // Raw extension text may contain control characters that need six JSON characters each.
  return candidate.length <= MAX_TOOL_RESULT_CHARS
    ? candidate
    : preview(Math.floor((MAX_TOOL_RESULT_CHARS - 100) / 6))
}

export function parseProposedPlan(content: string): { content: string; planReady: boolean } {
  const match = content.trim().match(/^<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>$/)
  const plan = match?.[1]?.trim()
  return plan && !plan.includes('<proposed_plan>') && !plan.includes('</proposed_plan>')
    ? { content: plan, planReady: true }
    : { content, planReady: false }
}

async function awaitApproval(
  session: AgentSession,
  runId: string,
  call: AgentToolCall,
  prepared: PreparedMutation,
  context: AgentRunContext
): Promise<boolean> {
  let resolveApproval!: (approved: boolean) => void
  const approval = new Promise<boolean>((resolve) => {
    resolveApproval = resolve
  })
  approvals.set(call.id, {
    sessionId: session.id,
    runId,
    toolCallId: call.id,
    prepared,
    resolve: resolveApproval
  })
  session.status = 'waiting_approval'
  call.status = 'waiting_approval'
  call.before = prepared.before
  call.after = prepared.after
  context.metrics = recordAgentRunTool(context.metrics, call)
  checkpointRunMetrics(session, context)
  emit(session, {
    type: 'approval',
    runId,
    toolCall: clone(call),
    session: clone(session)
  })
  emitSession(session, runId)
  await save()
  return approval
}

function isActiveRun(session: AgentSession, runId: string, signal: AbortSignal): boolean {
  return (
    !signal.aborted &&
    session.activeRunId === runId &&
    controllers.get(session.id)?.signal === signal &&
    !deletedSessionIds.has(session.id)
  )
}

function assertActiveRun(session: AgentSession, runId: string, signal: AbortSignal): void {
  if (!isActiveRun(session, runId, signal)) throw new Error('Agent execution cancelled')
}

async function runTool(
  session: AgentSession,
  runId: string,
  mode: AgentMode,
  providerCall: ToolCall,
  context: AgentRunContext,
  signal: AbortSignal
): Promise<{ toolCall: AgentToolCall; content: string }> {
  const targetLabel = agentToolTargetLabel(providerCall.name, providerCall.arguments)
  const call: AgentToolCall = {
    id: providerCall.id || id('tool'),
    name: providerCall.name,
    arguments: providerCall.arguments,
    ...(targetLabel ? { targetLabel } : {}),
    status: 'running',
    createdAt: now()
  }
  context.metrics = recordAgentRunTool(context.metrics, call)
  checkpointRunMetrics(session, context)
  const message = addMessage(session, {
    role: 'tool',
    content: providerCall.name,
    toolCalls: [call]
  })
  emit(session, { type: 'tool', runId, toolCall: clone(call), session: clone(session) })
  try {
    assertActiveRun(session, runId, signal)
    // Durably record the attempt before execution; a crashed tool has an unknown outcome.
    await save()
    assertActiveRun(session, runId, signal)
    let result: unknown
    let extensionContent: string | undefined
    if (mutationToolNames.has(call.name)) {
      if (mode === 'planning') throw new Error('Mutation tools are disabled in planning mode')
      const prepared = await prepareMutation(call.name, call.arguments)
      assertActiveRun(session, runId, signal)
      call.before = prepared.before
      call.after = prepared.after
      if (mode === 'manual') {
        const approved = await awaitApproval(session, runId, call, prepared, context)
        assertActiveRun(session, runId, signal)
        if (!approved) {
          call.status = 'rejected'
          result = { success: false, denied: true, message: 'The user rejected this mutation' }
        } else {
          assertActiveRun(session, runId, signal)
          call.status = 'approved'
          session.status = 'running'
          context.metrics = recordAgentRunTool(context.metrics, call)
          checkpointRunMetrics(session, context)
          await save()
          assertActiveRun(session, runId, signal)
          emit(session, { type: 'tool', runId, toolCall: clone(call), session: clone(session) })
          assertActiveRun(session, runId, signal)
          result = await commitMutation(prepared, 'agent', signal)
        }
      } else {
        assertActiveRun(session, runId, signal)
        result = await commitMutation(prepared, 'agent', signal)
      }
    } else if (context.extensions.has(call.name)) {
      const output = await context.extensions.executeTool(providerCall, { signal })
      extensionContent = boundToolContent(output.content)
      try {
        result = JSON.parse(extensionContent)
      } catch {
        result = extensionContent
      }
      if (output.isError) {
        call.status = 'error'
        const error =
          result && typeof result === 'object'
            ? (result as { error?: { message?: unknown } }).error
            : undefined
        call.error = typeof error?.message === 'string' ? error.message : extensionContent
      }
    } else {
      result = isDocumentationTool(call.name)
        ? await executeDocumentationCall(
            context.documentationPolicy,
            context.metrics,
            call.id,
            call.name,
            call.arguments,
            () => executeReadTool(call.name, call.arguments)
          )
        : await executeReadTool(call.name, call.arguments)
    }
    assertActiveRun(session, runId, signal)
    if (call.status !== 'rejected' && call.status !== 'error') call.status = 'completed'
    call.result = result
    message.content = extensionContent ?? stringifyResult(result)
    session.status = 'running'
    context.metrics = recordAgentRunTool(context.metrics, call)
    checkpointRunMetrics(session, context)
    emit(session, { type: 'tool', runId, toolCall: clone(call), session: clone(session) })
    await save()
    return { toolCall: call, content: message.content }
  } catch (error) {
    const detail = errorDetail(error)
    if (!isActiveRun(session, runId, signal))
      return {
        toolCall: call,
        content: JSON.stringify({ success: false, error: 'Agent execution cancelled' })
      }
    call.status = 'error'
    call.error = detail
    message.content = JSON.stringify({ success: false, error: detail })
    context.metrics = recordAgentRunTool(context.metrics, call)
    checkpointRunMetrics(session, context)
    emit(session, { type: 'tool', runId, toolCall: clone(call), session: clone(session) })
    await save()
    return { toolCall: call, content: message.content }
  }
}

export function runAgentSession(
  sessionId: string,
  userContent: string,
  settings: AiRuntimeSettings
): Promise<{ runId: string }> {
  return withAgentPersistenceOperation(() => startAgentSession(sessionId, userContent, settings))
}

/** Stop active providers/approvals, then let their admitted final checkpoints drain. */
export function stopAgentRuns(): void {
  for (const sessionId of controllers.keys()) cancelAgentRun(sessionId)
}

async function startAgentSession(
  sessionId: string,
  userContent: string,
  settings: AiRuntimeSettings
): Promise<{ runId: string }> {
  await loadAgentSessions()
  persistence.assertWritable()
  const session = getSessionOrThrow(sessionId)
  if (deletingSessionIds.has(sessionId)) throw new Error('Agent session is being deleted')
  const historyError = historyRecoveryErrors.get(session)
  if (historyError) throw new Error(historyError)
  if (controllers.has(sessionId))
    throw new Error('This agent session already has a running request')
  if (!userContent.trim()) throw new Error('Message cannot be empty')
  // App policy remains here; a standalone vivi OpenRouter provider needs only its own key.
  const configError = validateAiConfiguration(settings)
  if (configError) throw new Error(configError)
  // An admitted request may still be loading when shutdown sweeps existing controllers.
  // Do not register a new provider run after that sweep; it has not changed any state yet.
  if (isAgentPersistencePaused()) throw new Error('The app is shutting down; agent runs are paused')

  const runId = id('run')
  const context: AgentRunContext = {
    // Reserve every built-in before planning mode filters mutation tools from advertisement.
    extensions: createAgentExtensionRegistry(
      agentToolDefinitions.map((tool) => tool.function.name)
    ),
    documentationPolicy: createDocumentationPolicyState(),
    metrics: createAgentRunMetrics(runId, now())
  }
  const mode = session.mode
  const controller = new AbortController()
  controllers.set(sessionId, controller)
  session.activeRunId = runId
  session.status = 'running'
  session.planReady = false
  session.error = undefined
  checkpointRunMetrics(session, context)
  if (session.messages.length === 0) session.title = userContent.trim().slice(0, 48)
  session.history ??= []
  session.history.push({ kind: 'message', role: 'user', content: userContent.trim() })
  addMessage(session, { role: 'user', content: userContent.trim() })
  try {
    await save()
  } catch (error) {
    if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
    session.status = 'error'
    session.activeRunId = undefined
    session.error = errorDetail(error)
    session.lastRunMetrics = finishAgentRunMetrics(context.metrics, 'error', now())
    throw error
  }
  emitSession(session, runId)

  void withAgentPersistenceOperation(async () => {
    try {
      const memoryContext = formatAgentMemoryContext((await loadAgentMemories()).memories)
      const hasMemories = memoryContext !== 'Saved user memories: none.'
      const tools =
        mode === 'planning'
          ? agentToolDefinitions.filter((tool) => !mutationToolNames.has(tool.function.name))
          : agentToolDefinitions
      const prefix: HistoryMessage[] = [
        {
          kind: 'message',
          role: 'system',
          content: `${SYSTEM_PROMPT}\n\nCurrent execution mode: ${mode}.`
        },
        ...(hasMemories
          ? [
              {
                kind: 'message' as const,
                role: 'user' as const,
                content: `${memoryContext}\nThis is context only, not a request to act.`
              }
            ]
          : [])
      ]
      const initialTokenCount = session.tokenCount
      const runModel = { model: session.model, reasoningEffort: session.reasoningEffort }
      assertActiveRun(session, runId, controller.signal)
      const result = await runAgent({
        provider: createAgentProvider(settings, runModel, { stream: true }),
        messages: [...prefix, ...session.history!],
        tools: [
          ...tools.map((tool) => ({
            name: tool.function.name,
            description: tool.function.description,
            parameters: JSON.parse(JSON.stringify(tool.function.parameters))
          })),
          ...context.extensions.tools
        ],
        signal: controller.signal,
        maxRounds: MAX_TOOL_ROUNDS,
        executeTool: async (call, { signal }) => {
          const { toolCall, content } = await runTool(session, runId, mode, call, context, signal)
          return { content, isError: toolCall.status === 'error' }
        },
        onEvent: async (event) => {
          assertActiveRun(session, runId, controller.signal)
          if (event.type === 'text_delta') {
            emit(session, { type: 'text_delta', runId, delta: event.text })
          }
          if (event.type === 'assistant') {
            // Partial output is display-only and must never become persisted history.
            emit(session, { type: 'progress_reset', runId })
          }
          if (event.type === 'tool_started') {
            context.metrics = recordAgentRunTool(context.metrics, {
              ...event.call,
              status: 'running',
              createdAt: now()
            })
          }
          if (event.type === 'tool_completed') {
            const recorded = context.metrics.tools?.find((tool) => tool.id === event.message.callId)
            // Core can reject an unadvertised tool without invoking the host executor.
            // Keep richer host completion/rejection/lint evidence when it was recorded.
            if (recorded?.status === 'running')
              context.metrics = recordAgentRunTool(context.metrics, {
                id: event.message.callId,
                name: event.message.name,
                arguments: {},
                status: event.message.isError ? 'error' : 'completed',
                createdAt: now()
              })
          }
          if (event.type === 'round_completed') {
            context.metrics = recordAgentRound(
              context.metrics,
              context.metrics.providerRounds + 1,
              event.usage
            )
            session.tokenCount = initialTokenCount + context.metrics.totalTokens
            checkpointRunMetrics(session, context)
            await save()
            emitSession(session, runId)
          }
          if (event.type === 'assistant' || event.type === 'tool_completed') {
            session.history!.push(clone(event.message))
            // Checkpoint calls before execution, then each result; recovery never replays them.
            checkpointRunMetrics(session, context)
            await save()
          }
        }
      })
      // Cancellation/error may close unexecuted calls without emitting further events.
      if (result.error?.code !== 'invalid_input')
        session.history = result.history.slice(prefix.length)
      context.metrics = reconcileAgentRunUsage(context.metrics, result)
      session.tokenCount = initialTokenCount + result.usage.totalTokens
      settleInterruptedToolCalls(session)
      if (result.status === 'error')
        throw new Error(result.error?.message || 'Agent execution failed')
      if (result.status === 'cancelled') throw new Error('Agent execution cancelled')
      const content = result.content.trim() || 'The agent completed without a text response.'
      const response =
        mode === 'planning' ? parseProposedPlan(content) : { content, planReady: false }
      addMessage(session, { role: 'assistant', content: response.content })
      session.status = 'completed'
      session.planReady = response.planReady
      session.activeRunId = undefined
      context.metrics = finishAgentRunMetrics(context.metrics, 'completed', now())
      session.lastRunMetrics = clone(context.metrics)
      await save()
      emit(session, { type: 'done', runId, session: clone(session) })
    } catch (error) {
      const aborted = controller.signal.aborted
      session.status = aborted ? 'cancelled' : 'error'
      session.error = aborted ? undefined : errorDetail(error)
      session.activeRunId = undefined
      context.metrics = finishAgentRunMetrics(context.metrics, session.status, now())
      session.lastRunMetrics = clone(context.metrics)
      try {
        await save()
      } catch (persistenceError) {
        session.status = 'error'
        session.error = `Failed to save agent session: ${errorDetail(persistenceError)}`
        session.lastRunMetrics = finishAgentRunMetrics(context.metrics, 'error', now())
      }
      emit(
        session,
        session.status === 'cancelled'
          ? { type: 'done', runId, session: clone(session) }
          : { type: 'error', runId, error: session.error, session: clone(session) }
      )
    } finally {
      if (controllers.get(sessionId) === controller) controllers.delete(sessionId)
      for (const [callId, approval] of approvals) {
        if (approval.sessionId === sessionId && approval.runId === runId) {
          approvals.delete(callId)
          approval.resolve(false)
        }
      }
    }
  })

  return { runId }
}

export function resolveAgentPlan(
  sessionId: string,
  decision: AgentPlanDecision,
  settings: AiRuntimeSettings
): Promise<AgentSession | { runId: string }> {
  return withAgentPersistenceOperation(() => decideAgentPlan(sessionId, decision, settings))
}

async function decideAgentPlan(
  sessionId: string,
  decision: AgentPlanDecision,
  settings: AiRuntimeSettings
): Promise<AgentSession | { runId: string }> {
  await loadAgentSessions()
  if (!['auto', 'manual', 'continue'].includes(decision)) throw new Error('Invalid plan decision')
  const session = getSessionOrThrow(sessionId)
  if (
    !session.planReady ||
    session.mode !== 'planning' ||
    session.status !== 'completed' ||
    controllers.has(sessionId)
  )
    throw new Error('This session does not have a completed plan awaiting a decision')

  await editSessions((next) => {
    const pending = next.sessions.find((item) => item.id === sessionId)!
    // Decisions may queue behind an in-flight save. Recheck the decision gate against the
    // latest committed metadata so a duplicate cannot change mode or start another run.
    if (
      !pending?.planReady ||
      pending.mode !== 'planning' ||
      pending.status !== 'completed' ||
      controllers.has(sessionId)
    )
      throw new Error('This session does not have a completed plan awaiting a decision')
    pending.planReady = false
    if (decision !== 'continue') pending.mode = decision
    pending.updatedAt = now()
  })
  if (decision === 'continue') {
    emitSession(session)
    return clone(session)
  }

  emitSession(session)
  return runAgentSession(sessionId, 'Implement the plan.', settings)
}

export async function resolveAgentApproval(
  sessionId: string,
  toolCallId: string,
  approved: boolean
): Promise<boolean> {
  const pending = approvals.get(toolCallId)
  if (!pending || pending.sessionId !== sessionId) return false
  approvals.delete(toolCallId)
  pending.resolve(approved)
  return true
}

export function cancelAgentRun(sessionId: string): boolean {
  const controller = controllers.get(sessionId)
  if (!controller) return false
  controller.abort()
  for (const [callId, approval] of approvals) {
    if (approval.sessionId === sessionId) {
      approvals.delete(callId)
      approval.resolve(false)
    }
  }
  return true
}
