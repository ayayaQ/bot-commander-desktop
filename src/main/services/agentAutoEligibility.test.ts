import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BCFDCommand } from '../types/types'
import type { AgentValidationReport, AgentValidationSuite } from '../../shared/agentValidationTypes'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { createPlaygroundState } from '../../shared/playground/types'
import type { PreparedMutation } from './agentTools'
import { resourceRevision } from './resourceChangeService'
import { checkAutoEligibility } from './agentAutoEligibility'

const { settings } = vi.hoisted(() => ({ settings: { useLegacyInterpreter: false } }))
vi.mock('./settingsService', () => ({ getSettings: () => settings }))

const hash = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
function command(overrides: Partial<BCFDCommand> = {}): BCFDCommand {
  return decodeBCFDCommand({
    id: 'ordinary-command',
    command: '!hello',
    commandDescription: 'Say hello',
    type: 0,
    channelMessage: 'Hello!',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...overrides
  }).command
}
function suite(): AgentValidationSuite {
  const state = createPlaygroundState()
  return {
    cases: [
      {
        name: 'ordinary reply',
        state,
        steps: [
          {
            kind: 'message',
            senderId: state.members[0].id,
            content: '!hello',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: 'Hello!' }
            ]
          }
        ]
      }
    ]
  }
}
function draft(after = command(), before: BCFDCommand | null = null): PreparedMutation {
  return {
    name: before ? 'edit_command' : 'create_command',
    arguments: { validation: suite() },
    before,
    after,
    target: { type: 'command', id: after.id }
  }
}
/** Ordinary host-owned mock of the existing behavioral-validation contract. */
function passed(prepared: PreparedMutation): AgentValidationReport {
  const fixtures = prepared.arguments.validation as AgentValidationSuite
  const report = createNotRunAgentValidationReport(
    {
      candidateKind: 'command',
      candidate: prepared.after as BCFDCommand,
      candidateHash: hash(prepared.after),
      baseRevision: prepared.before === null ? null : resourceRevision(prepared.before),
      fixtureHash: hash(fixtures),
      wrapEvalInIIFE: !settings.useLegacyInterpreter,
      suite: fixtures
    },
    'ordinary mock'
  )
  report.outcome = 'passed'
  report.coverage.matched = report.coverage.executed = fixtures.cases.reduce(
    (count, item) => count + item.steps.length,
    0
  )
  report.coverage.notRun = 0
  for (let caseIndex = 0; caseIndex < report.cases.length; caseIndex++) {
    const item = report.cases[caseIndex]
    item.outcome = 'passed'
    for (let index = 0; index < item.steps.length; index++) {
      const step = item.steps[index]
      Object.assign(step, {
        outcome: 'passed',
        executionOutcome: 'executed',
        matched: true,
        executed: true,
        assertions: fixtures.cases[caseIndex].steps[index].assertions.map((assertion) => ({
          path: assertion.path,
          expected: assertion.equals,
          actual: assertion.equals,
          passed: true,
          actualPresent: true
        }))
      })
      step.effects.messages = [{ id: 2, author: 'Playground Bot', content: 'Hello!', kind: 'bot' }]
    }
  }
  return report
}
function check(after = command(), before: BCFDCommand | null = null) {
  const prepared = draft(after, before)
  return checkAutoEligibility(prepared, passed(prepared))
}

describe('deterministic reviewed-Auto eligibility with ordinary offline fixtures', () => {
  beforeEach(() => {
    settings.useLegacyInterpreter = false
  })

  it.each(['create_memory', 'edit_memory'])(
    'allows the %s profile for later privacy review',
    (name) => {
      expect(
        checkAutoEligibility({
          name,
          arguments: {},
          before: null,
          after: { content: 'Use a concise style' },
          target: { type: 'memory', id: 'memory' }
        })
      ).toEqual({ eligible: true, reasonCode: 'eligible_memory' })
    }
  )

  it.each([
    ['delete_memory', 'memory'],
    ['edit_bot_state', 'bot-state'],
    ['edit_startup_js', 'startup-js'],
    ['edit_developer_prompt', 'developer-prompt'],
    ['create_interaction', 'interaction'],
    ['edit_interaction', 'interaction']
  ])('keeps %s manual', (name, type) => {
    expect(
      checkAutoEligibility({
        name,
        arguments: {},
        before: null,
        after: {},
        target: { type }
      })
    ).toEqual({ eligible: false, reasonCode: 'manual_mutation' })
  })

  it('allows an exactly validated ordinary channel response without mutating its inputs', () => {
    const prepared = draft(),
      report = passed(prepared)
    const snapshot = structuredClone({ prepared, report })
    expect(checkAutoEligibility(prepared, report)).toEqual({
      eligible: true,
      reasonCode: 'eligible_response_command'
    })
    expect({ prepared, report }).toEqual(snapshot)
  })

  it.each([
    'Hello $namePlain in $channel!',
    '$upper($trim(hello))',
    '$sum{2|$mul(3,4)}',
    '$if($ID == 100000000000000001)Hello $namePlain$else Hello$endif',
    '$if($length($message) > 0 & !$contains($message,goodbye))Hello$endif',
    '$if(1 == 2)First$elseif($isNumber(2))Second$else Third$endif'
  ])('allows audited pure/context BCFD: %s', (channelMessage) => {
    expect(check(command({ channelMessage })).eligible).toBe(true)
  })

  it('allows safe reply and channel-embed content', () => {
    expect(
      check(
        command({
          channelMessageAsReply: true,
          channelEmbed: {
            title: '$upper(hello)',
            description: 'A short reply',
            hexColor: '336699',
            imageURL: '',
            thumbnailURL: '',
            footer: '$namePlain'
          }
        })
      ).eligible
    ).toBe(true)
  })

  it.each([
    '$chat(hello)',
    '$get(greeting)',
    '$set(greeting,hello)',
    '$date',
    '$random{hello|hi}',
    '$cooldownRemaining',
    '$commandCount',
    '$serverOwner',
    '$eval return "Hello" $halt',
    '$unknownGreeting',
    '$upper($get(greeting))',
    '$if(1 == 1)Hello$else $chat(hello)$endif',
    '$if($get(greeting) == hello)Hello$endif'
  ])('keeps non-profile or unsupported BCFD manual: %s', (channelMessage) => {
    expect(check(command({ channelMessage }))).toEqual({
      eligible: false,
      reasonCode: 'template_effect'
    })
  })

  it('keeps incomplete ordinary template syntax manual', () => {
    expect(check(command({ channelMessage: '$if(1 == 1)Hello' })).reasonCode).toBe(
      'template_syntax'
    )
    expect(check(command({ channelMessage: '$upper(hello' })).reasonCode).toBe('template_syntax')
  })

  it.each([
    { privateMessage: 'Hello!' },
    { specificChannel: '900000000000000002' },
    { reaction: 'hello' },
    { deleteAfter: true },
    { deleteNum: 1 },
    { roleToAssign: '200000000000000001' },
    { isKick: true },
    { isBan: true },
    { isVoiceMute: true },
    { cooldown: 5, cooldownType: 'User' }
  ])('keeps a configured extra command effect manual: %j', (overrides) => {
    expect(check(command(overrides)).reasonCode).toBe('command_effect')
  })

  it.each(['imageURL', 'thumbnailURL'] as const)('keeps embed %s URLs manual', (field) => {
    const after = command()
    after.channelEmbed[field] = 'https://example.com/ordinary-picture.png'
    expect(check(after).reasonCode).toBe('command_effect')
  })

  it.each([1, 2, 3, 4, 5] as const)('keeps event type %s manual', (type) => {
    expect(check(command({ type })).reasonCode).toBe('command_event')
  })

  it.each([
    { command: '' },
    { command: '*' },
    { command: '$namePlain' },
    { phrase: true },
    { startsWith: true }
  ])('requires a literal exact new trigger: %j', (overrides) => {
    expect(check(command(overrides)).reasonCode).toBe('trigger_scope')
  })

  it('allows response-only edits with existing matching and restriction scope unchanged', () => {
    const before = command({
      startsWith: true,
      isAdmin: true,
      channelWhitelist: '900000000000000002',
      serverWhitelist: '900000000000000001'
    })
    expect(check({ ...before, channelMessage: 'Hello again!' }, before).eligible).toBe(true)
  })

  it.each([
    { command: '!hi' },
    { startsWith: true },
    { isAdmin: true },
    { isNSFW: true },
    { requiredRole: '200000000000000001' },
    { channelWhitelist: '900000000000000002' },
    { serverWhitelist: '900000000000000001' }
  ])('keeps edits to matching/restriction fields manual conservatively: %j', (overrides) => {
    expect(check(command(overrides), command()).reasonCode).toBe('changed_command_scope')
  })

  it('checks the old command too when removing an existing non-response effect', () => {
    expect(check(command(), command({ privateMessage: 'Hello!' })).reasonCode).toBe(
      'command_effect'
    )
    expect(check(command(), command({ channelMessage: '$chat(hello)' })).reasonCode).toBe(
      'template_effect'
    )
  })

  it.each([
    { isAdmin: true },
    { isNSFW: true },
    { requiredRole: '200000000000000001' },
    { channelWhitelist: '900000000000000002' },
    { serverWhitelist: '900000000000000001' }
  ])('keeps removal of an existing restriction manual: %j', (restriction) => {
    expect(check(command(), command(restriction)).reasonCode).toBe('changed_command_scope')
  })

  it('accepts explicitly asserted blocked steps alongside a successful execution', () => {
    const prepared = draft(command({ requiredRole: '200000000000000001' }))
    const fixtures = prepared.arguments.validation as AgentValidationSuite
    fixtures.cases[0].steps.push({
      kind: 'message',
      senderId: fixtures.cases[0].state.members[1].id,
      content: '!hello',
      assertions: [
        { path: '/outcome', equals: 'blocked' },
        { path: '/effects/messages/length', equals: 0 },
        { path: '/reason', equals: 'Missing required role' }
      ]
    })
    const report = passed(prepared)
    const blocked = report.cases[0].steps[1]
    Object.assign(blocked, {
      executionOutcome: 'blocked',
      executed: false,
      expectedNegative: true,
      reason: 'Missing required role'
    })
    blocked.effects.messages = []
    report.coverage.executed = 1
    report.coverage.blocked = 1
    expect(checkAutoEligibility(prepared, report).eligible).toBe(true)
  })

  it('requires explicit validation and does not let a prior eligible item affect another', () => {
    const prepared = draft()
    expect(checkAutoEligibility(prepared).reasonCode).toBe('validation_required')
    expect(check().eligible).toBe(true)
    expect(check(command({ privateMessage: 'Hello!' })).eligible).toBe(false)
  })

  it.each(['candidateHash', 'fixtureHash', 'candidateId', 'baseRevision'] as const)(
    'rejects stale %s evidence',
    (field) => {
      const prepared = draft(),
        report = passed(prepared)
      report[field] = 'old-evidence'
      expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_stale')
    }
  )

  it('binds the exact candidate, prior edit revision, fixtures and interpreter mode', () => {
    const prepared = draft(command(), command({ channelMessage: 'Before' })),
      report = passed(prepared)
    prepared.before = command({ channelMessage: 'Different before' })
    expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_stale')
    prepared.before = command({ channelMessage: 'Before' })
    ;(prepared.after as BCFDCommand).channelMessage = 'Different after'
    expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_stale')
    ;(prepared.after as BCFDCommand).channelMessage = 'Hello!'
    ;(prepared.arguments.validation as AgentValidationSuite).cases[0].steps[0].content =
      '!different'
    expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_stale')
    prepared.arguments.validation = suite()
    settings.useLegacyInterpreter = true
    expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_stale')
  })

  it.each(['timedOut', 'cancelled', 'truncated'] as const)('rejects a %s report', (flag) => {
    const prepared = draft(),
      report = passed(prepared)
    report[flag] = true
    expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_incomplete')
  })

  it.each(['unsupported', 'not_run', 'failed', 'blocked', 'unmatched'] as const)(
    'keeps a %s behavioral report manual',
    (outcome) => {
      const prepared = draft(),
        report = passed(prepared)
      report.outcome = outcome
      expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_incomplete')
    }
  )

  it.each(['unsupported', 'errors', 'unmatched', 'notRun'] as const)(
    'requires clean %s coverage',
    (field) => {
      const prepared = draft(),
        report = passed(prepared)
      report.coverage[field] = 1
      expect(checkAutoEligibility(prepared, report).reasonCode).toBe('validation_incomplete')
    }
  )

  it('requires all cases, steps and explicit assertion values with nonzero execution', () => {
    const prepared = draft(),
      fixtures = prepared.arguments.validation as AgentValidationSuite
    fixtures.cases.push(structuredClone(fixtures.cases[0]))
    fixtures.cases[1].name = 'second ordinary reply'
    const complete = passed(prepared)
    const report = structuredClone(complete)
    report.cases.pop()
    expect(checkAutoEligibility(prepared, report).eligible).toBe(false)
    const missingActual = structuredClone(complete)
    missingActual.cases[0].steps[0].assertions[0].actualPresent = false
    expect(checkAutoEligibility(prepared, missingActual).eligible).toBe(false)
    const failedAssertion = structuredClone(complete)
    failedAssertion.cases[0].steps[0].assertions[0].passed = false
    expect(checkAutoEligibility(prepared, failedAssertion).eligible).toBe(false)
    const wrongActual = structuredClone(complete)
    wrongActual.cases[0].steps[0].assertions[0].actual = 'blocked'
    expect(checkAutoEligibility(prepared, wrongActual).eligible).toBe(false)
    const unexecuted = structuredClone(complete)
    unexecuted.coverage.executed = 0
    expect(checkAutoEligibility(prepared, unexecuted).eligible).toBe(false)
  })

  it('requires every step to match and rejects step-level truncation or interpreter errors', () => {
    const prepared = draft(),
      complete = passed(prepared)
    const unmatched = structuredClone(complete)
    unmatched.cases[0].steps[0].matched = false
    expect(checkAutoEligibility(prepared, unmatched).eligible).toBe(false)
    const truncated = structuredClone(complete)
    truncated.cases[0].steps[0].truncated = true
    expect(checkAutoEligibility(prepared, truncated).eligible).toBe(false)
    const errors = structuredClone(complete)
    errors.cases[0].steps[0].errors = ['Ordinary invalid argument']
    expect(checkAutoEligibility(prepared, errors).eligible).toBe(false)
  })

  it('requires observed effects to remain response-only', () => {
    const prepared = draft(),
      complete = passed(prepared)
    const report = structuredClone(complete)
    report.cases[0].steps[0].effects.messages[0].kind = 'dm'
    expect(checkAutoEligibility(prepared, report).eligible).toBe(false)
    const stateChange = structuredClone(complete)
    stateChange.cases[0].steps[0].effects.variableChanges.push({
      path: '/greeting',
      before: null,
      after: 'Hello',
      beforePresent: false,
      afterPresent: true
    })
    expect(checkAutoEligibility(prepared, stateChange).eligible).toBe(false)
  })
})
