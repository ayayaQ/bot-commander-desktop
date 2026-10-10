/** Renderer-safe controls for the separate, explicitly launched agent MCP client. */
export type AgentMcpCatalogKind = 'tools' | 'resources' | 'resourceTemplates'
export type AgentMcpCategoryState = 'not-requested' | 'unsupported' | 'ready' | 'stale' | 'error'
export interface AgentMcpServerConfig {
  readonly id: string
  readonly label: string
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly protocol: 'legacy' | '2026-07-28'
  readonly environment: readonly string[]
}
export interface AgentMcpCatalogEntryStatus {
  readonly remoteKey: string
  readonly alias: string
  readonly state: 'available' | 'quarantined'
  readonly descriptorJson?: string
  readonly reason?: string
}
export interface AgentMcpCategoryStatus {
  readonly state: AgentMcpCategoryState
  readonly count: number
  readonly available: number
  readonly entries: readonly AgentMcpCatalogEntryStatus[]
  readonly reason?: string
}
export interface AgentMcpServerStatus {
  readonly server: AgentMcpServerConfig
  readonly state: 'disabled' | 'connecting' | 'connected' | 'error'
  readonly message?: string
  readonly cleanupPending: boolean
  readonly catalog?: {
    readonly generation: number
    readonly tools: AgentMcpCategoryStatus
    readonly resources: AgentMcpCategoryStatus
    readonly resourceTemplates: AgentMcpCategoryStatus
  }
}
export interface AgentMcpStatus {
  readonly revision: string
  readonly servers: readonly AgentMcpServerStatus[]
  readonly environmentNames: readonly string[]
  readonly paused: boolean
}
export interface AgentMcpLaunchPreparation {
  readonly token: string
  readonly serverId: string
  readonly disclosure: string
  readonly launchDigest: string
  readonly expiresAt: number
}
export interface AgentMcpStartResult {
  readonly started: boolean
  readonly status: AgentMcpStatus
}
