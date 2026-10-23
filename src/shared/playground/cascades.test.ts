import { describe, expect, it } from 'vitest'
import { decodeBCFDCommand } from '../commandCodec'
import type { AgentValidationRequest } from '../agentValidationTypes'
import type { BCFDInteractionCommand } from '../../main/types/types'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { runAgentValidation } from './agentValidation'
import { validateAgentValidationState } from './agentValidationFixtures'
import { normalizeWorld, PLAYGROUND_BOT_ID } from './world'
import {
  createPlaygroundState,
  type PlaygroundMessageRequest,
  type PlaygroundRequest,
  type PlaygroundResult
} from './types'
import { enqueueGatewayEvent, runGatewayCascade } from './cascades'
import { schedulerFor, withScheduler } from './scheduling'

const command = (patch = {}) =>
  decodeBCFDCommand({
    id: 'moderate',
    command: '!ban',
    type: 0,
    commandDescription: 'Cascade',
    channelMessage: '',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command

function scenario(): PlaygroundMessageRequest {
  const state = normalizeWorld()
  state.timing = {
    operations: {
      'member.banned': { latencyMs: 20 },
      'message.send': { latencyMs: 5 }
    }
  }
  return {
    state,
    senderId: state.members[0].id,
    content: `!ban <@${state.members[1].id}>`,
    commands: [
      command({ isBan: true }),
      command({ id: 'on-ban', type: 4, channelMessage: 'banned' }),
      command({ id: 'on-leave', type: 3, channelMessage: 'left' }),
      command({ id: 'bot-loop', command: '*', channelMessage: 'must not run' })
    ]
  }
}

function validation(input = scenario(), candidate = input.commands[0]): AgentValidationRequest {
  return {
    candidateKind: 'command',
    candidate,
    candidateHash: 'candidate',
    fixtureHash: 'fixture',
    baseRevision: null,
    wrapEvalInIIFE: true,
    suite: {
      version: 3,
      resources: { commands: input.commands, interactions: [] },
      cases: [
        {
          name: 'cascade',
          state: input.state,
          steps: [
            {
              kind: 'message',
              senderId: input.senderId,
              content: input.content,
              context: { guildId: input.state.guildId, channelId: input.state.channelId },
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/effects/messages/0/content', equals: 'banned' }
              ]
            }
          ]
        }
      ]
    }
  }
}

describe('offline gateway cascades', () => {
  it('replays a multi-command ban/leave cascade with complete causal identity and timing', async () => {
    const input = scenario()
    // Wildcard listens to the original input too; omit it for this trace.
    input.commands.pop()
    const result = await runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.incomplete).toEqual([])
    expect(result.state.messages.slice(1).map((item) => item.content)).toEqual(['banned', 'left'])
    expect(result.state.events!.map((event) => [event.kind, event.status])).toEqual([
      ['message', 'dispatched'],
      ['memberBan', 'dispatched'],
      ['memberLeave', 'dispatched'],
      ['message', 'ignored'],
      ['message', 'ignored']
    ])
    const [root, ban, leave] = result.state.events!
    expect(root.messageId).toBe(result.state.messages[0].id)
    expect(ban).toMatchObject({
      parentEventId: root.id,
      parentOperationId: 'operation:1',
      senderId: input.state.members[1].id,
      context: { guildId: input.state.guildId, channelId: input.state.channelId },
      depth: 1,
      scheduledAt: 20,
      dispatchedAt: 20
    })
    expect(leave.dispatchedAt).toBe(25)
    expect(result.state.operations!.map((operation) => [operation.id, operation.eventId])).toEqual([
      ['operation:1', root.id],
      ['operation:2', ban.id],
      ['operation:3', leave.id]
    ])
    expect(result.resources!.find((item) => item.resourceId === 'on-leave')!.executed).toBe(true)
    expect(await runMessage(input)).toEqual(result)
    expect(input.state.messages).toEqual([])
    expect(validateAgentValidationState(JSON.parse(JSON.stringify(result.state))).events).toEqual(
      result.state.events
    )
  })

  it('filters generated bot messages/reactions/DMs and preserves their message identities', async () => {
    const state = normalizeWorld()
    const result = await runMessage({
      state,
      senderId: state.members[0].id,
      content: '!test',
      commands: [
        command({
          command: '!test',
          channelMessage: 'hello',
          privateMessage: 'private',
          reaction: 'ok'
        }),
        command({ id: 'reaction', command: 'ok', type: 5, channelMessage: 'loop' })
      ]
    })
    expect(result.errors).toEqual([])
    const events = result.state.events!.slice(1)
    expect(events.map((event) => event.kind).sort()).toEqual(['dm', 'message', 'reaction'])
    expect(
      events.every((event) => event.status === 'ignored' && event.senderId === PLAYGROUND_BOT_ID)
    ).toBe(true)
    expect(events.find((event) => event.kind === 'reaction')!.messageId).toBe(
      result.state.messages[0].id
    )
    expect(events.find((event) => event.kind === 'dm')!.context.guildId).toBeNull()
    expect(result.resources!.find((item) => item.resourceId === 'reaction')!.executed).toBe(false)
    expect(result.state.messages).toHaveLength(3)
  })

  it('does not emit success events for failed moderation, preserving earlier successful effects', async () => {
    const input = scenario()
    input.commands = [command({ isBan: true, channelMessage: 'before failure' }), input.commands[1]]
    input.state.timing!.operations!['member.banned'].failure = 'denied'
    const result = await runMessage(input)
    expect(result.errors.join()).toContain('denied')
    expect(result.state.messages[1].content).toBe('before failure')
    expect(result.state.events!.map((event) => event.kind)).toEqual(['message', 'message'])
    expect(
      result.state.operations!.find((operation) => operation.name === 'member.banned')!.status
    ).toBe('failed')
  })

  it('retains moderation and earlier handlers when a downstream handler fails', async () => {
    const input = scenario()
    input.commands.pop()
    input.commands[2].specificChannel = '999'
    const result = await runMessage(input)
    expect(result.state.members[1].banned).toBe(true)
    expect(result.state.messages[1].content).toBe('banned')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.resources!.find((item) => item.resourceId === 'on-ban')!.outcome).toBe('executed')
    expect(result.resources!.find((item) => item.resourceId === 'on-leave')!.outcome).toBe('error')
    const report = await runAgentValidation(validation(input))
    expect(report.outcome).toBe('failed')
  })

  it('keeps the same user isolated across two guilds and honors handler server whitelists', async () => {
    const input = scenario()
    input.commands.pop()
    const world = input.state.world!
    const guildId = '900000000000000010',
      channelId = '900000000000000011'
    world.guilds.push({ ...world.guilds[0], id: guildId, name: 'Other' })
    world.channels.push({ ...structuredClone(world.channels[0]), id: channelId, guildId })
    world.roles.push({ id: guildId, guildId, name: '@everyone', permissions: [], position: 0 })
    world.memberships.push(
      ...world.memberships.map((member) => ({
        ...structuredClone(member),
        guildId,
        roles: [],
        permissions: []
      }))
    )
    input.commands[2].serverWhitelist = guildId
    const result = await runMessage(input)
    expect(result.errors).toEqual([])
    expect(
      result.state.world!.memberships.find(
        (member) => member.guildId === guildId && member.id === input.state.members[1].id
      )!.banned
    ).toBe(false)
    expect(
      result.state.events!.every((event) => event.context.guildId === input.state.guildId)
    ).toBe(true)
    expect(result.resources!.find((item) => item.resourceId === 'on-leave')!.outcome).toBe(
      'blocked'
    )
    expect(result.state.messages.slice(1).map((message) => message.content)).toEqual(['banned'])
  })

  it('suppresses duplicate removal/ban notifications from repeated successful effects', async () => {
    const input = scenario()
    input.commands = [command({ id: 'one', isBan: true }), command({ id: 'two', isBan: true })]
    const result = await runMessage(input)
    expect(result.state.operations).toHaveLength(2)
    expect(result.state.events!.map((event) => event.kind)).toEqual([
      'message',
      'memberBan',
      'memberLeave'
    ])
  })

  it('records kick removal and ignores bot-member removal, with no fictitious mute/role events', async () => {
    const input = scenario()
    input.state.world!.users.find((user) => user.id === input.state.members[1].id)!.bot = true
    input.commands = [command({ isKick: true }), input.commands[2]]
    const result = await runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.state.events![1]).toMatchObject({ kind: 'memberLeave', status: 'ignored' })
    expect(result.state.messages).toHaveLength(1)
    const role = await runMessage({
      state: normalizeWorld(),
      commands: [
        command({
          command: '!test',
          isRoleAssigner: true,
          roleToAssign: '200000000000000002',
          isVoiceMute: true
        })
      ],
      senderId: input.senderId,
      content: `!test <@${input.state.members[1].id}>`
    })
    expect(role.state.events).toHaveLength(1)
  })

  it('counts the exact downstream candidate and cannot credit unrelated selected commands', async () => {
    const input = scenario()
    input.commands.pop()
    const valid = await runAgentValidation(validation(input, input.commands[1]))
    expect(valid.outcome).toBe('passed')
    expect(valid.coverage.executed).toBe(1)
    expect(valid.cases[0].steps[0].effects.events).toStrictEqual(
      JSON.parse(JSON.stringify(valid.cases[0].steps[0].effects.events))
    )
    expect(valid.cases[0].steps[0].effects.events![1].resources![0].resourceId).toBe('on-ban')
    const unrelated = await runAgentValidation(
      validation(input, command({ id: 'unrelated', command: '!other' }))
    )
    expect(unrelated.outcome).toBe('unmatched')
    expect(unrelated.coverage.executed).toBe(0)
    expect(await runAgentValidation(validation(input, input.commands[1]))).toEqual(valid)
  })

  it('supports assertions over the complete causal trace', async () => {
    const input = scenario()
    input.commands.pop()
    const request = validation(input)
    request.suite.cases[0].steps[0].assertions.push(
      { path: '/effects/events/1/parentOperationId', equals: 'operation:1' },
      { path: '/effects/events/2/parentEventId', equals: 'event:1' },
      { path: '/effects/operations/2/eventId', equals: 'event:3' },
      { path: '/effects/events/4/status', equals: 'ignored' }
    )
    expect((await runAgentValidation(request)).outcome).toBe('passed')
  })

  it.each([{ maxDepth: 0 }, { maxEvents: 201 }, { maxWork: 1.5 }, { unknown: 1 }])(
    'rejects invalid fixture cascade limits %j',
    (limits) => {
      const state = normalizeWorld()
      state.cascades = limits
      expect(() => validateAgentValidationState(state)).toThrow('cascade limits')
    }
  )

  it('fails closed on event/work budget exhaustion even if assertions expect the partial effects', async () => {
    for (const limits of [{ maxEvents: 1 }, { maxWork: 1 }]) {
      const input = scenario()
      input.commands.pop()
      input.state.cascades = limits
      const result = await runMessage(input)
      expect(result.incomplete!.length).toBeGreaterThan(0)
      const report = await runAgentValidation(validation(input))
      expect(report.outcome).toBe('not_run')
      expect(report.cases[0].steps[0].expectedNegative).toBe(false)
    }
  })

  it.each([{ maxDepth: 3 }, { maxEvents: 4 }, { maxWork: 4 }])(
    'terminates a host-driven causal loop with %j',
    async (limits) => {
      const state = createPlaygroundState()
      state.cascades = limits
      const input = { state, senderId: state.members[0].id, commands: [], content: 'loop' }
      const emit = async (request: PlaygroundRequest): Promise<PlaygroundResult> =>
        withScheduler(request.state, async () => {
          const parent = request.state.events!.at(-1)!
          enqueueGatewayEvent(
            request.state,
            { id: `operation:${parent.id}`, eventId: parent.id, index: 0, name: 'test', args: [] },
            {
              kind: 'memberJoin',
              senderId: input.senderId,
              content: '',
              context: { guildId: state.guildId, channelId: state.channelId }
            }
          )
          return { state: request.state, trace: [], errors: [], resources: [] }
        })
      const result = await runGatewayCascade(input, emit, emit)
      expect(result.incomplete!.join()).toMatch(/budget/)
      expect(result.state.events!.length).toBeLessThanOrEqual(5)
      expect(result.state.events!.some((event) => event.status === 'queued')).toBe(false)
    }
  )

  it('discards pending notifications on cancellation/disposal and starts reset runs without stale events', async () => {
    const state = createPlaygroundState()
    const controller = new AbortController()
    let cancelledState = state
    const input = {
      state,
      senderId: state.members[0].id,
      commands: [],
      content: 'cancel',
      signal: controller.signal
    }
    await expect(
      runGatewayCascade(
        input,
        async (request) => {
          cancelledState = request.state
          return withScheduler(request.state, async () => {
            enqueueGatewayEvent(
              request.state,
              { id: 'operation:1', eventId: 'event:1', index: 0, name: 'test', args: [] },
              {
                kind: 'memberJoin',
                senderId: input.senderId,
                content: '',
                context: { guildId: state.guildId, channelId: state.channelId }
              }
            )
            controller.abort()
            schedulerFor(request.state)!.dispose()
            return { state: request.state, trace: [], errors: [] }
          })
        },
        async () => {
          throw new Error('Cancelled event dispatched')
        }
      )
    ).rejects.toThrow(/cancel/)
    expect(cancelledState.events![1].status).toBe('cancelled')
    const reset = await runMessage({
      state: createPlaygroundState(),
      senderId: input.senderId,
      commands: [],
      content: 'reset'
    })
    expect(reset.state.events).toHaveLength(1)
    expect(reset.incomplete).toEqual([])
    expect(state.events).toBeUndefined()
  })

  it('cascades slash moderation through explicit selected traditional snapshots', async () => {
    const input = scenario()
    const interaction: BCFDInteractionCommand = {
      id: 'slash',
      commandName: 'ban',
      commandDescription: 'Ban',
      isRegistered: false,
      options: [{ name: 'target', description: 'Member', type: 6, required: true }],
      rootAction: {
        sendChannelMessage: true,
        channelMessage: 'done',
        sendPrivateMessage: false,
        privateMessage: '',
        sendChannelEmbed: false,
        channelEmbed: command().channelEmbed,
        sendPrivateEmbed: false,
        privateEmbed: command().privateEmbed,
        isRoleAssigner: false,
        roleToAssign: '',
        isKick: false,
        isBan: true,
        isVoiceMute: false,
        targetUserOptionName: 'target',
        deleteX: false,
        deleteNum: 0,
        ephemeral: true,
        deferReply: false,
        buttons: []
      }
    }
    const result = await runInteraction({
      kind: 'slash',
      state: input.state,
      senderId: input.senderId,
      commands: [input.commands[1]],
      interactions: [interaction],
      commandId: 'slash',
      options: { target: input.state.members[1].id }
    })
    expect(result.errors).toEqual([])
    expect(result.state.messages.map((message) => message.content)).toEqual(['done', 'banned'])
    expect(result.state.events!.map((event) => event.kind)).toEqual([
      'slash',
      'memberBan',
      'memberLeave',
      'message'
    ])
    const test = validation(input, input.commands[1])
    test.suite.resources!.interactions = [interaction]
    test.suite.cases[0].steps = [
      {
        kind: 'slash',
        commandId: 'slash',
        senderId: input.senderId,
        options: { target: input.state.members[1].id },
        context: { guildId: input.state.guildId, channelId: input.state.channelId },
        assertions: [
          { path: '/outcome', equals: 'executed' },
          { path: '/effects/messages/1/content', equals: 'banned' }
        ]
      }
    ]
    const report = await runAgentValidation(test)
    expect(report.outcome).toBe('passed')
    expect(report.coverage.executed).toBe(1)
  })
})
