import type { AgentValidationReport } from './agentValidationTypes'
import type { HistoryMessage } from '@ayayaq/vivi'
import type {
  MemoriesData,
  Memory,
  MemoryActor,
  MemoryListResult,
  MemoryWithRevision
} from '@ayayaq/vivi/extensions/memory'
import type { DesktopReasoningEffort } from './aiModelTypes'
import type { AgentAutoReviewEnrollment, AgentDecisionDisplay } from './agentAutoReview'

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
  status:
    'running' | 'reviewing' | 'waiting_approval' | 'approved' | 'rejected' | 'completed' | 'error'
  approvalId?: string
  decision?: AgentDecisionDisplay
  /** Display/recovery evidence only. This does not confer permission or reusable approval. */
  mcp?: {
    runId: string
    operationDigest: string
    serverId: string
    catalogKind: 'tools' | 'resources'
    remoteKey: string
    disclosure?: string
    outcome: 'pending' | 'not-sent' | 'confirmed' | 'unknown'
    requestSent?: boolean
    checkpointUnconfirmed?: boolean
  }
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
  autoReviewEnrollment?: AgentAutoReviewEnrollment
  autoReviewMigrationRequired?: boolean
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

export type AgentMemoryActor = MemoryActor
export type AgentMemory = Memory
export type AgentMemoryWithRevision = MemoryWithRevision
export type AgentMemoriesData = MemoriesData
export type AgentMemoryListResult = MemoryListResult

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
