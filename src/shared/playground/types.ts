import type {
  BCFDCommand,
  BCFDEmbedMessageTemplate,
  BCFDInteractionCommand,
  BCFDInteractionButton
} from '../../main/types/types'

export type FakePermission = 'admin' | 'manageMessages' | 'kick' | 'ban' | 'mute'
export type FakeMember = {
  id: string
  name: string
  roles: string[]
  permissions: FakePermission[]
  kicked: boolean
  banned: boolean
  muted: boolean
  bot?: boolean
  nickname?: string
  createdTimestamp?: number
  joinedTimestamp?: number
  voiceChannelId?: string
  manageable?: boolean
}
export type FakeRole = {
  id: string
  name: string
  color?: number
  position?: number
  managed?: boolean
  editable?: boolean
  hoist?: boolean
  mentionable?: boolean
  permissions?: string[]
}
export type FakeChannel = {
  deleted?: boolean
  id: string
  guildId: string
  name: string
  type: number
  topic: string
  nsfw: boolean
  parentId: string | null
  position: number
  slowmode: number
  overwrites: Record<string, Record<string, boolean>>
  /** DM channels have no guild; guildId is the empty string. */
  recipientId?: string
}
export type PlaygroundWorld = {
  users: { id: string; name: string; bot?: boolean; createdTimestamp?: number }[]
  guilds: { id: string; name: string; ownerId: string }[]
  memberships: (Omit<FakeMember, 'name' | 'bot' | 'createdTimestamp'> & { guildId: string })[]
  roles: (FakeRole & { guildId: string })[]
  channels: FakeChannel[]
}
export type PlaygroundEventContext = { guildId: string | null; channelId: string }
/** Numbers are accepted only by the legacy v2 simulator. Normalized worlds use strings. */
export type PlaygroundMessageId = string | number
export type PlaygroundOperation = {
  id?: string
  eventId?: string
  context?: PlaygroundEventContext
  index: number
  scheduledAt?: number
  startedAt?: number
  completedAt?: number
  failedAt?: number
  cancelledAt?: number
  dueAt?: number
  status?: 'scheduled' | 'started' | 'completed' | 'failed' | 'cancelled'
  truncated?: boolean
  name: string
  args: unknown[]
  result?: unknown
  error?: string
}
export type PlaygroundMessage = {
  id: PlaygroundMessageId
  authorId?: string
  guildId?: string | null
  author: string
  content: string
  kind: 'user' | 'bot' | 'dm'
  recipient?: string
  replyTo?: PlaygroundMessageId
  embed?: BCFDEmbedMessageTemplate
  deleted?: boolean
  ephemeral?: boolean
  deferred?: boolean
  buttons?: BCFDInteractionButton[]
  channelId?: string
  reactions?: string[]
}
export type PlaygroundState = {
  events?: PlaygroundGatewayEvent[]
  cascades?: { maxEvents?: number; maxDepth?: number; maxWork?: number }
  /** Canonical v3 entities. The legacy fields below are the active context projection. */
  world?: PlaygroundWorld
  /** Local JSON state only. No saved/live bot state is read or written. */
  botState: Record<string, unknown>
  variables: Record<string, unknown>
  cooldowns: Record<string, number>
  clockMs: number
  timing?: import('./scheduling').TimingConfiguration
  ai: { response: string; error: string }
  guildId: string
  guildName: string
  channelId: string
  channelName: string
  nsfw: boolean
  members: FakeMember[]
  roles: FakeRole[]
  messages: PlaygroundMessage[]
  nextId: number
  channels?: FakeChannel[]
  randomSeed?: number
  operations?: PlaygroundOperation[]
  failures?: Record<string, string>
  botPermissions?: string[]
  presence?: { status: string; activity: string; text: string }
  startupSource?: string
  strictMocks?: boolean
  aiMocks?: { prompt: string; response?: string; error?: string }[]
  commandCount?: number
}
export type PlaygroundExecutionOutcome =
  'executed' | 'blocked' | 'error' | 'unmatched' | 'unsupported' | 'not_run'
export type PlaygroundResourceResult = {
  eventId?: string
  resourceId: string
  kind: 'command' | 'interaction'
  matched: boolean
  executed: boolean
  outcome: PlaygroundExecutionOutcome
  reason?: string
  error?: string
}
export type PlaygroundResult = {
  state: PlaygroundState
  trace: string[]
  errors: string[]
  /** Modeled template diagnostics rendered inline; execution continues. */
  diagnostics?: string[]
  /** Host limits or missing capabilities; never usable as expected command failures. */
  incomplete?: string[]
  /** Nonfatal adapter delivery failures. */
  warnings?: string[]
  /** Interactive UI notices computed before the worker strips candidate coverage. */
  feedback?: string[]
  /** Explicit engine coverage. Optional only for older UI fixtures; validation fails closed without it. */
  resources?: PlaygroundResourceResult[]
}

/** Structured engine failures retain the existing user-facing error text. */
export class PlaygroundExecutionError extends Error {
  constructor(
    message: string,
    readonly outcome: 'blocked' | 'unmatched' | 'unsupported' | 'error'
  ) {
    super(message)
  }
}
export type PlaygroundMessageRequest = {
  kind?: import('../runtime/dispatch').CommandEvent
  messageId?: PlaygroundMessageId
  context?: PlaygroundEventContext
  state: PlaygroundState
  commands: BCFDCommand[]
  senderId: string
  content: string
  /** Defaults to wrapped eval for ordinary Playground callers. */
  wrapEvalInIIFE?: boolean
  /** Host-only cancellation. Workers cancel by terminating their entire execution. */
  signal?: AbortSignal
}
export type PlaygroundInteractionRequest = {
  kind: 'slash' | 'button'
  state: PlaygroundState
  interactions: BCFDInteractionCommand[]
  /** Explicit selected traditional snapshots available to downstream gateway events. */
  commands?: BCFDCommand[]
  senderId: string
  commandId?: string
  options?: Record<string, string | number | boolean>
  messageId?: PlaygroundMessageId
  context?: PlaygroundEventContext
  customId?: string
  /** Defaults to wrapped eval for ordinary Playground callers. */
  wrapEvalInIIFE?: boolean
  signal?: AbortSignal
}
export type PlaygroundGatewayEvent = {
  id: string
  kind: import('../runtime/dispatch').CommandEvent | 'slash' | 'button'
  senderId: string
  context: PlaygroundEventContext
  content: string
  messageId?: PlaygroundMessageId
  parentEventId?: string
  parentOperationId?: string
  depth: number
  scheduledAt: number
  dispatchedAt?: number
  status: 'queued' | 'dispatched' | 'ignored' | 'cancelled'
  reason?: string
  resources?: PlaygroundResourceResult[]
}
export type PlaygroundRequest = PlaygroundMessageRequest | PlaygroundInteractionRequest
export const PLAYGROUND_LIMITS = {
  input: 16_384,
  template: 16_384,
  output: 32_768,
  commands: 200,
  messages: 300,
  members: 50,
  roles: 50,
  nodes: 10_000,
  depth: 32,
  requestBytes: 2_000_000,
  stateBytes: 65_536,
  timeoutMs: 1500
} as const

export function createPlaygroundState(): PlaygroundState {
  return {
    botState: {},
    variables: {},
    cooldowns: {},
    clockMs: 0,
    ai: { response: '[Simulated AI response]', error: '' },
    guildId: '900000000000000001',
    guildName: 'Playground server',
    channelId: '900000000000000002',
    channelName: 'playground',
    nsfw: false,
    members: [
      {
        id: '100000000000000001',
        name: 'Alex',
        roles: ['200000000000000001'],
        permissions: ['admin'],
        kicked: false,
        banned: false,
        muted: false
      },
      {
        id: '100000000000000002',
        name: 'Sam',
        roles: [],
        permissions: [],
        kicked: false,
        banned: false,
        muted: false
      },
      {
        id: '100000000000000003',
        name: 'Morgan',
        roles: ['200000000000000002'],
        permissions: [],
        kicked: false,
        banned: false,
        muted: false
      }
    ],
    roles: [
      { id: '200000000000000001', name: 'Moderator' },
      { id: '200000000000000002', name: 'Member' }
    ],
    channels: [
      {
        id: '900000000000000002',
        guildId: '900000000000000001',
        name: 'playground',
        type: 0,
        topic: '',
        nsfw: false,
        parentId: null,
        position: 0,
        slowmode: 0,
        overwrites: {}
      }
    ],
    messages: [],
    nextId: 1
  }
}
