export type McpAccessMode = 'read-only' | 'read-write'

export interface McpConfig {
  enabled: boolean
  accessMode: McpAccessMode
  port: number
}

export interface McpServerStatus extends McpConfig {
  running: boolean
  endpoint: string
  tokenConfigured: boolean
  secureStorageAvailable: boolean
  activeRequests: number
  lastClient?: string
  error?: string
}

export interface McpActivityEntry {
  id: string
  timestamp: string
  client: string
  tool: string
  targetLabel?: string
  kind: 'read' | 'write'
  status: 'running' | 'success' | 'error'
  durationMs?: number
  summary?: string
}

export type ResourceChangeKind =
  'commands' | 'interactions' | 'bot-state' | 'startup-js' | 'settings' | 'memories'

export type ResourceChangeSource = 'renderer' | 'agent' | 'mcp' | 'system'

export interface ResourceChangedEvent {
  kind: ResourceChangeKind
  source: ResourceChangeSource
  revision: string
  targetId?: string
}
