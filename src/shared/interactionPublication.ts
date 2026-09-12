export type PublicationOperation = 'sync' | 'register' | 'unregister'

export type PublicationErrorCode =
  | 'bot-required'
  | 'server-missing'
  | 'duplicate-names'
  | 'permissions'
  | 'network'
  | 'discord'
  | 'save-failed'
  | 'scope-save-failed'
  | 'connection-changed'
  | 'command-missing'

export interface PublicationError {
  code: PublicationErrorCode
  detail?: string
}

export interface PublicationTarget {
  guildId: string
  commandIds: string[]
  error?: PublicationError
}

export interface InteractionPublicationState {
  revision: number
  busy: boolean
  operation: PublicationOperation
  pendingIds: string[]
  failedIds: string[]
  staleIds: string[]
  targets: PublicationTarget[]
  error?: PublicationError
  completed: boolean
}

export function emptyPublicationState(): InteractionPublicationState {
  return {
    revision: 0,
    busy: false,
    operation: 'sync',
    pendingIds: [],
    failedIds: [],
    staleIds: [],
    targets: [],
    completed: false
  }
}
