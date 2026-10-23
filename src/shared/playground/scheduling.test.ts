import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { decodeBCFDCommand } from '../commandCodec'
import type { BCFDInteractionCommand } from '../../main/types/types'
import type { AgentValidationRequest } from '../agentValidationTypes'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { runAgentValidation } from './agentValidation'
import { validateAgentValidationState } from './agentValidationFixtures'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'
import { createPlaygroundState } from './types'
import { normalizeWorld } from './world'

const command = (patch = {}) =>
  decodeBCFDCommand({
    id: 'candidate',
    command: '!test',
    commandDescription: 'Timing',
    type: 0,
    channelMessage: 'channel',
    privateMessage: 'dm',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command
const request = (patch = {}) => {
  const state = createPlaygroundState()
  state.timing = {
    operations: {
      'message.send': { latencyMs: 100 },
      'message.dm': { latencyMs: 10 }
    }
  }
  return { state, commands: [command(patch)], senderId: state.members[0].id, content: '!test' }
}
function interaction(): BCFDInteractionCommand {
  return {
    id: 'candidate',
    commandName: 'test',
    commandDescription: 'Timing',
    options: [],
    isRegistered: false,
    rootAction: {
      sendChannelMessage: true,
      channelMessage: 'channel',
      sendPrivateMessage: true,
      privateMessage: 'dm',
      sendChannelEmbed: false,
      channelEmbed: command().channelEmbed,
      sendPrivateEmbed: false,
      privateEmbed: command().privateEmbed,
      isRoleAssigner: true,
      roleToAssign: '200000000000000002',
      isKick: false,
      isBan: false,
      isVoiceMute: false,
      targetUserOptionName: '',
      deleteX: false,
      deleteNum: 0,
      ephemeral: false,
      deferReply: true,
      buttons: []
    }
  }
}
let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})

describe('deterministic operation timing', () => {
  it('replays v3 timing across guilds with scoped permissions and lossless message IDs', async () => {
    const state = normalizeWorld()
    const world = state.world!
    const contextA = { guildId: state.guildId, channelId: state.channelId }
    const contextB = { guildId: '900000000000000010', channelId: '900000000000000011' }
    const owner = world.guilds[0].ownerId
    world.guilds.push({ id: contextB.guildId, name: 'Second guild', ownerId: owner })
    world.channels.push({
      ...structuredClone(world.channels[0]),
      id: contextB.channelId,
      guildId: contextB.guildId
    })
    world.roles.push({
      id: contextB.guildId,
      guildId: contextB.guildId,
      name: '@everyone',
      position: 0,
      permissions: ['ViewChannel']
    })
    world.memberships.push(
      ...world.memberships.map((member) => ({
        ...structuredClone(member),
        guildId: contextB.guildId,
        roles: [],
        permissions: []
      }))
    )
    state.clockMs = 10
    state.timing = { operations: { 'message.send': { latencyMs: 25 } } }
    const validation: AgentValidationRequest = {
      candidateKind: 'command',
      candidate: command({ privateMessage: '' }),
      candidateHash: 'candidate',
      fixtureHash: 'fixture',
      baseRevision: null,
      wrapEvalInIIFE: true,
      suite: {
        version: 3,
        cases: [
          {
            name: 'timed guild isolation',
            state,
            steps: [
              {
                kind: 'message',
                senderId: owner,
                content: '!test',
                context: contextA,
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/operations/0/context', equals: contextA },
                  { path: '/effects/operations/0/completedAt', equals: 35 }
                ]
              },
              {
                kind: 'message',
                senderId: owner,
                content: '!test',
                context: contextB,
                advanceClockMs: 100,
                assertions: [
                  { path: '/outcome', equals: 'error' },
                  { path: '/errors/0', equals: '!test: Missing bot SendMessages permission' },
                  { path: '/effects/messages', equals: [] },
                  { path: '/effects/operations/0/context', equals: contextB },
                  { path: '/effects/operations/0/failedAt', equals: 160 },
                  { path: '/state/messages/1/channelId', equals: contextA.channelId }
                ]
              }
            ]
          }
        ]
      }
    }
    const report = await runAgentValidation(validation)
    expect(report.outcome).toBe('passed')
    expect(await runAgentValidation(validation)).toEqual(report)
    const first = report.cases[0].steps[0].effects
    const id = first.messages[0].id
    expect(typeof id).toBe('string')
    expect(BigInt(id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    expect(first.operations![0].result).toEqual({ id })
  })

  it('commits delayed interaction role changes to the normalized world after delivery', async () => {
    const state = normalizeWorld()
    state.timing = {
      operations: {
        'interaction.defer': { latencyMs: 5 },
        'message.send': { latencyMs: 20 },
        'message.dm': { latencyMs: 10 },
        'member.roles.toggle': { latencyMs: 30 }
      }
    }
    const senderId = state.members[1].id
    const context = { guildId: state.guildId, channelId: state.channelId }
    const result = await runInteraction({
      kind: 'slash',
      state,
      context,
      senderId,
      interactions: [interaction()],
      commandId: 'candidate'
    })
    expect(result.errors).toEqual([])
    expect(result.incomplete).toEqual([])
    expect(result.state.clockMs).toBe(65)
    expect(
      result.state.world!.memberships.find(
        (member) => member.guildId === context.guildId && member.id === senderId
      )!.roles
    ).toContain('200000000000000002')
    expect(
      result.state.operations!.every((op) => JSON.stringify(op.context) === JSON.stringify(context))
    ).toBe(true)
    expect(result.state.messages.find((message) => message.kind === 'dm')!.guildId).toBeNull()
    const replay = JSON.parse(JSON.stringify(result.state))
    expect(validateAgentValidationState(replay).world).toEqual(replay.world)
  })

  it('detached sends complete by fixture latency, with exactly reproducible traces', async () => {
    const input = request()
    const first = await runMessage(input)
    expect(first.errors).toEqual([])
    expect(first.state.messages.slice(1).map((message) => message.content)).toEqual([
      'dm',
      'channel'
    ])
    expect(first.state.operations!.map((op) => [op.name, op.scheduledAt, op.completedAt])).toEqual([
      ['message.send', 0, 100],
      ['message.dm', 0, 10]
    ])
    expect(first.state.clockMs).toBe(100)
    expect(await runMessage(input)).toEqual(first)
    expect(input.state.clockMs).toBe(0)
  })

  it('awaited purge completes before detached sends can start', async () => {
    const input = request({ deleteNum: 1 })
    input.state.timing!.operations!['message.purge'] = { delayMs: 5, latencyMs: 20 }
    const result = await runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.state.operations!.map((op) => [op.name, op.startedAt, op.completedAt])).toEqual([
      ['message.purge', 5, 25],
      ['message.send', 25, 125],
      ['message.dm', 25, 35]
    ])
  })

  it('retains earlier effects when a detached operation fails later', async () => {
    const input = request()
    input.state.timing!.operations!['message.send'].failure = 'delayed delivery failure'
    const result = await runMessage(input)
    expect(result.errors.join()).toContain('delayed delivery failure')
    expect(result.incomplete).toEqual([])
    expect(result.state.messages.slice(1).map((message) => message.content)).toEqual(['dm'])
    expect(result.state.operations![0]).toMatchObject({ status: 'failed', failedAt: 100 })
  })

  it('awaits defer and response before DM, then continues after a delayed DM failure', async () => {
    const input = request()
    input.state.timing!.operations!['interaction.defer'] = { latencyMs: 5 }
    input.state.timing!.operations!['message.dm'].failure = 'DM closed'
    const result = await runInteraction({
      kind: 'slash',
      state: input.state,
      senderId: input.senderId,
      interactions: [interaction()],
      commandId: 'candidate'
    })
    expect(result.errors).toEqual([])
    expect(result.warnings!.join()).toContain('DM closed')
    expect(
      result.state.operations!.map((op) => [op.name, op.startedAt, op.completedAt ?? op.failedAt])
    ).toEqual([
      ['interaction.defer', 0, 5],
      ['message.send', 5, 105],
      ['message.dm', 105, 115],
      ['member.roles.toggle', 115, 115]
    ])
  })

  it('refreshes typing at 8s intervals and cancels refresh when delivery finishes', async () => {
    const input = request({ channelMessageTyping: true, privateMessage: '' })
    input.state.timing!.operations!['message.send'] = { latencyMs: 17000 }
    const result = await runMessage(input)
    expect(result.errors).toEqual([])
    expect(
      result.state
        .operations!.filter((op) => op.name === 'channel.typing')
        .map((op) => op.startedAt)
    ).toEqual([0, 8000, 16000])
    expect(result.state.clockMs).toBe(17000)
    expect(result.incomplete).toEqual([])
  })

  it('schedules deletion independently of detached delivery', async () => {
    const input = request({ deleteAfter: true })
    input.state.timing!.operations!['message.delete'] = { latencyMs: 20 }
    const result = await runMessage(input)
    expect(result.state.messages[0].deleted).toBe(true)
    expect(result.state.operations!.find((op) => op.name === 'message.delete')!.completedAt).toBe(
      20
    )
    expect(result.state.clockMs).toBe(100)
  })

  it('binds timing into fixtures and replay, and fails closed on exhausted work', async () => {
    const input = request()
    const validation: AgentValidationRequest = {
      candidateKind: 'command',
      candidate: input.commands[0],
      candidateHash: 'candidate',
      fixtureHash: 'fixture',
      baseRevision: null,
      wrapEvalInIIFE: true,
      suite: {
        version: 2,
        cases: [
          {
            name: 'latency',
            state: input.state,
            steps: [
              {
                kind: 'message',
                senderId: input.senderId,
                content: input.content,
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/operations/0/completedAt', equals: 100 }
                ]
              }
            ]
          }
        ]
      }
    }
    expect(validateAgentValidationState(input.state).timing).toEqual(input.state.timing)
    const first = await runAgentValidation(validation)
    expect(first.outcome).toBe('passed')
    expect(await runAgentValidation(validation)).toEqual(first)
    validation.suite.cases[0].state.timing!.limits = { maxSteps: 1 }
    const limited = await runAgentValidation(validation)
    expect(limited.outcome).toBe('not_run')
    expect(limited.cases[0].steps[0].incomplete!.join()).toContain('budget exhausted')
    expect(
      limited.cases[0].steps[0].effects.operations!.some((op) => op.status === 'cancelled')
    ).toBe(true)
  })

  it.each([
    { operations: { typo: { latencyMs: 1 } } },
    { operations: { 'message.send': { latencyMs: -1 } } },
    { operations: { 'message.send': { latencyMs: 1.5 } } },
    { operations: { 'message.send': { completeAt: 5 } } },
    { limits: { maxSteps: 5001 } }
  ])('rejects ambiguous or unbounded timing: %j', (timing) => {
    expect(() => validateAgentValidationState({ ...createPlaygroundState(), timing })).toThrow(
      'timing'
    )
  })

  it('uses UTC for date keywords and sandbox local dates, with deterministic naive ISO parsing', async () => {
    const input = request({
      privateMessage: '',
      channelMessage:
        '$date|$day/$month/$year $hour:$minute:$second|$eval return [new Date(2020, 0, 2, 3).toLocaleString(), new Date("2020-01-02T03:00:00").getHours(), new Date().getTimezoneOffset()].join("|") $halt'
    })
    const result = await runMessage(input, factory)
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)!.content).toBe(
      '1970-01-01T00:00:00.000Z|1/1/1970 00:00:00|2020-01-02T03:00:00.000Z|3|0'
    )
  })
})
