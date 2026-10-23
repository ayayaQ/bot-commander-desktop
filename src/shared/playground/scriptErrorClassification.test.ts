import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { IncompleteSimulationError } from '../runtime/errors'
import { ScriptExecutionError } from '../runtime/scriptError'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'
import { decodeBCFDCommand } from '../commandCodec'
import { runAgentValidation } from './agentValidation'
import { createPlaygroundState } from './types'

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})

// Controlled error instances only: no resource exhaustion or recursive guest execution.
describe('playground error classification', () => {
  it('reports a controlled internal error as incomplete validation evidence', async () => {
    const state = createPlaygroundState()
    const candidate = decodeBCFDCommand({
      id: 'candidate',
      command: '!test',
      commandDescription: 'Controlled classification test',
      type: 0,
      channelMessage: '$eval throw new InternalError("controlled error"); $halt',
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {}
    }).command
    const report = await runAgentValidation(
      {
        candidateKind: 'command',
        candidate,
        candidateHash: 'hash',
        baseRevision: null,
        fixtureHash: 'fixture',
        wrapEvalInIIFE: true,
        suite: {
          cases: [
            {
              name: 'controlled internal error',
              state,
              steps: [
                {
                  kind: 'message',
                  senderId: state.members[0].id,
                  content: '!test',
                  assertions: [
                    { path: '/outcome', equals: 'executed' },
                    { path: '/effects/messages/length', equals: 0 }
                  ]
                }
              ]
            }
          ]
        }
      },
      factory
    )
    expect(report.outcome).toBe('not_run')
    expect(report.cases[0].steps[0].incomplete?.length).toBeGreaterThan(0)
    expect(report.cases[0].steps[0].expectedNegative).toBe(false)
  })

  it.each([
    'throw new InternalError("controlled error")',
    'InternalError.prototype.name = "Error"; throw new InternalError("controlled error")',
    'const error = new InternalError("controlled error"); error.name = "Custom"; throw error',
    'const NativeError = InternalError; globalThis.InternalError = Error; throw new NativeError("controlled error")'
  ])('classifies the captured internal error family independently of display names: %s', (code) => {
    const vm = factory({})
    try {
      expect(() => vm.evaluate(code)).toThrow(IncompleteSimulationError)
      expect(() => vm.evaluate('return 1')).toThrow(IncompleteSimulationError)
    } finally {
      vm.dispose()
    }
  })

  it.each([
    'throw new Error("credit limit reached")',
    'const error = new Error("ordinary error"); error.name = "InternalError"; throw error'
  ])('retains ordinary diagnostics and usable state: %s', (code) => {
    const vm = factory({ count: 1 })
    try {
      expect(() => vm.evaluate(code)).toThrow(ScriptExecutionError)
      expect(vm.evaluate('return botState.count')).toBe('1')
    } finally {
      vm.dispose()
    }
  })
})
