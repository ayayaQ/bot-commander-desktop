export type AgentMode = 'manual' | 'auto' | 'planning'
export type AgentRunStatus = 'idle' | 'running' | 'waiting_approval' | 'completed' | 'error' | 'cancelled' | 'interrupted'

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  targetLabel?: string
  status: 'running' | 'waiting_approval' | 'approved' | 'rejected' | 'completed' | 'error'
  result?: unknown
  error?: string
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
  documentationCalls: number
  uniqueDocumentationCalls: number
  duplicateDocumentationCalls: number
  documentationResultChars: number
}

export interface AgentSession {
  id: string
  title: string
  mode: AgentMode
  model: string
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  status: AgentRunStatus
  messages: AgentMessage[]
  createdAt: string
  updatedAt: string
  activeRunId?: string
  tokenCount: number
  lastRunMetrics?: AgentRunMetrics
  error?: string
}

export interface AgentSessionsData {
  sessions: AgentSession[]
  activeSessionId: string | null
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
  type: 'session' | 'thinking' | 'message' | 'tool' | 'approval' | 'done' | 'error'
  session?: AgentSession
  delta?: string
  message?: AgentMessage
  toolCall?: AgentToolCall
  error?: string
}
