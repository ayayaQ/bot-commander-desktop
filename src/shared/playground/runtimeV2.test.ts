import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { decodeBCFDCommand } from '../commandCodec'
import { playgroundCapabilities } from '../runtime/capabilities'
import { createPlaygroundState } from './types'
import { evaluateTemplate } from './template'
import { runMessage } from './engine'
import { runAgentValidation } from './agentValidation'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})
const command = (channelMessage: string, patch = {}) =>
  decodeBCFDCommand({
    id: 'target',
    command: '!test',
    commandDescription: 'Test',
    type: 0,
    channelMessage,
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command

describe('shared playground runtime', () => {
  it('provides every registered production keyword without an unsupported fallback', async () => {
    for (const keyword of playgroundCapabilities().keywords) {
      const state = createPlaygroundState()
      const script = factory({})
      try {
        const value = await evaluateTemplate(`$${keyword}()`, {
          state,
          sender: state.members[0],
          content: '!test hello',
          trigger: '!test',
          script
        })
        expect(value, keyword).not.toContain('Unsupported playground')
        expect(typeof value, keyword).toBe('string')
      } finally {
        script.dispose()
      }
    }
  })

  it('creates, renames, queries and deletes channels through shared keywords', async () => {
    const state = createPlaygroundState()
    const result = await runMessage(
      {
        state,
        senderId: state.members[0].id,
        content: '!test',
        commands: [
          command(
            '$set(c,$createChannel(new,text))$setChannelName($get(c),renamed)$getChannelName($get(c)):$deleteChannel($get(c))'
          )
        ]
      },
      factory
    )
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('truerenamed:true')
    expect(result.state.channels).toHaveLength(1)
    expect(result.state.operations?.map((item) => item.name)).toEqual([
      'channel.create',
      'channel.rename',
      'channel.delete',
      'message.send'
    ])
    expect(state.channels).toHaveLength(1)
  })

  it('honors role management permissions and mutates the fake member only', async () => {
    const state = createPlaygroundState()
    const source =
      '$roleGrant(100000000000000002,+200000000000000001)$hasRole(100000000000000002,200000000000000001)'
    const result = await runMessage(
      { state, senderId: state.members[0].id, content: '!test', commands: [command(source)] },
      factory
    )
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('truetrue')
    expect(state.members[1].roles).not.toContain('200000000000000001')
    state.botPermissions = ['SendMessages']
    const denied = await runMessage(
      { state, senderId: state.members[0].id, content: '!test', commands: [command(source)] },
      factory
    )
    expect(denied.state.messages.at(-1)?.content).toContain('requires Manage Roles permission')
  })

  it('retains startup functions and global bindings across strict steps', async () => {
    const state = createPlaygroundState()
    state.startupSource = 'function greeting(n) { return "Hello " + n } let calls = 0'
    const candidate = command('$eval calls++; return greeting(calls); $halt')
    const report = await runAgentValidation(
      {
        candidateKind: 'command',
        candidate,
        candidateHash: 'candidate',
        fixtureHash: 'fixture',
        baseRevision: null,
        wrapEvalInIIFE: true,
        suite: {
          version: 2,
          cases: [
            {
              name: 'Startup',
              state,
              steps: [1, 2].map((n) => ({
                kind: 'message',
                senderId: state.members[0].id,
                content: '!test',
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/messages/0/content', equals: `Hello ${n}` }
                ]
              }))
            }
          ]
        }
      },
      factory
    )
    expect(report.outcome).toBe('passed')
    expect(report.coverage.executed).toBe(2)
  })

  it('requires exact external prompts in strict validation and records request evidence', async () => {
    const state = createPlaygroundState()
    state.aiMocks = [{ prompt: 'hello', response: 'mock response' }]
    const candidate = command('$chat($messageAfterCommand)', { startsWith: true })
    const input = {
      candidateKind: 'command' as const,
      candidate,
      candidateHash: 'candidate',
      fixtureHash: 'fixture',
      baseRevision: null,
      wrapEvalInIIFE: true,
      suite: {
        cases: [
          {
            name: 'Chat',
            state,
            steps: [
              {
                kind: 'message' as const,
                senderId: state.members[0].id,
                content: '!test hello',
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/messages/0/content', equals: 'mock response' }
                ]
              }
            ]
          }
        ]
      }
    }
    const report = await runAgentValidation(input, factory)
    expect(report.outcome).toBe('passed')
    expect(report.cases[0].steps[0].effects.operations?.[0]).toMatchObject({
      name: 'ai.chat',
      args: ['hello'],
      result: 'mock response'
    })
    state.aiMocks = []
    expect((await runAgentValidation(input, factory)).outcome).toBe('not_run')
  })

  it.each(['message', 'dm', 'memberJoin', 'memberLeave', 'memberBan', 'reaction'] as const)(
    'dispatches %s and excludes other command types',
    async (kind) => {
      const state = createPlaygroundState()
      state.messages.push({ id: 1, kind: 'user', author: 'Alex', content: 'original' })
      state.nextId = 2
      const type = ['message', 'dm', 'memberJoin', 'memberLeave', 'memberBan', 'reaction'].indexOf(
        kind
      )
      const result = await runMessage(
        {
          state,
          senderId: state.members[0].id,
          kind,
          content: '!test',
          messageId: 1,
          commands: [
            command('correct', { type }),
            command('wrong', { id: 'other', type: (type + 1) % 6 })
          ]
        },
        factory
      )
      expect(result.errors).toEqual([])
      expect(
        result.resources?.filter((item) => item.executed).map((item) => item.resourceId)
      ).toEqual(['target'])
      expect(result.state.messages.at(-1)?.content).toBe('correct')
    }
  )
  it('uses the fixture clock and seed during startup and isolates global bindings by case', async () => {
    const state = createPlaygroundState()
    state.clockMs = 123456
    state.randomSeed = 42
    state.startupSource = 'const started = Date.now(); const roll = Math.random(); let calls = 0'
    const candidate = command('$eval return started + ":" + roll + ":" + (++calls); $halt')
    const makeCase = (name: string) => ({
      name,
      state,
      steps: [
        {
          kind: 'message' as const,
          senderId: state.members[0].id,
          content: '!test',
          assertions: [
            { path: '/outcome', equals: 'executed' as const },
            { path: '/effects/messages/0/content', equals: '123456:0.2523451747838408:1' }
          ]
        }
      ]
    })
    const report = await runAgentValidation(
      {
        candidateKind: 'command',
        candidate,
        candidateHash: 'candidate',
        fixtureHash: 'fixture',
        baseRevision: null,
        wrapEvalInIIFE: true,
        suite: { version: 2, cases: [makeCase('first'), makeCase('second')] }
      },
      factory
    )
    expect(report.outcome).toBe('passed')
    expect(report.coverage.executed).toBe(2)
  })

  it('records a failed send while retaining an earlier successful send and channel mutation', async () => {
    const state = createPlaygroundState()
    state.failures = { 'message.dm': 'DMs disabled' }
    const result = await runMessage(
      {
        state,
        senderId: state.members[0].id,
        content: '!test',
        commands: [command('first', { privateMessage: '$createChannel(second)' })]
      },
      factory
    )
    expect(result.errors).toEqual(['!test: DMs disabled'])
    expect(
      result.state.messages.filter((item) => item.kind === 'bot').map((item) => item.content)
    ).toEqual(['first'])
    expect(result.state.channels?.at(-1)?.name).toBe('second')
    expect(result.state.operations?.map((item) => [item.name, item.error])).toEqual([
      ['message.send', undefined],
      ['channel.create', undefined],
      ['message.dm', 'DMs disabled']
    ])
    expect(state.channels).toHaveLength(1)
  })

  it('runs channel management, permission resets, role management and presence against the synthetic world', async () => {
    const state = createPlaygroundState()
    const candidate = command(
      '$set(c,$cloneChannel(900000000000000002))$setChannelTopic($get(c),topic)$setChannelNSFW($get(c),true)$setChannelSlowmode($get(c),5)$lockChannel($get(c),200000000000000001)$unlockChannel($get(c),200000000000000001)$set(r,$createRole(New,FF0000))$deleteRole($get(r))'
    )
    const result = await runMessage(
      { state, senderId: state.members[0].id, content: '!test', commands: [candidate] },
      factory
    )
    expect(result.errors).toEqual([])
    expect(result.state.channels?.[1]).toMatchObject({
      topic: 'topic',
      nsfw: true,
      slowmode: 5,
      overwrites: { '200000000000000001': {} }
    })
    expect(result.state.roles).toHaveLength(2)
  })

  it('keeps member-event action order distinct from message moderation and cooldowns', async () => {
    const state = createPlaygroundState()
    const result = await runMessage(
      {
        state,
        senderId: state.members[0].id,
        kind: 'memberJoin',
        content: '',
        commands: [
          command('$namePlain joined', {
            type: 2,
            deleteNum: 99,
            isAdmin: true,
            cooldown: 10,
            cooldownType: 'User',
            roleToAssign: '200000000000000002'
          })
        ]
      },
      factory
    )
    expect(result.errors).toEqual([])
    expect(result.state.messages.map((item) => item.content)).toEqual(['Alex joined'])
    expect(result.state.cooldowns).toEqual({})
    expect(result.state.operations?.map((item) => item.name)).toEqual([
      'member.roles.toggle',
      'message.send'
    ])
  })
  it('does not recreate a deleted active channel in later templates', async () => {
    const state = createPlaygroundState()
    const result = await runMessage(
      {
        state,
        senderId: state.members[0].id,
        content: '!test',
        commands: [
          command('$deleteChannel(900000000000000002)', {
            privateMessage: '$channelExists(900000000000000002)'
          })
        ]
      },
      factory
    )
    expect(result.errors).toEqual(['!test: Channel was deleted'])
    expect(result.state.messages.at(-1)?.content).toBe('false')
    expect(result.state.channels?.[0].deleted).toBe(true)
  })

  it('normalizes presence with the same defaults and reset behavior as production', async () => {
    const state = createPlaygroundState()
    const result = await runMessage(
      {
        state,
        senderId: state.members[0].id,
        content: '!test',
        commands: [command('$setStatus( INVALID , reset ,ignored)')]
      },
      factory
    )
    expect(result.state.presence).toEqual({ status: 'online', activity: 'reset', text: '' })
    expect(result.errors).toEqual([])
  })
})
