import type { AgentValidationReport } from './agentValidationTypes'
import type { HistoryMessage } from '@ayayaq/vivi'
import type { DesktopReasoningEffort } from './aiModelTypes'

export type AgentMode = 'manual' | 'auto' | 'planning'
export type AgentPlanDecision = 'auto' | 'manual' | 'continue'
export type AgentProvider = 'openai' | 'openrouter'
export type AgentReasoningEffort = DesktopReasoningEffort
export type AgentRunStatus =
  'idle' | 'running' | 'waiting_approval' | 'completed' | 'error' | 'cancelled' | 'interrupted'

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  targetLabel?: string
  status: 'running' | 'waiting_approval' | 'approved' | 'rejected' | 'completed' | 'error'
  result?: unknown
  error?: string
  validation?: AgentValidationReport
  validationBinding?: {
    wrapEvalInIIFE: boolean
    candidateHash: string
    baseRevision: string | null
    fixtureHash: string
  }
  diagnostics?: AgentLintDiagnostic[]
  before?: unknown
  after?: unknown
  createdAt: string
}

export interface AgentMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  timestamp: string
  thinkingContent?: string
  toolCalls?: AgentToolCall[]
}

export interface AgentRunMetrics {
  runId: string
  providerRounds: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Cache counts are already included in inputTokens; absent means unreported. */
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  documentationCalls: number
  uniqueDocumentationCalls: number
  duplicateDocumentationCalls: number
  documentationResultChars: number
  /** New fields are optional so older saved runs remain readable without invented evidence. */
  startedAt?: string
  checkpointAt?: string
  finishedAt?: string
  status?: 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted'
  /** True only after reconciling the core's final committed-round result. */
  usageReconciled?: boolean
  tools?: AgentRunToolMetric[]
}

export interface AgentRunToolMetric {
  id: string
  name: string
  status: AgentToolCall['status'] | 'unknown'
  /** Diagnostic evidence only; lint is not runtime validation. */
  lint?: { errors: number; warnings: number }
}

export interface AgentSession {
  id: string
  title: string
  mode: AgentMode
  model: string
  reasoningEffort: AgentReasoningEffort
  status: AgentRunStatus
  messages: AgentMessage[]
  /** Canonical provider-neutral transcript, including matched tool calls/results. */
  history?: HistoryMessage[]
  createdAt: string
  updatedAt: string
  activeRunId?: string
  planReady: boolean
  tokenCount: number
  lastRunMetrics?: AgentRunMetrics
  error?: string
}

export interface AgentModelDefaults {
  model: string
  reasoningEffort: AgentReasoningEffort
}

export interface AgentSessionsData {
  sessions: AgentSession[]
  activeSessionId: string | null
  modelDefaultsByProvider: Partial<Record<AgentProvider, AgentModelDefaults>>
}

export type AgentMemoryActor = 'agent' | 'user'

export interface AgentMemory {
  id: string
  content: string
  createdAt: string
  updatedAt: string
  createdBy: AgentMemoryActor
  updatedBy: AgentMemoryActor
}

export interface AgentMemoryWithRevision extends AgentMemory {
  revision: string
}

export interface AgentMemoriesData {
  version: 1
  memories: AgentMemory[]
}

export interface AgentMemoryListResult {
  memories: AgentMemoryWithRevision[]
  limits: {
    maximumMemories: number
    maximumMemoryCharacters: number
    maximumTotalCharacters: number
  }
}

export interface AgentPatchOperation {
  op: 'add' | 'replace' | 'remove'
  path: string
  value?: unknown
}

export interface AgentLintDiagnostic {
  severity: 'warning' | 'error'
  message: string
  path?: string
  position?: number
  length?: number
  name?: string
}

export interface AgentStreamEvent {
  sessionId: string
  runId?: string
  type:
    | 'session'
    | 'thinking'
    | 'text_delta'
    | 'progress_reset'
    | 'message'
    | 'tool'
    | 'approval'
    | 'done'
    | 'error'
  session?: AgentSession
  delta?: string
  message?: AgentMessage
  toolCall?: AgentToolCall
  error?: string
}
