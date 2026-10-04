import { app } from 'electron'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import crypto from 'node:crypto'
import { runAgent, type HistoryMessage, type ToolCall } from '@ayayaq/vivi'
import { createAgentProvider } from './agentProviderAdapter'
import { initializeAgentHistory } from './agentHistory'

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
  documentationPolicy: DocumentationPolicyState
  metrics: AgentRunMetrics
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
const controllers = new Map<string, AbortController>()
const approvals = new Map<string, PendingApproval>()
const deletedSessionIds = new Set<string>()
// Derived on load, never serialized over the preserved damaged transcript.
const historyRecoveryErrors = new WeakMap<AgentSession, string>()
let eventSink: ((event: AgentStreamEvent) => void) | null = null
let saveChain: Promise<void> = Promise.resolve()

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
  eventSink?.({ sessionId: session.id, ...event })
}

function emitSession(session: AgentSession, runId?: string) {
  emit(session, { type: 'session', runId, session: clone(session) })
}

async function save(): Promise<void> {
  saveChain = saveChain
    .catch(() => undefined)
    .then(async () => {
      const output = path()
      const temp = `${output}.tmp`
      await fs.writeFile(temp, JSON.stringify(data, null, 2))
      await fs.rename(temp, output)
    })
  await saveChain
}

export function setAgentEventSink(sink: ((event: AgentStreamEvent) => void) | null) {
  eventSink = sink
}

export async function loadAgentSessions(): Promise<AgentSessionsData> {
  if (loaded) return clone(data)
  try {
    const parsed = JSON.parse(await fs.readFile(path(), 'utf-8')) as AgentSessionsData
    data = {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      activeSessionId: typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null,
      modelDefaultsByProvider: normalizeModelDefaults(parsed.modelDefaultsByProvider)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Failed to load agent sessions:', error)
    data = { sessions: [], activeSessionId: null, modelDefaultsByProvider: {} }
  }
  for (const session of data.sessions) {
    try {
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
  loaded = true
  await save()
  return clone(data)
}

export async function createAgentSession(
  settings: AiRuntimeSettings,
  title = 'New agent'
): Promise<AgentSession> {
  await loadAgentSessions()
  const timestamp = now()
  const provider = getAiProvider(settings)
  const modelDefaults = data.modelDefaultsByProvider[provider]
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
  data.sessions.unshift(session)
  deletedSessionIds.delete(session.id)
  data.activeSessionId = session.id
  await save()
  return clone(session)
}

export async function deleteAgentSession(sessionId: string): Promise<boolean> {
  await loadAgentSessions()
  if (controllers.has(sessionId)) cancelAgentRun(sessionId)
  const index = data.sessions.findIndex((item) => item.id === sessionId)
  if (index < 0) return false
  deletedSessionIds.add(sessionId)
  data.sessions.splice(index, 1)
  if (data.activeSessionId === sessionId) data.activeSessionId = data.sessions[0]?.id || null
  await save()
  return true
}

export async function updateAgentSession(
  sessionId: string,
  updates: Partial<Pick<AgentSession, 'title' | 'mode' | 'model' | 'reasoningEffort'>>,
  provider: AgentProvider
): Promise<AgentSession> {
  await loadAgentSessions()
  const session = getSessionOrThrow(sessionId)
  if (updates.title !== undefined) session.title = updates.title.slice(0, 80)
  if (updates.mode && ['manual', 'auto', 'planning'].includes(updates.mode))
    session.mode = updates.mode as AgentMode
  if (updates.mode && updates.mode !== 'planning') session.planReady = false
  if (updates.model) session.model = updates.model
  if (updates.reasoningEffort) session.reasoningEffort = updates.reasoningEffort
  if (updates.model !== undefined || updates.reasoningEffort !== undefined) {
    data.modelDefaultsByProvider[provider] = {
      model: session.model,
      reasoningEffort: session.reasoningEffort
    }
  }
  session.updatedAt = now()
  await save()
  emitSession(session)
  return clone(session)
}

export async function setActiveAgentSession(sessionId: string | null): Promise<void> {
  await loadAgentSessions()
  data.activeSessionId = sessionId
  await save()
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
  const content = JSON.stringify(result) ?? 'null'
  return content.length > MAX_TOOL_RESULT_CHARS
    ? JSON.stringify({
        truncated: true,
        preview: content.slice(0, Math.floor((MAX_TOOL_RESULT_CHARS - 100) / 2))
      })
    : content
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
  prepared: PreparedMutation
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
): Promise<{ toolCall: AgentToolCall; result: unknown }> {
  const targetLabel = agentToolTargetLabel(providerCall.name, providerCall.arguments)
  const call: AgentToolCall = {
    id: providerCall.id || id('tool'),
    name: providerCall.name,
    arguments: providerCall.arguments,
    ...(targetLabel ? { targetLabel } : {}),
    status: 'running',
    createdAt: now()
  }
  const message = addMessage(session, {
    role: 'tool',
    content: providerCall.name,
    toolCalls: [call]
  })
  emit(session, { type: 'tool', runId, toolCall: clone(call) })
  try {
    assertActiveRun(session, runId, signal)
    let result: unknown
    if (mutationToolNames.has(call.name)) {
      if (mode === 'planning') throw new Error('Mutation tools are disabled in planning mode')
      const prepared = await prepareMutation(call.name, call.arguments)
      assertActiveRun(session, runId, signal)
      call.before = prepared.before
      call.after = prepared.after
      if (mode === 'manual') {
        const approved = await awaitApproval(session, runId, call, prepared)
        assertActiveRun(session, runId, signal)
        if (!approved) {
          call.status = 'rejected'
          result = { success: false, denied: true, message: 'The user rejected this mutation' }
        } else {
          assertActiveRun(session, runId, signal)
          call.status = 'approved'
          result = await commitMutation(prepared, 'agent', signal)
        }
      } else {
        assertActiveRun(session, runId, signal)
        result = await commitMutation(prepared, 'agent', signal)
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
    if (call.status !== 'rejected') call.status = 'completed'
    call.result = result
    message.content = stringifyResult(result)
    session.status = 'running'
    emit(session, { type: 'tool', runId, toolCall: clone(call) })
    await save()
    return { toolCall: call, result }
  } catch (error) {
    const detail = errorDetail(error)
    if (!isActiveRun(session, runId, signal))
      return { toolCall: call, result: { success: false, error: 'Agent execution cancelled' } }
    call.status = 'error'
    call.error = detail
    message.content = JSON.stringify({ success: false, error: detail })
    emit(session, { type: 'tool', runId, toolCall: clone(call) })
    await save()
    return { toolCall: call, result: { success: false, error: detail } }
  }
}

export async function runAgentSession(
  sessionId: string,
  userContent: string,
  settings: AiRuntimeSettings
): Promise<{ runId: string }> {
  await loadAgentSessions()
  const session = getSessionOrThrow(sessionId)
  const historyError = historyRecoveryErrors.get(session)
  if (historyError) throw new Error(historyError)
  if (controllers.has(sessionId))
    throw new Error('This agent session already has a running request')
  if (!userContent.trim()) throw new Error('Message cannot be empty')
  // App policy remains here; a standalone vivi OpenRouter provider needs only its own key.
  const configError = validateAiConfiguration(settings)
  if (configError) throw new Error(configError)

  const runId = id('run')
  const context: AgentRunContext = {
    documentationPolicy: createDocumentationPolicyState(),
    metrics: {
      runId,
      providerRounds: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      documentationCalls: 0,
      uniqueDocumentationCalls: 0,
      duplicateDocumentationCalls: 0,
      documentationResultChars: 0
    }
  }
  const mode = session.mode
  const controller = new AbortController()
  controllers.set(sessionId, controller)
  session.activeRunId = runId
  session.status = 'running'
  session.planReady = false
  session.error = undefined
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
    throw error
  }
  emitSession(session, runId)

  void (async () => {
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
      const result = await runAgent({
        provider: createAgentProvider(settings, runModel, { stream: true }),
        messages: [...prefix, ...session.history!],
        tools: tools.map((tool) => ({
          name: tool.function.name,
          description: tool.function.description,
          parameters: JSON.parse(JSON.stringify(tool.function.parameters))
        })),
        signal: controller.signal,
        maxRounds: MAX_TOOL_ROUNDS,
        executeTool: async (call, { signal }) => {
          const { toolCall, result } = await runTool(session, runId, mode, call, context, signal)
          return { content: stringifyResult(result), isError: toolCall.status === 'error' }
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
          if (event.type === 'round_completed') {
            context.metrics.providerRounds += 1
            context.metrics.inputTokens += event.usage?.inputTokens || 0
            context.metrics.outputTokens += event.usage?.outputTokens || 0
            context.metrics.totalTokens += event.usage?.totalTokens || 0
            session.tokenCount += event.usage?.totalTokens || 0
          }
          if (event.type === 'assistant' || event.type === 'tool_completed') {
            session.history!.push(clone(event.message))
            // Checkpoint calls before execution, then each result; recovery never replays them.
            await save()
          }
        }
      })
      // Cancellation/error may close unexecuted calls without emitting further events.
      if (result.error?.code !== 'invalid_input')
        session.history = result.history.slice(prefix.length)
      context.metrics.providerRounds = result.rounds
      context.metrics.inputTokens = result.usage.inputTokens
      context.metrics.outputTokens = result.usage.outputTokens
      context.metrics.totalTokens = result.usage.totalTokens
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
      session.lastRunMetrics = clone(context.metrics)
      await save()
      emit(session, { type: 'done', runId, session: clone(session) })
    } catch (error) {
      const aborted = controller.signal.aborted
      session.status = aborted ? 'cancelled' : 'error'
      session.error = aborted ? undefined : errorDetail(error)
      session.activeRunId = undefined
      session.lastRunMetrics = clone(context.metrics)
      try {
        await save()
      } catch (persistenceError) {
        session.status = 'error'
        session.error = `Failed to save agent session: ${errorDetail(persistenceError)}`
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
  })()

  return { runId }
}

export async function resolveAgentPlan(
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

  session.planReady = false
  if (decision === 'continue') {
    session.updatedAt = now()
    await save()
    emitSession(session)
    return clone(session)
  }

  session.mode = decision
  session.updatedAt = now()
  await save()
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
