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
}
export type FakeRole = { id: string; name: string }
export type PlaygroundMessage = {
  id: number
  author: string
  content: string
  kind: 'user' | 'bot' | 'dm'
  recipient?: string
  replyTo?: number
  embed?: BCFDEmbedMessageTemplate
  deleted?: boolean
  ephemeral?: boolean
  deferred?: boolean
  buttons?: BCFDInteractionButton[]
}
export type PlaygroundState = {
  /** Local JSON state only. No saved/live bot state is read or written. */
  botState: Record<string, unknown>
  variables: Record<string, unknown>
  cooldowns: Record<string, number>
  clockMs: number
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
}
export type PlaygroundResult = { state: PlaygroundState; trace: string[]; errors: string[] }
export type PlaygroundMessageRequest = {
  kind?: 'message'
  state: PlaygroundState
  commands: BCFDCommand[]
  senderId: string
  content: string
}
export type PlaygroundInteractionRequest = {
  kind: 'slash' | 'button'
  state: PlaygroundState
  interactions: BCFDInteractionCommand[]
  senderId: string
  commandId?: string
  options?: Record<string, string | number | boolean>
  messageId?: number
  customId?: string
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
    messages: [],
    nextId: 1
  }
}
