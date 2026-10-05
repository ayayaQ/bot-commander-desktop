import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import type { BCFDInteractionAction, BCFDInteractionCommand } from '../../main/types/types'
import type {
  AgentValidationReport,
  AgentValidationRequest,
  AgentValidationStep
} from '../agentValidationTypes'
import { decodeBCFDCommand } from '../commandCodec'
import { runAgentValidation } from './agentValidation'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'
import { createPlaygroundState, type PlaygroundState } from './types'

const memberRole = '200000000000000002'
const welcomeTemplate =
  'Welcome to $server, $name! You are member #$memberCount.\n' +
  'Please read the rules and enjoy your stay!'
const counterTemplate =
  '$eval\n' +
  'if (!botState.count) botState.count = 0;\n' +
  'botState.count++;\n' +
  'return "This command has been used " + botState.count + " times!";\n' +
  '$halt'

function command(patch = {}) {
  return decodeBCFDCommand({
    id: 'reference-command',
    command: '!welcome',
    commandDescription: 'Reference acceptance command',
    type: 0,
    channelMessage: welcomeTemplate,
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command
}

function action(patch: Partial<BCFDInteractionAction> = {}): BCFDInteractionAction {
  return {
    sendChannelMessage: true,
    channelMessage: 'Choose your member role',
    sendPrivateMessage: false,
    privateMessage: '',
    sendChannelEmbed: false,
    channelEmbed: command().channelEmbed,
    sendPrivateEmbed: false,
    privateEmbed: command().privateEmbed,
    isRoleAssigner: false,
    roleToAssign: '',
    isKick: false,
    isBan: false,
    isVoiceMute: false,
    targetUserOptionName: '',
    deleteX: false,
    deleteNum: 0,
    ephemeral: true,
    deferReply: false,
    buttons: [],
    ...patch
  }
}

function request(
  candidate: AgentValidationRequest['candidate'],
  state: PlaygroundState,
  steps: AgentValidationStep[],
  candidateKind: AgentValidationRequest['candidateKind'] = 'command'
): AgentValidationRequest {
  return {
    candidateKind,
    candidate,
    candidateHash: 'explicit-reference-candidate',
    baseRevision: null,
    fixtureHash: 'explicit-reference-fixture',
    wrapEvalInIIFE: true,
    suite: { cases: [{ name: 'reference sequence', state, steps }] }
  }
}

function expectPassed(report: AgentValidationReport): void {
  expect(report.outcome).toBe('passed')
  expect(report.timedOut).toBe(false)
  expect(report.cancelled).toBe(false)
  expect(report.truncated).toBe(false)
  for (const step of report.cases[0].steps) {
    expect(step.outcome).toBe('passed')
    expect(step.assertions.every((assertion) => assertion.actualPresent && assertion.passed)).toBe(
      true
    )
  }
}

let sandboxFactory: ScriptSandboxFactory
beforeAll(async () => {
  sandboxFactory = createScriptSandboxFactory(await getQuickJS())
})

describe('ordinary reference acceptance sequences', () => {
  it('renders the documented welcome template exactly on a supported message command', () => {
    // The tutorial uses Member Join. This only exercises its response on message-received;
    // GuildMemberAdd dispatch is not implemented by the offline runner.
    const state = createPlaygroundState()
    const report = runAgentValidation(
      request(command(), state, [
        {
          kind: 'message',
          senderId: state.members[0].id,
          content: '!welcome',
          assertions: [
            { path: '/outcome', equals: 'executed' },
            {
              path: '/effects/messages/0/content',
              equals:
                'Welcome to Playground server, <@100000000000000001>! You are member #3.\n' +
                'Please read the rules and enjoy your stay!'
            },
            { path: '/effects/messages/length', equals: 1 }
          ]
        }
      ])
    )
    expectPassed(report)
    expect(report.coverage).toMatchObject({ executed: 1, blocked: 0, unsupported: 0 })
    expect(state.messages).toEqual([])
  })

  it('increments a counter, preserves it and its cooldown on denial, then increments at expiry', () => {
    const state = createPlaygroundState()
    state.clockMs = 10_000
    const senderId = state.members[0].id
    const cooldown = { [`reference-command:user:${senderId}`]: 10_000 }
    const successful = (count: number, clockMs: number): AgentValidationStep => ({
      kind: 'message',
      senderId,
      content: '!count',
      advanceClockMs: count === 1 ? 0 : 1000,
      assertions: [
        { path: '/outcome', equals: 'executed' },
        {
          path: '/effects/messages/0/content',
          equals: `This command has been used ${count} times!`
        },
        { path: '/state/botState/count', equals: count },
        { path: '/effects/botStateChanges/0/after', equals: count },
        {
          path: '/state/cooldowns',
          equals: { [`reference-command:user:${senderId}`]: clockMs }
        },
        { path: '/effects/cooldownChanges/0/after', equals: clockMs }
      ]
    })
    const report = runAgentValidation(
      request(
        command({
          command: '!count',
          channelMessage: counterTemplate,
          cooldown: 2,
          cooldownType: 'User'
        }),
        state,
        [
          successful(1, 10_000),
          {
            kind: 'message',
            senderId,
            content: '!count',
            advanceClockMs: 1000,
            assertions: [
              { path: '/outcome', equals: 'blocked' },
              { path: '/reason', equals: 'Cooldown; 1s remaining' },
              {
                path: '/effects/messages/0/content',
                equals: 'This command is on cooldown. Try again in 1s.'
              },
              { path: '/state/botState/count', equals: 1 },
              { path: '/effects/botStateChanges/length', equals: 0 },
              { path: '/state/cooldowns', equals: cooldown },
              { path: '/effects/cooldownChanges/length', equals: 0 },
              { path: '/state/clockMs', equals: 11_000 }
            ]
          },
          successful(2, 12_000)
        ]
      ),
      sandboxFactory
    )
    expectPassed(report)
    expect(report.coverage).toMatchObject({ matched: 3, executed: 2, blocked: 1 })
    expect(report.cases[0].steps[1].expectedNegative).toBe(true)
    expect(state.botState).toEqual({})
    expect(state.cooldowns).toEqual({})
    expect(state.clockMs).toBe(10_000)
  })

  it('allows the ephemeral role button recipient and leaves all members unchanged for another user', () => {
    const state = createPlaygroundState()
    const recipient = state.members[1]
    const wrongRecipient = state.members[2]
    const originalMembers = structuredClone(state.members)
    const candidate: BCFDInteractionCommand = {
      id: 'reference-interaction',
      commandName: 'member',
      commandDescription: 'Choose the member role',
      options: [],
      isRegistered: false,
      rootAction: action({
        buttons: [
          {
            customId: 'member-role',
            label: 'Member',
            style: 1,
            disabled: false,
            action: action({
              channelMessage: 'Member role toggled for $namePlain',
              isRoleAssigner: true,
              roleToAssign: memberRole
            })
          }
        ]
      })
    }
    const report = runAgentValidation(
      request(
        candidate,
        state,
        [
          {
            kind: 'slash',
            senderId: recipient.id,
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: 'Choose your member role' },
              { path: '/effects/messages/0/id', equals: 1 },
              { path: '/effects/messages/0/ephemeral', equals: true },
              { path: '/effects/messages/0/recipient', equals: recipient.id },
              { path: '/effects/messages/0/buttons/0/customId', equals: 'member-role' },
              { path: '/effects/memberChanges/length', equals: 0 }
            ]
          },
          {
            kind: 'button',
            senderId: wrongRecipient.id,
            messageId: 1,
            customId: 'member-role',
            assertions: [
              { path: '/outcome', equals: 'blocked' },
              { path: '/reason', equals: 'Button message is unavailable to this fake sender' },
              { path: '/effects/messages/length', equals: 0 },
              { path: '/effects/memberChanges/length', equals: 0 },
              { path: '/state/members', equals: originalMembers }
            ]
          },
          {
            kind: 'button',
            senderId: recipient.id,
            messageId: 1,
            customId: 'member-role',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: 'Member role toggled for Sam' },
              { path: '/effects/messages/0/recipient', equals: recipient.id },
              { path: '/effects/memberChanges/length', equals: 1 },
              { path: '/state/members/1/roles', equals: [memberRole] },
              { path: '/state/members/0', equals: originalMembers[0] },
              { path: '/state/members/2', equals: originalMembers[2] }
            ]
          }
        ],
        'interaction'
      )
    )
    expectPassed(report)
    expect(report.coverage).toMatchObject({ matched: 3, executed: 2, blocked: 1 })
    expect(report.cases[0].steps[1].expectedNegative).toBe(true)
    // Fake role toggles do not simulate Discord ManageRoles permission or role hierarchy.
    expect(recipient.permissions).toEqual([])
    expect(state.members).toEqual(originalMembers)
    expect(state.messages).toEqual([])
  })
})
