import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'
import { decodeBCFDCommand } from '../commandCodec'
import type { BCFDInteractionAction, BCFDInteractionCommand } from '../../main/types/types'
import { createPlaygroundState } from './types'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { runAgentValidation, validateAgentValidationSuite } from './agentValidation'
import { copyAgentValidationJSON } from './agentValidationFixtures'
import { createQuickJSScriptContext } from '../../main/utils/quickJsScriptContext'
import {
  AGENT_VALIDATION_LIMITS,
  createNotRunAgentValidationReport,
  type AgentValidationRequest,
  type AgentValidationSuite,
  type AgentValidationStep
} from '../agentValidationTypes'

const senderId = '100000000000000001'
const command = (patch = {}) =>
  decodeBCFDCommand({
    id: 'candidate',
    command: '!test',
    commandDescription: 'Candidate',
    type: 0,
    channelMessage: 'local',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command
const step = (patch: Partial<AgentValidationStep> = {}): AgentValidationStep => ({
  kind: 'message',
  senderId,
  content: '!test',
  assertions: [
    { path: '/outcome', equals: 'executed' },
    { path: '/effects/messages/0/content', equals: 'local' }
  ],
  ...patch
})
const suite = (steps = [step()]): AgentValidationSuite => ({
  cases: [{ name: 'explicit case', state: createPlaygroundState(), steps }]
})
const request = (patch: Partial<AgentValidationRequest> = {}): AgentValidationRequest => ({
  candidateKind: 'command',
  candidate: command(),
  candidateHash: 'candidate-hash',
  baseRevision: 'base-revision',
  fixtureHash: 'fixture-hash',
  wrapEvalInIIFE: true,
  suite: suite(),
  ...patch
})
const action = (patch: Partial<BCFDInteractionAction> = {}): BCFDInteractionAction => ({
  sendChannelMessage: true,
  channelMessage: 'local',
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
  ephemeral: false,
  deferReply: false,
  buttons: [],
  ...patch
})
const interaction = (patch: Partial<BCFDInteractionCommand> = {}): BCFDInteractionCommand => ({
  id: 'candidate',
  commandName: 'test',
  commandDescription: 'Candidate',
  options: [],
  rootAction: action(),
  isRegistered: false,
  ...patch
})
const slash = (patch: Partial<AgentValidationStep> = {}): AgentValidationStep =>
  step({
    kind: 'slash',
    content: undefined,
    ...patch
  })
// Optional undefined values are never fixture JSON. Remove them in test builders.
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value))
let sandboxFactory: ScriptSandboxFactory
beforeAll(async () => {
  sandboxFactory = createScriptSandboxFactory(await getQuickJS())
})

describe('bounded candidate validation runner', () => {
  it.each([true, false])(
    'ordinary mode matches production eval declaration scope with wrapping %s',
    async (wrapEvalInIIFE) => {
      const snippets = [
        'var localGreeting = "hello"; botState.first = localGreeting;',
        'botState.scope = typeof localGreeting; "ignored completion";'
      ]
      const production = await createQuickJSScriptContext({ initialContext: { botState: {} } })
      try {
        const outputs = snippets.map((code) => {
          const value = production.evaluate(code, { wrapReturn: wrapEvalInIIFE })
          return wrapEvalInIIFE && value !== undefined ? String(value) : ''
        })
        const expectedState = production.getVariable('botState')
        const report = runAgentValidation(
          request({
            wrapEvalInIIFE,
            candidate: command({
              channelMessage: 'result:' + snippets.map((code) => `$eval ${code} $halt`).join('')
            }),
            suite: suite([
              step({
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/messages/0/content', equals: 'result:' + outputs.join('') },
                  { path: '/state/botState/first', equals: 'hello' },
                  {
                    path: '/state/botState/scope',
                    equals: wrapEvalInIIFE ? 'undefined' : 'string'
                  }
                ]
              })
            ])
          }),
          sandboxFactory
        )
        expect(report.outcome).toBe('passed')
        expect(report.wrapEvalInIIFE).toBe(wrapEvalInIIFE)
        expect(expectedState).toEqual({
          first: 'hello',
          scope: wrapEvalInIIFE ? 'undefined' : 'string'
        })
      } finally {
        production.dispose()
      }
    }
  )

  it('ordinary mode returns normal wrapped values and rejects a top-level global return', async () => {
    const candidate = command({ channelMessage: '$eval return "reply"; $halt' })
    const input = request({
      candidate,
      suite: suite([
        step({
          assertions: [
            { path: '/outcome', equals: 'executed' },
            { path: '/effects/messages/0/content', equals: 'reply' }
          ]
        })
      ])
    })
    const production = await createQuickJSScriptContext()
    try {
      expect(production.evaluate('return "reply";', { wrapReturn: true })).toBe('reply')
      expect(() => production.evaluate('return "reply";', { wrapReturn: false })).toThrow()
    } finally {
      production.dispose()
    }
    expect(runAgentValidation(input, sandboxFactory).outcome).toBe('passed')
    const global = runAgentValidation({ ...input, wrapEvalInIIFE: false }, sandboxFactory)
    expect(global.outcome).toBe('failed')
    expect(global.cases[0].steps[0].executionOutcome).toBe('error')
    expect(global.cases[0].steps[0].effects.messages).toEqual([])
  })

  it.each([true, false])(
    'ordinary mode carries eval declaration scope through slash and button steps with wrapping %s',
    (wrapEvalInIIFE) => {
      const template = (name: string) =>
        `${name}:$eval var localGreeting = "hello"; $halt` +
        `$eval botState.${name}Scope = typeof localGreeting; $halt`
      const candidate = interaction({
        rootAction: action({
          channelMessage: template('slash'),
          buttons: [
            {
              customId: 'go',
              label: 'Go',
              style: 1,
              disabled: false,
              action: action({ channelMessage: template('button') })
            }
          ]
        })
      })
      const report = runAgentValidation(
        request({
          candidateKind: 'interaction',
          candidate,
          wrapEvalInIIFE,
          suite: suite(
            [
              slash({
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/messages/0/content', equals: 'slash:' },
                  {
                    path: '/state/botState/slashScope',
                    equals: wrapEvalInIIFE ? 'undefined' : 'string'
                  }
                ]
              }),
              step({
                kind: 'button',
                content: undefined,
                messageId: 1,
                customId: 'go',
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/messages/0/content', equals: 'button:' },
                  {
                    path: '/state/botState/buttonScope',
                    equals: wrapEvalInIIFE ? 'undefined' : 'string'
                  }
                ]
              })
            ].map(clean)
          )
        }),
        sandboxFactory
      )
      expect(report.outcome).toBe('passed')
      expect(report.coverage.executed).toBe(2)
      expect(report.wrapEvalInIIFE).toBe(wrapEvalInIIFE)
    }
  )

  it('ordinary mode preserves wrapped eval defaults for existing Playground callers', () => {
    const state = createPlaygroundState()
    const message = runMessage(
      {
        state,
        commands: [command({ channelMessage: '$eval return "reply"; $halt' })],
        senderId,
        content: '!test'
      },
      sandboxFactory
    )
    expect(message.state.messages.at(-1)?.content).toBe('reply')
    const slash = runInteraction(
      {
        kind: 'slash',
        state,
        interactions: [
          interaction({ rootAction: action({ channelMessage: '$eval return "reply"; $halt' }) })
        ],
        senderId,
        commandId: 'candidate'
      },
      sandboxFactory
    )
    expect(slash.state.messages.at(-1)?.content).toBe('reply')
  })

  it.each(['$definitelyNotARealBCFDFunction(no)', 'Bad $definitelyNotARealVariable'])(
    'fails unknown BCFD names rather than classifying them as genuine unsupported: %s',
    (channelMessage) => {
      const report = runAgentValidation(request({ candidate: command({ channelMessage }) }))
      expect(report.outcome).toBe('failed')
      expect(report.coverage.unsupported).toBe(0)
      expect(report.cases[0].steps[0]).toMatchObject({
        executionOutcome: 'error',
        matched: true,
        executed: false
      })
      expect(report.cases[0].steps[0].errors.join(' ')).toContain('Unknown BCFD expression')
    }
  )

  it('retains documented and legacy known unsupported features as unsupported', () => {
    for (const channelMessage of ['$createChannel(no)', '$defaultavatar', '$hours']) {
      const report = runAgentValidation(request({ candidate: command({ channelMessage }) }))
      expect(report.outcome).toBe('unsupported')
      expect(report.cases[0].steps[0].matched).toBe(true)
    }
  })

  it('only allows a DM recipient to activate that fake message button', () => {
    const button = {
      customId: 'private-go',
      label: 'Go',
      style: 1 as const,
      disabled: false,
      action: action({ channelMessage: 'clicked' })
    }
    const candidate = interaction({ rootAction: action({ buttons: [button] }) })
    const state = createPlaygroundState()
    state.messages = [
      {
        id: 1,
        kind: 'dm',
        author: 'Playground Bot',
        content: 'Private',
        recipient: state.members[1].id,
        buttons: [button]
      }
    ]
    state.nextId = 2
    const input = request({
      candidateKind: 'interaction',
      candidate,
      suite: {
        cases: [
          {
            name: 'DM boundary',
            state,
            steps: [
              clean(
                step({
                  kind: 'button',
                  content: undefined,
                  senderId: state.members[0].id,
                  messageId: 1,
                  customId: 'private-go',
                  assertions: [
                    { path: '/outcome', equals: 'blocked' },
                    {
                      path: '/errors/0',
                      equals: 'Button message is unavailable to this fake sender'
                    },
                    { path: '/effects/messages/length', equals: 0 }
                  ]
                })
              ),
              clean(
                step({
                  kind: 'button',
                  content: undefined,
                  senderId: state.members[1].id,
                  messageId: 1,
                  customId: 'private-go',
                  assertions: [
                    { path: '/outcome', equals: 'executed' },
                    { path: '/effects/messages/0/content', equals: 'clicked' }
                  ]
                })
              )
            ]
          }
        ]
      }
    })
    const original = structuredClone(input)
    const report = runAgentValidation(input)
    expect(report.outcome).toBe('passed')
    expect(report.coverage).toMatchObject({ blocked: 1, executed: 1 })
    expect(report.cases[0].steps[0].effects.messages).toEqual([])
    expect(input).toEqual(original)
  })

  it('runs an unsaved command, binds identity and compares actual values', () => {
    const input = request()
    const report = runAgentValidation(input)
    expect(report.outcome).toBe('passed')
    expect(report).toMatchObject({
      candidateId: 'candidate',
      candidateHash: 'candidate-hash',
      baseRevision: 'base-revision',
      fixtureHash: 'fixture-hash',
      coverage: { matched: 1, executed: 1 }
    })
    expect(report.cases[0].steps[0].assertions[1]).toEqual({
      path: '/effects/messages/0/content',
      expected: 'local',
      actual: 'local',
      actualPresent: true,
      passed: true
    })
    expect(input.suite.cases[0].state.messages).toEqual([])
    expect(report.limitations.join(' ')).toContain('Startup JavaScript is not loaded')
  })

  it('reports a wrong effect and absent paths as failed', () => {
    const report = runAgentValidation(
      request({
        suite: suite([
          step({
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/1/content', equals: 'wrong' }
            ]
          })
        ])
      })
    )
    expect(report.outcome).toBe('failed')
    expect(report.cases[0].steps[0].assertions[1]).toMatchObject({
      actual: null,
      actualPresent: false,
      passed: false
    })
  })

  it('does not infer success from error-free unmatched, unsupported or blocked execution', () => {
    const unmatched = runAgentValidation(request({ suite: suite([step({ content: 'other' })]) }))
    expect(unmatched.outcome).toBe('unmatched')
    expect(unmatched.coverage).toMatchObject({ matched: 0, executed: 0, unmatched: 1 })
    const unsupported = runAgentValidation(request({ candidate: command({ type: 1 }) }))
    expect(unsupported.outcome).toBe('unsupported')
    expect(unsupported.coverage.executed).toBe(0)
    const blocked = runAgentValidation(
      request({
        candidate: command({ isAdmin: true }),
        suite: suite([step({ senderId: '100000000000000002' })])
      })
    )
    expect(blocked.outcome).toBe('blocked')
    expect(blocked.cases[0].steps[0].executed).toBe(false)
  })

  it('reports expected denials explicitly while all-denied suites stay blocked', () => {
    const denial = step({
      senderId: '100000000000000002',
      assertions: [
        { path: '/outcome', equals: 'blocked' },
        { path: '/reason', equals: 'Administrator required' },
        { path: '/effects/messages/length', equals: 0 }
      ]
    })
    const report = runAgentValidation(
      request({ candidate: command({ isAdmin: true }), suite: suite([denial]) })
    )
    expect(report.outcome).toBe('blocked')
    expect(report.cases[0].steps[0]).toMatchObject({
      outcome: 'passed',
      executionOutcome: 'blocked',
      expectedNegative: true,
      matched: true,
      executed: false
    })
    const mixed = runAgentValidation(
      request({ candidate: command({ isAdmin: true }), suite: suite([step(), denial]) })
    )
    expect(mixed.outcome).toBe('passed')
    expect(mixed.coverage).toMatchObject({ executed: 1, blocked: 1 })
  })

  it.each([
    [{ requiredRole: 'missing' }, 'Missing required fake role'],
    [{ channelWhitelist: '42' }, 'Fake channel is not whitelisted'],
    [{ serverWhitelist: '42' }, 'Fake server is not whitelisted'],
    [{ isNSFW: true }, 'Fake channel is not NSFW']
  ])('records the specific fake role/channel/server/NSFW gate %#', (patch, reason) => {
    const report = runAgentValidation(
      request({
        candidate: command(patch),
        suite: suite([
          step({
            assertions: [
              { path: '/outcome', equals: 'blocked' },
              { path: '/reason', equals: reason },
              { path: '/effects/messages/length', equals: 0 }
            ]
          })
        ])
      })
    )
    expect(report.outcome).toBe('blocked')
    expect(report.cases[0].steps[0]).toMatchObject({ outcome: 'passed', expectedNegative: true })
  })

  it('cannot pass accidental denials or errors that occur before candidate dispatch', () => {
    const wrongReason = runAgentValidation(
      request({
        candidate: command({ isAdmin: true }),
        suite: suite([
          step(),
          step({
            senderId: '100000000000000002',
            assertions: [
              { path: '/outcome', equals: 'blocked' },
              { path: '/reason', equals: 'Missing required fake role' },
              { path: '/effects/messages/length', equals: 0 }
            ]
          })
        ])
      })
    )
    expect(wrongReason.outcome).toBe('failed')
    const input = request({
      suite: suite([
        step(),
        step({
          senderId: '100000000000000002',
          assertions: [
            { path: '/outcome', equals: 'error' },
            { path: '/errors/0', equals: 'Choose an available fake sender' },
            { path: '/effects/messages/length', equals: 0 }
          ]
        })
      ])
    })
    input.suite.cases[0].state.members[1].banned = true
    const predispatch = runAgentValidation(input)
    expect(predispatch.outcome).toBe('failed')
    expect(predispatch.cases[0].steps[1]).toMatchObject({
      outcome: 'failed',
      expectedNegative: false,
      matched: false
    })
  })

  it('shares explicit script state and VM variables between steps, with mocked AI and fresh cases', () => {
    const scriptedStep = (count: number) =>
      step({
        assertions: [
          { path: '/outcome', equals: 'executed' },
          { path: '/effects/messages/0/content', equals: `${count}:mocked` },
          { path: '/state/botState/count', equals: count },
          { path: '/state/variables/local', equals: 'fixture' }
        ]
      })
    const input = request({
      candidate: command({
        channelMessage:
          '$set(local,fixture)$eval botState.count=(botState.count||0)+1; return botState.count; $halt:$chat(test)'
      }),
      suite: suite([scriptedStep(1), scriptedStep(2)])
    })
    input.suite.cases[0].state.ai.response = 'mocked'
    input.suite.cases.push({
      name: 'fresh script',
      state: clean(input.suite.cases[0].state),
      steps: [scriptedStep(1)]
    })
    const deadlines: number[] = []
    const report = runAgentValidation(input, (state, options) => {
      deadlines.push(options!.deadline!)
      expect(options!.deadline).toBeLessThanOrEqual(Date.now() + 1000)
      return sandboxFactory(state, options)
    })
    expect(report.outcome).toBe('passed')
    expect(report.coverage.executed).toBe(3)
    expect(deadlines).toHaveLength(3)
    expect(input.suite.cases[0].state.botState).toEqual({})
    expect(report.cases[0].steps[1].effects.botStateChanges[0]).toMatchObject({
      path: '/botState/count',
      before: 1,
      after: 2
    })
  })

  it('asserts fake moderation and role effects on explicit members only', () => {
    const report = runAgentValidation(
      request({
        candidate: command({ isKick: true, roleToAssign: '200000000000000002' }),
        suite: suite([
          step({
            content: '!test <@100000000000000002>',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/memberChanges/length', equals: 1 },
              { path: '/state/members/1/kicked', equals: true },
              { path: '/state/members/0/roles/1', equals: '200000000000000002' }
            ]
          })
        ])
      })
    )
    expect(report.outcome).toBe('passed')
    expect(report.cases[0].steps[0].effects.memberChanges[0].afterPresent).toBe(true)
  })

  it('shares cooldown state and fake clock within sequences and resets between cases', () => {
    const input = request({
      candidate: command({ cooldown: 2, cooldownType: 'User' }),
      suite: suite([
        step(),
        step({
          assertions: [
            { path: '/outcome', equals: 'blocked' },
            { path: '/reason', equals: 'Cooldown; 2s remaining' },
            {
              path: '/effects/messages/0/content',
              equals: 'This command is on cooldown. Try again in 2s.'
            }
          ]
        }),
        step({ advanceClockMs: 2000 })
      ])
    })
    input.suite.cases.push({ ...clean(input.suite.cases[0]), name: 'fresh', steps: [step()] })
    const report = runAgentValidation(input)
    expect(report.outcome).toBe('passed')
    expect(report.coverage).toMatchObject({ executed: 3, blocked: 1 })
    expect(report.cases[0].steps[0].effects.cooldownChanges[0].after).toBe(0)
    expect(input.suite.cases[0].state.clockMs).toBe(0)
  })

  it('supports expected missing-option errors without treating them as executed', () => {
    const candidate = interaction({
      options: [{ name: 'text', description: 'text', type: 3, required: true }]
    })
    const input = request({
      candidateKind: 'interaction',
      candidate,
      suite: suite([
        clean(
          slash({
            assertions: [
              { path: '/outcome', equals: 'error' },
              { path: '/errors/0', equals: 'Required option missing: text' },
              { path: '/effects/messages/length', equals: 0 }
            ]
          })
        )
      ])
    })
    const negative = runAgentValidation(input)
    expect(negative.outcome).toBe('blocked')
    expect(negative.cases[0].steps[0]).toMatchObject({
      expectedNegative: true,
      matched: true,
      executed: false,
      outcome: 'passed'
    })
    input.suite.cases[0].steps.push(clean(slash({ options: { text: 'value' } })))
    expect(runAgentValidation(input).outcome).toBe('passed')
  })

  it('runs slash-to-button sequences and respects ephemeral visibility', () => {
    const candidate = interaction({
      rootAction: action({
        ephemeral: true,
        buttons: [
          {
            customId: 'go',
            label: 'Go',
            style: 1,
            disabled: false,
            action: action({ channelMessage: 'clicked' })
          }
        ]
      })
    })
    const report = runAgentValidation(
      request({
        candidateKind: 'interaction',
        candidate,
        suite: suite(
          [
            clean(slash()),
            step({
              kind: 'button',
              content: undefined,
              messageId: 1,
              customId: 'go',
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/effects/messages/0/content', equals: 'clicked' }
              ]
            }),
            step({
              kind: 'button',
              content: undefined,
              senderId: '100000000000000002',
              messageId: 1,
              customId: 'go',
              assertions: [
                { path: '/outcome', equals: 'blocked' },
                { path: '/errors/0', equals: 'Button message is unavailable to this fake sender' },
                { path: '/effects/messages/length', equals: 0 }
              ]
            })
          ].map(clean)
        )
      })
    )
    expect(report.outcome).toBe('passed')
    expect(report.coverage).toMatchObject({ executed: 2, blocked: 1 })
  })

  it('uses structured unsupported errors without parsing traces and discards atomic effects', () => {
    const report = runAgentValidation(
      request({ candidate: command({ privateMessage: '$createChannel(no)' }) })
    )
    expect(report.outcome).toBe('unsupported')
    expect(report.cases[0].steps[0].effects.messages).toEqual([])
    expect(report.coverage.executed).toBe(0)
  })

  it('bounds oversized detail with a truthful truncated not-run report', () => {
    const big = 'x'.repeat(16_000)
    const input = request({
      candidate: command({ channelMessage: big }),
      suite: suite(
        Array.from({ length: 12 }, () =>
          step({
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/length', equals: 1 }
            ]
          })
        )
      )
    })
    const report = runAgentValidation(input)
    expect(report).toMatchObject({
      outcome: 'not_run',
      truncated: true,
      coverage: { executed: 12 }
    })
    expect(JSON.stringify(report).length).toBeLessThan(20_000)
    expect(report.cases[0].steps.every((step) => step.assertions.length === 0)).toBe(true)
  })

  it('creates explicit not-run timeout/cancel reports even with no supplied tests', () => {
    const report = createNotRunAgentValidationReport(
      request({ suite: { cases: [] } }),
      'No tests provided',
      { cancelled: true }
    )
    expect(report).toMatchObject({ outcome: 'not_run', cancelled: true, coverage: { executed: 0 } })
    expect(report.limitations).toContain('No tests provided')
    expect(
      createNotRunAgentValidationReport(request(), 'Deadline', { timedOut: true }).cases[0].steps[0]
        .timedOut
    ).toBe(true)
  })

  it('bounds escaped not-run reasons for the maximum cases/steps while preserving identity and limitations', () => {
    const input = request()
    input.candidate.id = '\u0000'.repeat(100)
    input.candidateHash = '\u0000'.repeat(256)
    input.fixtureHash = '\u0000'.repeat(256)
    input.baseRevision = '\u0000'.repeat(256)
    input.suite.cases = Array.from({ length: 6 }, (_, index) => ({
      name: '\u0000'.repeat(99) + index,
      state: createPlaygroundState(),
      steps: [step(), step()]
    }))
    const reason = '\u0000'.repeat(500)
    const report = createNotRunAgentValidationReport(input, reason, { timedOut: true })
    expect(JSON.stringify(report).length).toBeLessThan(20_000)
    expect(report).toMatchObject({
      candidateId: input.candidate.id,
      candidateHash: input.candidateHash,
      fixtureHash: input.fixtureHash,
      baseRevision: input.baseRevision,
      outcome: 'not_run',
      timedOut: true,
      truncated: true,
      coverage: { executed: 0, notRun: 12 }
    })
    expect(report.limitations.at(-1)).toBe(reason)
    expect(report.cases).toHaveLength(6)
    expect(
      report.cases
        .flatMap((item) => item.steps)
        .every(
          (item) => item.outcome === 'not_run' && item.truncated && item.assertions.length === 0
        )
    ).toBe(true)
  })

  it('returns engine resource coverage for both existing message/interaction APIs', () => {
    const state = createPlaygroundState()
    expect(
      runMessage({ state, commands: [command()], senderId, content: '!test' }).resources![0]
    ).toMatchObject({ resourceId: 'candidate', matched: true, executed: true, outcome: 'executed' })
    expect(
      runInteraction({
        kind: 'slash',
        state,
        interactions: [interaction()],
        senderId,
        commandId: 'candidate'
      }).resources![0]
    ).toMatchObject({ resourceId: 'candidate', matched: true, executed: true, outcome: 'executed' })
  })
})

describe('deep explicit fixture boundary', () => {
  it('requires explicit state and bounded outcome/effect assertions', () => {
    expect(() => validateAgentValidationSuite({ cases: [] })).toThrow('at least one')
    expect(() =>
      validateAgentValidationSuite({ cases: [{ name: 'case', steps: [step()] }] })
    ).toThrow('plain JSON')
    expect(() => validateAgentValidationSuite(suite([step({ assertions: [] })]))).toThrow(
      'requires'
    )
    expect(() =>
      validateAgentValidationSuite(
        suite([
          step({
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/errors/length', equals: 0 }
            ]
          })
        ])
      )
    ).toThrow('meaningful')
    expect(() =>
      validateAgentValidationSuite(
        suite([
          step({
            assertions: [
              { path: 'effects.messages.0.content', equals: 'local' },
              { path: '/outcome', equals: 'executed' }
            ]
          })
        ])
      )
    ).toThrow('Pointer')
    expect(() =>
      validateAgentValidationSuite(
        suite([
          step({
            assertions: [
              { path: '/outcome', equals: 'blocked' },
              { path: '/effects/messages/length', equals: 0 }
            ]
          })
        ])
      )
    ).toThrow('specific')
  })

  it.each(['members', 'roles', 'messages'])('rejects malformed %s fixtures', (key) => {
    const value = suite()
    value.cases[0].state[key] = [{}] as never
    expect(() => validateAgentValidationSuite(value)).toThrow()
  })

  it('rejects spoofed/duplicate IDs, roles, recipients, senders and next message IDs', () => {
    for (const mutate of [
      (value: AgentValidationSuite) =>
        value.cases[0].state.members.push(value.cases[0].state.members[0]),
      (value: AgentValidationSuite) => value.cases[0].state.members[0].roles.push('missing'),
      (value: AgentValidationSuite) =>
        (value.cases[0].state.members[0].id = value.cases[0].state.channelId),
      (value: AgentValidationSuite) => (value.cases[0].steps[0].senderId = '42'),
      (value: AgentValidationSuite) =>
        value.cases[0].state.messages.push({
          id: 1,
          kind: 'dm',
          author: 'Playground Bot',
          content: ''
        }),
      (value: AgentValidationSuite) =>
        value.cases[0].state.messages.push({ id: 1, kind: 'user', author: 'unknown', content: '' }),
      (value: AgentValidationSuite) => (value.cases[0].state.nextId = 0)
    ]) {
      const value = suite()
      mutate(value)
      expect(() => validateAgentValidationSuite(value)).toThrow()
    }
  })

  it('rejects accessors, nonplain data, cycles, sparse arrays and oversized JSON without getters', () => {
    let calls = 0
    const value = suite()
    Object.defineProperty(value.cases[0].state.members[0], 'name', {
      enumerable: true,
      get() {
        calls++
        return 'Alex'
      }
    })
    expect(() => validateAgentValidationSuite(value)).toThrow('accessors')
    expect(calls).toBe(0)
    expect(() => copyAgentValidationJSON(new Date(), 1000)).toThrow('plain')
    const cyclic: { self: unknown } = { self: null }
    cyclic.self = cyclic
    expect(() => copyAgentValidationJSON(cyclic, 1000)).toThrow('cycles')
    expect(() => copyAgentValidationJSON(new Array(2), 1000)).toThrow('dense')
    expect(() => copyAgentValidationJSON({ text: 'x'.repeat(1001) }, 1000)).toThrow('size')
    expect(() => copyAgentValidationJSON({ value: NaN }, 1000)).toThrow('plain')
  })

  it('enforces total cases/steps, assertions and clock bounds', () => {
    const value = suite()
    value.cases = Array.from({ length: 7 }, (_, index) => ({
      ...value.cases[0],
      name: `case${index}`
    }))
    expect(() => validateAgentValidationSuite(value)).toThrow('bounded')
    expect(() =>
      validateAgentValidationSuite(suite(Array.from({ length: 13 }, () => step())))
    ).toThrow('bounded')
    expect(() => validateAgentValidationSuite(suite([step({ advanceClockMs: -1 })]))).toThrow(
      'integer'
    )
    expect(() =>
      validateAgentValidationSuite(
        suite([
          step({
            assertions: Array.from(
              { length: AGENT_VALIDATION_LIMITS.assertionsPerStep + 1 },
              () => ({ path: '/outcome', equals: 'executed' })
            )
          })
        ])
      )
    ).toThrow('bounded')
  })

  it('rejects hidden or accessor candidate definitions before normalization', () => {
    const input = request()
    let calls = 0
    Object.defineProperty(input.candidate, 'channelMessage', {
      enumerable: true,
      get() {
        calls++
        return 'local'
      }
    })
    expect(() => runAgentValidation(input)).toThrow('accessors')
    expect(calls).toBe(0)
    expect(() =>
      runAgentValidation(request({ candidate: command({ reaction: 'x'.repeat(16_385) }) }))
    ).toThrow('bounded')
  })

  it('rejects spoofed bot identity and malformed option/choice definitions', () => {
    const fixture = suite()
    fixture.cases[0].state.members[0].id = '900000000000000003'
    expect(() => validateAgentValidationSuite(fixture)).toThrow('spoofs')
    for (const options of [
      [
        {
          name: 'text',
          description: 'text',
          type: 3,
          required: true,
          choices: [{ name: 'number in string choice', value: 1 }]
        }
      ],
      [
        {
          name: 'number',
          description: 'number',
          type: 4,
          required: true,
          choices: [{ name: 'fraction in integer choice', value: 1.5 }]
        }
      ],
      [
        {
          name: 'flag',
          description: 'flag',
          type: 5,
          required: true,
          choices: [{ name: 'choice on boolean', value: 1 }]
        }
      ],
      [
        { name: 'text', description: 'text', type: 3, required: true },
        { name: 'TEXT', description: 'duplicate', type: 3, required: false }
      ]
    ]) {
      expect(() =>
        runAgentValidation(
          request({
            candidateKind: 'interaction',
            candidate: interaction({ options: options as BCFDInteractionCommand['options'] }),
            suite: suite([clean(slash())])
          })
        )
      ).toThrow()
    }
  })
})
