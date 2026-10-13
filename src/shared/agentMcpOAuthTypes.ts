import type { AgentMcpLaunchPreparation, AgentMcpStatus } from './agentMcpTypes'

/** Public launch-only settings. Credentials are never accepted by renderer IPC. */
export interface AgentMcpOAuthRegistrationSettings {
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
  readonly clientName: string
}
export interface AgentMcpOAuthPublicClient {
  readonly id: string
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
}
export interface AgentMcpOAuthReview {
  readonly token: string
  readonly kind: 'registration' | 'sign-in'
  readonly serverId: string
  readonly configRevision: string
  readonly disclosure: string
  readonly expiresAt: number
}
export interface AgentMcpOAuthStatus {
  readonly state:
    | 'unconfigured'
    | 'configured'
    | 'preparing-registration'
    | 'registration-prepared'
    | 'registering'
    | 'preparing'
    | 'prepared'
    | 'awaiting-user'
    | 'exchanging'
    | 'authorized'
    | 'needs-sign-in'
    | 'cancelled'
    | 'failed'
  readonly hasClient: boolean
  readonly revision: string
  readonly message?: string
}
export interface AgentMcpOAuthSignInResult {
  readonly status: AgentMcpStatus
  /** A successful grant still needs this separate, fresh MCP connection approval. */
  readonly preparation: AgentMcpLaunchPreparation
}
