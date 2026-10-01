import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { createPlaygroundState } from '../../shared/playground/types'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import type {
  AgentValidationRequest,
  AgentValidationSuite
} from '../../shared/agentValidationTypes'
import { runAgentValidation } from '../../shared/playground/agentValidation'
import { resourceRevision } from './resourceChangeService'
import type { PreparedMutation } from './agentTools'
import {
  assertAgentValidationBinding,
  validateAgentMutation,
  validationHash
} from './agentMutationValidation'

const { validate } = vi.hoisted(() => ({ validate: vi.fn() }))
vi.mock('./agentValidationService', () => ({ validatePreparedResource: validate }))

function suite(): AgentValidationSuite {
  const state = createPlaygroundState()
  return {
    cases: [
      {
        name: 'reply',
        state,
        steps: [
          {
            kind: 'message',
            senderId: state.members[0].id,
            content: '!ping',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: 'Pong!' }
            ]
          }
        ]
      }
    ]
  }
}
function draft(validation: unknown = suite()): PreparedMutation {
  const after = decodeBCFDCommand({
    id: 'creation-id',
    command: '!ping',
    commandDescription: 'Reply',
    channelMessage: 'Pong!',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    type: 0
  }).command
  return {
    name: 'create_command',
    arguments: { command: after, validation },
    before: null,
    after,
    target: { type: 'command', id: after.id }
  }
}
function passed(request: AgentValidationRequest) {
  const report = createNotRunAgentValidationReport(request, 'test report')
  report.outcome = 'passed'
  report.coverage = {
    matched: 1,
    executed: 1,
    blocked: 0,
    errors: 0,
    unmatched: 0,
    unsupported: 0,
    notRun: 0
  }
  report.cases[0].outcome = 'passed'
  Object.assign(report.cases[0].steps[0], {
    outcome: 'passed',
    executionOutcome: 'executed',
    matched: true,
    executed: true,
    assertions: [
      {
        path: '/outcome',
        expected: 'executed',
        actual: 'executed',
        actualPresent: true,
        passed: true
      },
      {
        path: '/effects/messages/0/content',
        expected: 'Pong!',
        actual: 'Pong!',
        actualPresent: true,
        passed: true
      }
    ]
  })
  return report
}

describe('exact unsaved candidate validation binding', () => {
  beforeEach(() => {
    validate.mockReset()
    validate.mockImplementation(async (input) => passed(input))
  })

  it('sends a resource snapshot and fixtures without changing the prepared creation identity', async () => {
    const prepared = draft(),
      before = structuredClone(prepared)
    const result = await validateAgentMutation(prepared)
    const request = validate.mock.calls[0][0] as AgentValidationRequest
    expect(request.candidate).toEqual(prepared.after)
    expect(request.candidate).not.toBe(prepared.after)
    expect(request.candidate.id).toBe('creation-id')
    expect(request.baseRevision).toBeNull()
    expect(request.candidateHash).toBe(validationHash(prepared.after))
    expect(request.fixtureHash).toBe(validationHash(prepared.arguments.validation))
    expect(result.canCommit).toBe(true)
    expect(prepared).toEqual(before)
  })

  it('binds edit evidence to the exact read revision', async () => {
    const prepared = draft()
    prepared.name = 'edit_command'
    prepared.before = { ...(prepared.after as object), channelMessage: 'Old' }
    prepared.arguments.expectedRevision = resourceRevision(prepared.before)
    const result = await validateAgentMutation(prepared)
    expect(result.binding.baseRevision).toBe(prepared.arguments.expectedRevision)
  })

  it.each(['candidate', 'base', 'fixtures'] as const)(
    'invalidates evidence when %s changes',
    async (part) => {
      const prepared = draft()
      const result = await validateAgentMutation(prepared)
      if (part === 'candidate')
        (prepared.after as { channelMessage: string }).channelMessage = 'Changed'
      if (part === 'base') prepared.before = { changed: true }
      if (part === 'fixtures')
        (prepared.arguments.validation as AgentValidationSuite).cases[0].steps[0].content =
          '!changed'
      expect(() => assertAgentValidationBinding(prepared, result.binding, result.report)).toThrow(
        'stale'
      )
    }
  )

  it('rejects stale worker evidence even if it claims passing assertions', async () => {
    validate.mockImplementation(async (input) => ({ ...passed(input), candidateHash: 'other' }))
    await expect(validateAgentMutation(draft())).rejects.toThrow('stale')
  })

  it('rejects empty-error/no-execution reports as proof of success', async () => {
    validate.mockImplementation(async (input) => {
      const report = passed(input)
      report.coverage.executed = 0
      return report
    })
    expect((await validateAgentMutation(draft())).canCommit).toBe(false)
  })

  it('labels missing fixtures not-run and never starts a worker', async () => {
    const prepared = draft()
    delete prepared.arguments.validation
    const result = await validateAgentMutation(prepared)
    expect(result).toMatchObject({
      canCommit: false,
      report: { outcome: 'not_run', coverage: { executed: 0 } }
    })
    expect(validate).not.toHaveBeenCalled()
  })

  it('deeply rejects bad fixtures without evaluating the candidate', async () => {
    const input = suite()
    input.cases[0].state.members[0].roles = ['missing-role']
    const result = await validateAgentMutation(draft(input))
    expect(result.canCommit).toBe(false)
    expect(result.report.outcome).toBe('not_run')
    expect(validate).not.toHaveBeenCalled()
  })

  it('rejects accessor fixtures without invoking them while binding/reporting the invalid input', async () => {
    const prepared = draft()
    const getter = vi.fn(() => 'unsafe')
    Object.defineProperty(
      (prepared.arguments.validation as AgentValidationSuite).cases[0].state.members[0],
      'name',
      {
        get: getter,
        enumerable: true
      }
    )
    const result = await validateAgentMutation(prepared)
    expect(result.canCommit).toBe(false)
    expect(result.report.outcome).toBe('not_run')
    expect(getter).not.toHaveBeenCalled()
    expect(validate).not.toHaveBeenCalled()
    expect(() =>
      assertAgentValidationBinding(prepared, result.binding, result.report)
    ).not.toThrow()
  })

  it('allows genuinely unsupported matched features only through explicit approval', async () => {
    validate.mockImplementation(async (input) => {
      const report = passed(input)
      report.outcome = report.cases[0].outcome = report.cases[0].steps[0].outcome = 'unsupported'
      report.cases[0].steps[0].executionOutcome = 'unsupported'
      report.cases[0].steps[0].executed = false
      report.cases[0].steps[0].assertions[0].passed = false
      report.coverage.executed = 0
      report.coverage.unsupported = 1
      return report
    })
    expect(await validateAgentMutation(draft())).toMatchObject({
      canCommit: true,
      requiresApproval: true
    })
  })

  it('does not let unmatched or wrong-kind fixtures label themselves unsupported to bypass validation', async () => {
    validate.mockImplementation(async (input) => {
      const report = passed(input)
      report.outcome = 'unsupported'
      Object.assign(report.cases[0].steps[0], {
        outcome: 'unsupported',
        executionOutcome: 'unsupported',
        matched: false,
        executed: false
      })
      report.coverage.executed = report.coverage.matched = 0
      report.coverage.unsupported = 1
      return report
    })
    expect(await validateAgentMutation(draft())).toMatchObject({
      canCommit: false,
      requiresApproval: false
    })
  })

  it('does not approve truncated or incomplete reports which claim a pass', async () => {
    validate.mockImplementation(async (input) => ({ ...passed(input), truncated: true }))
    expect((await validateAgentMutation(draft())).canCommit).toBe(false)
  })

  it.each([
    {},
    { cases: [] },
    (() => {
      const input = suite()
      input.cases[0].state.members[0].roles = ['missing-role']
      return input
    })()
  ])(
    'blocks malformed supplied fixtures on event drafts instead of requesting approval',
    async (validation) => {
      const prepared = draft(validation)
      ;(prepared.after as { type: number }).type = 2
      expect(await validateAgentMutation(prepared)).toMatchObject({
        canCommit: false,
        requiresApproval: false,
        report: { outcome: 'not_run' }
      })
      expect(validate).not.toHaveBeenCalled()
    }
  )

  it('blocks wrong-kind supplied event fixtures while retaining absent event fixtures', async () => {
    const input = suite()
    input.cases[0].steps[0].kind = 'slash'
    delete input.cases[0].steps[0].content
    const prepared = draft(input)
    ;(prepared.after as { type: number }).type = 2
    expect(await validateAgentMutation(prepared)).toMatchObject({
      canCommit: false,
      requiresApproval: false
    })
    delete prepared.arguments.validation
    expect(await validateAgentMutation(prepared)).toMatchObject({
      canCommit: true,
      requiresApproval: true,
      report: { outcome: 'unsupported' }
    })
  })

  it.each(['$definitelyNotARealBCFDFunction(no)', 'Bad $definitelyNotARealVariable'])(
    'does not approve unknown BCFD names as unsupported features: %s',
    async (channelMessage) => {
      validate.mockImplementation(async (input) => runAgentValidation(input))
      const prepared = draft()
      ;(prepared.after as { channelMessage: string }).channelMessage = channelMessage
      const result = await validateAgentMutation(prepared)
      expect(result).toMatchObject({
        canCommit: false,
        requiresApproval: false,
        report: { outcome: 'failed' }
      })
    }
  )

  it('permits recognized but unsimulated features only through explicit approval', async () => {
    validate.mockImplementation(async (input) => runAgentValidation(input))
    const prepared = draft()
    ;(prepared.after as { channelMessage: string }).channelMessage = '$createChannel(no)'
    const result = await validateAgentMutation(prepared)
    expect(result).toMatchObject({
      canCommit: true,
      requiresApproval: true,
      report: { outcome: 'unsupported' }
    })
  })

  it('preserves event command editing without pretending unsupported dispatch was tested', async () => {
    const prepared = draft()
    ;(prepared.after as { type: number }).type = 2
    const result = await validateAgentMutation(prepared)
    expect(result).toMatchObject({
      canCommit: true,
      report: { outcome: 'unsupported', coverage: { executed: 0 } }
    })
    expect(validate).not.toHaveBeenCalled()
  })
})
