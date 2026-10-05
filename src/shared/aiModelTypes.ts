import type { ApiProtocol, ModelCapabilities } from '@ayayaq/vivi/providers/models'

export type AiProvider = 'openai' | 'openrouter'
/** Legacy none is omission. Disabled is an explicit, separately verified override. */
export type DesktopReasoningEffort =
  'none' | 'disabled' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ChatReasoningEffort = Exclude<DesktopReasoningEffort, 'disabled'>

/** Credential-free IPC snapshot for one exact provider/endpoint/model. */
export interface AiModelInfo {
  id: string
  name: string
  description?: string
  contextLength?: number
  supportedParameters?: string[]
  outputModalities?: string[]
  supportsStructuredOutputs?: boolean
  capabilities: ModelCapabilities
  /** Expiry of account-backed display metadata; static facts have no expiry. */
  capabilityExpiresAt?: number
  pricing?: {
    prompt?: string
    completion?: string
    request?: string
    image?: string
    webSearch?: string
    internalReasoning?: string
    inputCacheRead?: string
    inputCacheWrite?: string
  }
}

export function agentProtocol(provider: AiProvider): ApiProtocol {
  return provider === 'openai' ? 'responses' : 'chat-completions'
}

export interface SelectedModelCapabilityRequest {
  model: string
  provider: AiProvider
  purpose: 'agent' | 'chat'
}

export interface SelectedModelCapabilitySnapshot {
  capabilities: ModelCapabilities
  /** Account-backed catalog fact expiry; absent for static documentation/unknown facts. */
  expiresAt?: number
}
