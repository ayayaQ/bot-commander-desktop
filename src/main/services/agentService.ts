import { app } from 'electron'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import crypto from 'node:crypto'
import OpenAI from 'openai'
import type {
  AgentMessage,
  AgentMode,
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
  agentToolDefinitions,
  commitMutation,
  executeReadTool,
  mutationToolNames,
  prepareMutation,
  type PreparedMutation
} from './agentTools'

const AGENT_SESSIONS_FILENAME = 'agent-sessions.json'
const MAX_TOOL_ROUNDS = 25
const MAX_TOOL_RESULT_CHARS = 24_000

const SYSTEM_PROMPT = `You are the Bot Commander agent harness. Help the user inspect and modify their bot configuration.
The initial context intentionally contains no bot resources. For create or edit tasks, search for a similar persisted command or interaction first, then use exact read tools before editing. Existing resources are preferred synthesis examples, but lint new work and do not copy mistakes blindly.
Every edit requires the current revision returned by an exact read. After an edit, inspect the returned lint diagnostics and repair meaningful errors.
Use keyword_grep for cross-resource references. Never invent IDs or revisions. Keep final answers concise and state what changed and what verification found.
The bundled documentation table of contents is listed below. Use its titles to choose a targeted search_documentation query; the outline contains titles only, not the documentation content.

Bundled documentation table of contents:
${documentationTableOfContents}

Use documentation for direct help questions or unresolved syntax and feature behavior, not as speculative browsing. One targeted search normally suffices because search_documentation includes the best matching content. Use read_documentation only when that result is truncated or genuinely insufficient; retry once with a shorter term when no result is returned.
Documentation is a bundled release snapshot. Use exact resource reads and lint results as the authority for the user's current configuration, and never invent unsupported fields or syntax.
In planning mode, investigate with read and lint tools and return an actionable plan without mutations.`

type ProviderMessage = Record<string, any>
type ProviderToolCall = { id: string; name: string; arguments: Record<string, unknown> }

interface ProviderTurn {
  content: string
  toolCalls: ProviderToolCall[]
  inputTokenCount: number
  outputTokenCount: number
  tokenCount: number
  rawAssistant: ProviderMessage[]
}

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

let data: AgentSessionsData = { sessions: [], activeSessionId: null }
let loaded = false
const controllers = new Map<string, AbortController>()
const approvals = new Map<string, PendingApproval>()
const deletedSessionIds = new Set<string>()
let eventSink: ((event: AgentStreamEvent) => void) | null = null
let saveChain: Promise<void> = Promise.resolve()

function path(): string {
  return join(app.getPath('userData'), AGENT_SESSIONS_FILENAME)
}

function clone<T>(value: T): T {
  return structuredClone(value)
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
      activeSessionId: typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      console.error('Failed to load agent sessions:', error)
    data = { sessions: [], activeSessionId: null }
  }
  for (const session of data.sessions) {
    if (session.status === 'running' || session.status === 'waiting_approval') {
      session.status = 'interrupted'
      session.activeRunId = undefined
      session.error = 'Run interrupted when the application closed'
      for (const message of session.messages) {
        for (const call of message.toolCalls || []) {
          if (call.status === 'running' || call.status === 'waiting_approval') {
            call.status = 'error'
            call.error = 'Tool call interrupted when the application closed'
          }
        }
      }
    }
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
  const session: AgentSession = {
    id: id('agent'),
    title,
    mode: 'manual',
    model: getSelectedAiModel(settings),
    reasoningEffort: 'none',
    status: 'idle',
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
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
  updates: Partial<Pick<AgentSession, 'title' | 'mode' | 'model' | 'reasoningEffort'>>
): Promise<AgentSession> {
  await loadAgentSessions()
  const session = getSessionOrThrow(sessionId)
  if (updates.title !== undefined) session.title = updates.title.slice(0, 80)
  if (updates.mode && ['manual', 'auto', 'planning'].includes(updates.mode))
    session.mode = updates.mode as AgentMode
  if (updates.model) session.model = updates.model
  if (updates.reasoningEffort) session.reasoningEffort = updates.reasoningEffort
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

function historyMessages(session: AgentSession): ProviderMessage[] {
  return session.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }))
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed
  } catch {
    throw new Error('Tool arguments were not valid JSON')
  }
}

export async function executeAgentProviderTurn(
  settings: AiRuntimeSettings,
  session: AgentSession,
  messages: ProviderMessage[],
  tools: typeof agentToolDefinitions,
  signal: AbortSignal
): Promise<ProviderTurn> {
  const configError = validateAiConfiguration(settings)
  if (configError) throw new Error(configError)

  if (getAiProvider(settings) === 'openrouter') {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${settings.openrouterApiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/ayayaQ/bot-commander-desktop',
        'X-Title': 'Bot Commander for Discord'
      },
      body: JSON.stringify({
        model: session.model,
        messages,
        tools,
        tool_choice: 'auto',
        ...(session.reasoningEffort !== 'none'
          ? { reasoning: { effort: session.reasoningEffort, exclude: true } }
          : {})
      })
    })
    if (!response.ok)
      throw new Error(
        `OpenRouter agent request failed (${response.status}): ${await response.text()}`
      )
    const json = (await response.json()) as any
    const message = json.choices?.[0]?.message
    if (!message) throw new Error('OpenRouter returned no agent message')
    return {
      content: typeof message.content === 'string' ? message.content : '',
      toolCalls: (message.tool_calls || []).map((call: any) => ({
        id: call.id,
        name: call.function.name,
        arguments: parseArguments(call.function.arguments)
      })),
      inputTokenCount: json.usage?.prompt_tokens || 0,
      outputTokenCount: json.usage?.completion_tokens || 0,
      tokenCount:
        json.usage?.total_tokens ||
        (json.usage?.prompt_tokens || 0) + (json.usage?.completion_tokens || 0),
      rawAssistant: [message]
    }
  }

  const openai = new OpenAI({ apiKey: settings.openaiApiKey })
  const response = await openai.responses.create(
    {
      model: session.model,
      input: messages as any,
      tools: tools.map((tool) => ({
        type: 'function' as const,
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: false
      })),
      tool_choice: 'auto',
      ...(session.reasoningEffort !== 'none'
        ? { reasoning: { effort: session.reasoningEffort } }
        : {})
    } as any,
    { signal }
  )
  const output = response.output as any[]
  return {
    content: response.output_text || '',
    toolCalls: output
      .filter((item) => item.type === 'function_call')
      .map((call) => ({
        id: call.call_id,
        name: call.name,
        arguments: parseArguments(call.arguments)
      })),
    inputTokenCount: response.usage?.input_tokens || 0,
    outputTokenCount: response.usage?.output_tokens || 0,
    tokenCount:
      response.usage?.total_tokens ||
      (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
    rawAssistant: output
  }
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
  const content = JSON.stringify(result)
  return content.length > MAX_TOOL_RESULT_CHARS
    ? `${content.slice(0, MAX_TOOL_RESULT_CHARS)}\n[tool result truncated]`
    : content
}

async function awaitApproval(
  session: AgentSession,
  runId: string,
  call: AgentToolCall,
  prepared: PreparedMutation
): Promise<boolean> {
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
  return new Promise<boolean>((resolve) =>
    approvals.set(call.id, { sessionId: session.id, runId, toolCallId: call.id, prepared, resolve })
  )
}

async function runTool(
  session: AgentSession,
  runId: string,
  mode: AgentMode,
  providerCall: ProviderToolCall,
  context: AgentRunContext
): Promise<{ toolCall: AgentToolCall; result: unknown }> {
  const call: AgentToolCall = {
    id: providerCall.id || id('tool'),
    name: providerCall.name,
    arguments: providerCall.arguments,
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
    let result: unknown
    if (mutationToolNames.has(call.name)) {
      if (mode === 'planning') throw new Error('Mutation tools are disabled in planning mode')
      const prepared = await prepareMutation(call.name, call.arguments)
      call.before = prepared.before
      call.after = prepared.after
      if (mode === 'manual') {
        const approved = await awaitApproval(session, runId, call, prepared)
        if (!approved) {
          call.status = 'rejected'
          result = { success: false, denied: true, message: 'The user rejected this mutation' }
        } else {
          call.status = 'approved'
          result = await commitMutation(prepared)
          call.status = 'completed'
        }
      } else {
        result = await commitMutation(prepared)
        call.status = 'completed'
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
      call.status = 'completed'
    }
    call.result = result
    message.content = stringifyResult(result)
    session.status = 'running'
    emit(session, { type: 'tool', runId, toolCall: clone(call) })
    await save()
    return { toolCall: call, result }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
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
  if (controllers.has(sessionId))
    throw new Error('This agent session already has a running request')
  if (!userContent.trim()) throw new Error('Message cannot be empty')

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
  session.error = undefined
  if (session.messages.length === 0) session.title = userContent.trim().slice(0, 48)
  addMessage(session, { role: 'user', content: userContent.trim() })
  await save()
  emitSession(session, runId)

  void (async () => {
    try {
      const tools =
        mode === 'planning'
          ? agentToolDefinitions.filter((tool) => !mutationToolNames.has(tool.function.name))
          : agentToolDefinitions
      const messages: ProviderMessage[] = [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nCurrent execution mode: ${mode}.` },
        ...historyMessages(session)
      ]
      const openRouter = getAiProvider(settings) === 'openrouter'

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const turn = await executeAgentProviderTurn(
          settings,
          session,
          messages,
          tools,
          controller.signal
        )
        context.metrics.providerRounds += 1
        context.metrics.inputTokens += turn.inputTokenCount
        context.metrics.outputTokens += turn.outputTokenCount
        context.metrics.totalTokens += turn.tokenCount
        session.tokenCount += turn.tokenCount
        messages.push(...turn.rawAssistant)
        if (turn.toolCalls.length === 0) {
          const content = turn.content.trim() || 'The agent completed without a text response.'
          addMessage(session, { role: 'assistant', content })
          session.status = 'completed'
          session.activeRunId = undefined
          session.lastRunMetrics = clone(context.metrics)
          await save()
          emit(session, { type: 'done', runId, session: clone(session) })
          return
        }
        for (const providerCall of turn.toolCalls) {
          const { result } = await runTool(session, runId, mode, providerCall, context)
          const content = stringifyResult(result)
          messages.push(
            openRouter
              ? { role: 'tool', tool_call_id: providerCall.id, content }
              : { type: 'function_call_output', call_id: providerCall.id, output: content }
          )
        }
      }
      throw new Error(`Agent exceeded the ${MAX_TOOL_ROUNDS}-round tool limit`)
    } catch (error) {
      const aborted = controller.signal.aborted
      session.status = aborted ? 'cancelled' : 'error'
      session.error = aborted ? undefined : error instanceof Error ? error.message : String(error)
      session.activeRunId = undefined
      session.lastRunMetrics = clone(context.metrics)
      await save()
      emit(
        session,
        aborted
          ? { type: 'done', runId, session: clone(session) }
          : { type: 'error', runId, error: session.error, session: clone(session) }
      )
    } finally {
      controllers.delete(sessionId)
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
