import type { CanonicalBCFDCommand } from './commandCodec'
import type { CommandEmbed } from './commandCapabilities'
import type {
  BCFDInteractionButton,
  BCFDInteractionCommand,
  BCFDSlashCommandOption
} from '../main/types/types'

export type PlaygroundMember = {
  id: string
  name: string
  roles: string[]
  admin: boolean
  status: 'active' | 'kicked' | 'banned'
  muted: boolean
}
export type PlaygroundFixture = {
  guildId: string
  channelId: string
  channelName: string
  nsfw: boolean
  members: PlaygroundMember[]
  botState: Record<string, unknown>
}
export type PlaygroundOutput = {
  destination: string
  text?: string
  embed?: CommandEmbed
  reply: boolean
  ephemeral?: boolean
  buttons?: PlaygroundButton[]
  interactionCommandId?: string
  interactionOptions?: Record<string, PlaygroundInteractionValue>
}
export type PlaygroundButton = Pick<
  BCFDInteractionButton,
  'customId' | 'label' | 'style' | 'disabled'
> & {
  path: string[]
}
export type PlaygroundTrace = {
  command: string
  status: 'ran' | 'filtered' | 'unsupported'
  checks: { label: string; passed: boolean }[]
  conditions: string[]
  actions: string[]
  issues: string[]
}
export type PlaygroundRequest = {
  commands: CanonicalBCFDCommand[]
  interactions?: BCFDInteractionCommand[]
  fixture: PlaygroundFixture
  senderId: string
  message: string
  interaction?: PlaygroundInteractionInvocation
}
export type PlaygroundInteractionValue = string | number | boolean
export type PlaygroundInteractionInvocation = {
  commandId: string
  options: Record<string, PlaygroundInteractionValue>
  buttonPath?: string[]
}
export type PlaygroundResult = {
  fixture: PlaygroundFixture
  outputs: PlaygroundOutput[]
  traces: PlaygroundTrace[]
  stateBefore: Record<string, unknown>
  stateAfter: Record<string, unknown>
}

export type PlaygroundInteractionOption = BCFDSlashCommandOption
export function createPlaygroundFixture(): PlaygroundFixture {
  return {
    guildId: '100000000000000001',
    channelId: '200000000000000001',
    channelName: 'playground',
    nsfw: false,
    members: [
      {
        id: '300000000000000001',
        name: 'Alex',
        roles: ['moderator'],
        admin: true,
        status: 'active',
        muted: false
      },
      {
        id: '300000000000000002',
        name: 'Sam',
        roles: ['member'],
        admin: false,
        status: 'active',
        muted: false
      },
      {
        id: '300000000000000003',
        name: 'Riley',
        roles: [],
        admin: false,
        status: 'active',
        muted: false
      }
    ],
    botState: {}
  }
}
