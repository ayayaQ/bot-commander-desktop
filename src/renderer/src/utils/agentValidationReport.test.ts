import { describe, expect, it } from 'vitest'
import {
  emptyAgentValidationEffects,
  type AgentValidationOutcome,
  type AgentValidationReport,
  type AgentValidationStepReport
} from '../../../shared/agentValidationTypes'
import {
  AGENT_VALIDATION_DISPLAY_LIMITS,
  agentValidationReportView,
  formatValidationValue,
  type ValidationReportBinding
} from './agentValidationReport'

const candidate = { id: 'candidate_1' }

function step(overrides: Partial<AgentValidationStepReport> = {}): AgentValidationStepReport {
  return {
    index: 0,
    kind: 'message',
    outcome: 'passed',
    executionOutcome: 'executed',
    expectedNegative: false,
    matched: true,
    executed: true,
    reason: '',
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
    ],
    effects: emptyAgentValidationEffects(),
    trace: ['Candidate matched', 'Emitted Pong!'],
    errors: [],
    timedOut: false,
    cancelled: false,
    truncated: false,
    ...overrides
  }
}

function report(overrides: Partial<AgentValidationReport> = {}): AgentValidationReport {
  return {
    version: 1,
    candidateKind: 'command',
    candidateId: candidate.id,
    candidateHash: 'candidate_hash',
    baseRevision: 'base_revision',
    fixtureHash: 'fixture_hash',
    outcome: 'passed',
    cases: [{ name: 'Ping response', outcome: 'passed', steps: [step()] }],
    coverage: {
      matched: 1,
      executed: 1,
      blocked: 0,
      errors: 0,
      unmatched: 0,
      unsupported: 0,
      notRun: 0
    },
    timedOut: false,
    cancelled: false,
    truncated: false,
    limitations: ['Only supplied offline cases were tested.', 'AI responses are fixture mocks.'],
    ...overrides
  }
}

function binding(value: AgentValidationReport): ValidationReportBinding {
  return {
    candidateHash: value.candidateHash,
    baseRevision: value.baseRevision,
    fixtureHash: value.fixtureHash
  }
}

describe('agent validation report presentation', () => {
  it('shows a verified execution and explicit expected/actual assertions', () => {
    const value = report()
    const view = agentValidationReportView(value, binding(value), candidate)

    expect(view.outcome).toBe('Passed')
    expect(view.tone).toBe('success')
    expect(view.summary).toBe('1 candidate execution · 2/2 assertions passed')
    expect(view.warnings).toEqual([])
    expect(view.cases[0].steps[0]).toMatchObject({
      label: 'Step 1 · message',
      execution: 'Matched candidate · Executed',
      assertions: [
        { path: '/outcome', expected: '"executed"', actual: '"executed"', passed: true },
        {
          path: '/effects/messages/0/content',
          expected: '"Pong!"',
          actual: '"Pong!"',
          passed: true
        }
      ]
    })
    expect(view.coverage).toEqual([
      { label: 'Matched', count: 1 },
      { label: 'Executed', count: 1 },
      { label: 'Blocked', count: 0 },
      { label: 'Errors', count: 0 },
      { label: 'Unmatched', count: 0 },
      { label: 'Unsupported', count: 0 },
      { label: 'Not run', count: 0 }
    ])
    expect(view.limitations).toEqual(value.limitations)
  })

  it.each([
    ['failed', 'Failed', 'error'],
    ['blocked', 'Blocked', 'warning'],
    ['unmatched', 'Unmatched', 'warning'],
    ['unsupported', 'Unsupported', 'warning'],
    ['not_run', 'Not run', 'warning']
  ] as const)('keeps %s reports separate from a pass', (outcome, label, tone) => {
    const value = report({ outcome })
    expect(agentValidationReportView(value, binding(value), candidate)).toMatchObject({
      outcome: label,
      tone
    })
  })

  it('does not green-light a report without a privileged binding and candidate identity', () => {
    const value = report()
    for (const view of [
      agentValidationReportView(value, undefined, candidate),
      agentValidationReportView(value, binding(value)),
      agentValidationReportView(value, binding(value), { id: '' })
    ]) {
      expect(view.outcome).toBe('Not verified')
      expect(view.tone).toBe('warning')
      expect(view.warnings).toContain(
        'The report identity cannot be verified against this tool candidate.'
      )
    }
  })

  it.each(['candidateHash', 'baseRevision', 'fixtureHash'] as const)(
    'marks a mismatched %s stale',
    (key) => {
      const value = report()
      const view = agentValidationReportView(
        value,
        { ...binding(value), [key]: 'changed' },
        candidate
      )
      expect(view.outcome).toBe('Stale report')
      expect(view.tone).toBe('warning')
      expect(view.warnings).toContain(
        'This report belongs to a different candidate, revision, or fixture set.'
      )
    }
  )

  it('marks a report for another candidate stale even when binding fields match', () => {
    const value = report()
    expect(
      agentValidationReportView(value, binding(value), { id: 'another_candidate' }).outcome
    ).toBe('Stale report')
  })

  it('keeps a matching new-resource null revision verified', () => {
    const value = report({ baseRevision: null })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Passed')
    expect(view.identity).toContainEqual({ label: 'Base revision', value: '(new resource)' })
    expect(
      agentValidationReportView(value, { ...binding(value), baseRevision: 'old' }, candidate)
        .outcome
    ).toBe('Stale report')
  })

  it('does not infer execution from a coverage counter alone', () => {
    const value = report({
      cases: [{ name: 'No execution', outcome: 'passed', steps: [step({ executed: false })] }]
    })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Not verified')
    expect(view.warnings).toContain('No candidate execution was verified.')
  })

  it('does not treat an unmatched step as a candidate execution', () => {
    const value = report({
      cases: [{ name: 'No match', outcome: 'passed', steps: [step({ matched: false })] }]
    })
    expect(agentValidationReportView(value, binding(value), candidate).outcome).toBe('Not verified')
  })

  it('does not treat a lint-only or assertion-free report as behavioral validation', () => {
    const value = report({ cases: [] })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Not verified')
    expect(view.tone).toBe('warning')
    expect(view.warnings).toContain('No candidate execution was verified.')
    expect(view.warnings).toContain('No explicit behavior assertions were tested.')
  })

  it('does not hide an assertion-free step among verified steps', () => {
    const value = report({
      cases: [
        {
          name: 'Missing checks',
          outcome: 'passed',
          steps: [step(), step({ index: 1, assertions: [] })]
        }
      ]
    })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Not verified')
    expect(view.warnings).toContain('Some validation steps have no explicit behavior assertions.')
  })

  it.each(['/outcome', '/effects/messages/0/content'])(
    'does not verify a step that checks only %s',
    (path) => {
      const incomplete = step()
      incomplete.assertions = incomplete.assertions.filter((assertion) => assertion.path === path)
      const value = report({
        cases: [{ name: 'Incomplete checks', outcome: 'passed', steps: [incomplete] }]
      })
      const view = agentValidationReportView(value, binding(value), candidate)
      expect(view.outcome).toBe('Not verified')
      expect(view.warnings).toContain(
        'Some validation steps are missing outcome or behavior assertions.'
      )
    }
  )

  it('shows an assertion failure even if the aggregate outcome incorrectly says passed', () => {
    const failedStep = step()
    failedStep.assertions[1].actual = 'Wrong response'
    failedStep.assertions[1].passed = false
    const value = report({ cases: [{ name: 'Mismatch', outcome: 'passed', steps: [failedStep] }] })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Failed')
    expect(view.tone).toBe('error')
    expect(view.summary).toBe('1 candidate execution · 1/2 assertions passed')
    expect(view.cases[0].steps[0].assertions[1]).toMatchObject({
      expected: '"Pong!"',
      actual: '"Wrong response"',
      passed: false
    })
  })

  it('supports asserted expected denials after a genuine candidate execution', () => {
    const negative = step({
      index: 1,
      executionOutcome: 'blocked',
      expectedNegative: true,
      executed: false,
      reason: 'Cooldown blocked the repeat command',
      assertions: [
        {
          path: '/outcome',
          expected: 'blocked',
          actual: 'blocked',
          actualPresent: true,
          passed: true
        },
        { path: '/effects/messages', expected: [], actual: [], actualPresent: true, passed: true },
        {
          path: '/reason',
          expected: 'Cooldown blocked the repeat command',
          actual: 'Cooldown blocked the repeat command',
          actualPresent: true,
          passed: true
        }
      ]
    })
    const value = report({
      cases: [{ name: 'Cooldown', outcome: 'passed', steps: [step(), negative] }],
      coverage: {
        matched: 2,
        executed: 1,
        blocked: 1,
        errors: 0,
        unmatched: 0,
        unsupported: 0,
        notRun: 0
      }
    })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Passed')
    expect(view.cases[0].steps[1].outcome).toBe('Passed (expected negative)')
    expect(view.cases[0].steps[1].execution).toBe('Matched candidate · blocked')
  })

  it('supports a matched expected error with explicit effects and specific error assertions', () => {
    const negative = step({
      index: 1,
      executionOutcome: 'error',
      expectedNegative: true,
      executed: false,
      errors: ['Fixture AI error'],
      assertions: [
        { path: '/outcome', expected: 'error', actual: 'error', actualPresent: true, passed: true },
        { path: '/effects/messages', expected: [], actual: [], actualPresent: true, passed: true },
        {
          path: '/errors/0',
          expected: 'Fixture AI error',
          actual: 'Fixture AI error',
          actualPresent: true,
          passed: true
        }
      ]
    })
    const value = report({
      cases: [{ name: 'Expected error', outcome: 'passed', steps: [step(), negative] }]
    })
    expect(agentValidationReportView(value, binding(value), candidate).outcome).toBe('Passed')
  })

  it.each([
    'not declared expected negative',
    'candidate unmatched',
    'missing specific reason',
    'missing effect assertion',
    'noncanonical error index',
    'empty intended reason',
    'wrong expected outcome'
  ])('fails closed for an arbitrary denial: %s', (flaw) => {
    const negative = step({
      index: 1,
      executionOutcome: 'blocked',
      expectedNegative: true,
      executed: false,
      reason: 'Requires admin permission',
      assertions: [
        {
          path: '/outcome',
          expected: 'blocked',
          actual: 'blocked',
          actualPresent: true,
          passed: true
        },
        { path: '/effects/messages', expected: [], actual: [], actualPresent: true, passed: true },
        {
          path: '/reason',
          expected: 'Requires admin permission',
          actual: 'Requires admin permission',
          actualPresent: true,
          passed: true
        }
      ]
    })
    if (flaw === 'not declared expected negative') negative.expectedNegative = false
    if (flaw === 'candidate unmatched') negative.matched = false
    if (flaw === 'missing specific reason') negative.assertions.pop()
    if (flaw === 'missing effect assertion') negative.assertions.splice(1, 1)
    if (flaw === 'noncanonical error index') negative.assertions[2].path = '/errors/00'
    if (flaw === 'empty intended reason') negative.assertions[2].expected = ''
    if (flaw === 'wrong expected outcome') negative.assertions[0].expected = 'error'
    const value = report({
      cases: [{ name: 'Unverified denial', outcome: 'passed', steps: [step(), negative] }]
    })
    const view = agentValidationReportView(value, binding(value), candidate)
    expect(view.outcome).toBe('Failed')
    expect(view.tone).toBe('error')
    expect(view.cases[0].outcome).toBe('Failed')
    expect(view.cases[0].steps[1].outcome).toBe('Failed')
    expect(view.cases[0].steps[1].tone).toBe('error')
  })

  it('shows effects and before/after state diffs in six labeled groups', () => {
    const effects = emptyAgentValidationEffects()
    effects.messages = [
      { id: 2, author: 'Bot', content: 'Pong!', kind: 'bot' },
      { id: 3, author: 'Bot', content: 'Private response', kind: 'dm', recipient: 'Sam' }
    ]
    effects.deletedMessageIds = [1]
    effects.memberChanges = [
      {
        path: '/members/1/muted',
        before: false,
        after: true,
        beforePresent: true,
        afterPresent: true
      }
    ]
    effects.botStateChanges = [
      { path: '/count', before: 1, after: 2, beforePresent: true, afterPresent: true }
    ]
    effects.variableChanges = [
      { path: '/ready', before: null, after: false, beforePresent: false, afterPresent: true }
    ]
    effects.cooldownChanges = [
      { path: '/candidate_1', before: 0, after: 1500, beforePresent: true, afterPresent: true }
    ]
    const value = report({
      cases: [{ name: 'Effects', outcome: 'passed', steps: [step({ effects })] }]
    })
    const views = agentValidationReportView(value, binding(value), candidate).cases[0].steps[0]
      .effects
    expect(views).toEqual([
      {
        label: 'Messages',
        count: 2,
        preview: formatValidationValue(effects.messages),
        hiddenItems: 0,
        truncated: false
      },
      {
        label: 'Deleted messages',
        count: 1,
        preview: '[\n  1\n]',
        hiddenItems: 0,
        truncated: false
      },
      {
        label: 'Member changes',
        count: 1,
        preview: formatValidationValue(effects.memberChanges),
        hiddenItems: 0,
        truncated: false
      },
      {
        label: 'Bot state changes',
        count: 1,
        preview: formatValidationValue(effects.botStateChanges),
        hiddenItems: 0,
        truncated: false
      },
      {
        label: 'Variable changes',
        count: 1,
        preview: formatValidationValue(effects.variableChanges),
        hiddenItems: 0,
        truncated: false
      },
      {
        label: 'Cooldown changes',
        count: 1,
        preview: formatValidationValue(effects.cooldownChanges),
        hiddenItems: 0,
        truncated: false
      }
    ])
    expect(views[4].preview).toContain('"beforePresent": false')
    expect(views[4].preview).toContain('"after": false')
  })

  it('bounds effect item counts and JSON preview text without losing full counts', () => {
    const limits = AGENT_VALIDATION_DISPLAY_LIMITS
    const effects = emptyAgentValidationEffects()
    effects.deletedMessageIds = Array.from({ length: limits.effectItems + 2 }, (_, index) => index)
    effects.botStateChanges = Array.from({ length: limits.effectItems + 3 }, () => ({
      path: '/value',
      before: '',
      after: 'x'.repeat(limits.text),
      beforePresent: true,
      afterPresent: true
    }))
    const value = report({
      cases: [{ name: 'Large effects', outcome: 'passed', steps: [step({ effects })] }]
    })
    const views = agentValidationReportView(value, binding(value), candidate).cases[0].steps[0]
      .effects
    expect(views[1]).toMatchObject({
      count: limits.effectItems + 2,
      hiddenItems: 2,
      truncated: false,
      preview: formatValidationValue(effects.deletedMessageIds.slice(0, limits.effectItems))
    })
    expect(views[3]).toMatchObject({
      count: limits.effectItems + 3,
      hiddenItems: 3,
      truncated: true
    })
    expect(views[3].preview).toHaveLength(limits.text)
    expect(views[3].preview.endsWith('…')).toBe(true)
  })

  it('reports empty effects explicitly without inventing state changes', () => {
    const value = report()
    const effects = agentValidationReportView(value, binding(value), candidate).cases[0].steps[0]
      .effects
    expect(effects).toHaveLength(6)
    expect(
      effects.every(
        (effect) =>
          effect.count === 0 &&
          effect.preview === '[]' &&
          effect.hiddenItems === 0 &&
          !effect.truncated
      )
    ).toBe(true)
  })

  it.each(['timedOut', 'cancelled', 'truncated'] as const)(
    'warns about %s flags at report and step level',
    (flag) => {
      for (const value of [
        report({ [flag]: true }),
        report({
          cases: [{ name: 'Incomplete', outcome: 'passed', steps: [step({ [flag]: true })] }]
        })
      ]) {
        const view = agentValidationReportView(value, binding(value), candidate)
        expect(view.outcome).toBe('Not verified')
        expect(view.tone).toBe('warning')
        expect(view.warnings.length).toBeGreaterThan(0)
      }
    }
  )

  it.each(['unsupported', 'unmatched', 'not_run'] as const)(
    'never silently passes a skipped %s execution',
    (executionOutcome) => {
      const value = report({
        cases: [
          {
            name: 'Skipped',
            outcome: 'passed',
            steps: [step(), step({ index: 1, executionOutcome, executed: false })]
          }
        ]
      })
      const view = agentValidationReportView(value, binding(value), candidate)
      expect(view.outcome).toBe('Not verified')
      expect(view.warnings).toContain(
        'Some supplied steps were unsupported, unmatched, or not run.'
      )
    }
  )

  it('bounds cases, steps, assertions, trace, errors, limitations, and displayed text', () => {
    const limits = AGENT_VALIDATION_DISPLAY_LIMITS
    const long = 'x'.repeat(limits.text + 100)
    const largeStep = step({
      reason: long,
      assertions: Array.from({ length: limits.assertions + 2 }, () => ({
        path: long,
        expected: long,
        actual: long,
        actualPresent: true,
        passed: true
      })),
      trace: Array.from({ length: limits.lines + 2 }, () => long),
      errors: Array.from({ length: limits.lines + 3 }, () => long)
    })
    const value = report({
      cases: Array.from({ length: limits.cases + 2 }, (_, index) => ({
        name: `${long}${index}`,
        outcome: 'passed' as AgentValidationOutcome,
        steps: Array.from({ length: limits.steps + 2 }, () => largeStep)
      })),
      limitations: Array.from({ length: limits.lines + 2 }, (_, index) => `${long}${index}`)
    })
    const view = agentValidationReportView(value, binding(value), candidate)
    const firstCase = view.cases[0]
    const firstStep = firstCase.steps[0]

    expect(view.cases).toHaveLength(limits.cases)
    expect(view.hiddenCases).toBe(2)
    expect(firstCase.steps).toHaveLength(limits.steps)
    expect(firstCase.hiddenSteps).toBe(2)
    expect(firstStep.assertions).toHaveLength(limits.assertions)
    expect(firstStep.hiddenAssertions).toBe(2)
    expect(firstStep.trace).toHaveLength(limits.lines)
    expect(firstStep.hiddenTrace).toBe(2)
    expect(firstStep.errors).toHaveLength(limits.lines)
    expect(firstStep.hiddenErrors).toBe(3)
    expect(view.limitations).toHaveLength(limits.lines)
    expect(view.hiddenLimitations).toBe(2)
    for (const text of [
      firstCase.name,
      firstStep.reason,
      firstStep.assertions[0].path,
      firstStep.assertions[0].expected,
      firstStep.assertions[0].actual,
      firstStep.trace[0],
      firstStep.errors[0],
      view.limitations[0]
    ]) {
      expect(text).toHaveLength(limits.text)
      expect(text.endsWith('…')).toBe(true)
    }
  })

  it('preserves a missing actual value separately from null, false, and empty text', () => {
    expect(formatValidationValue(null, false)).toBe('(missing value)')
    expect(formatValidationValue(null)).toBe('null')
    expect(formatValidationValue(false)).toBe('false')
    expect(formatValidationValue('')).toBe('""')
    expect(formatValidationValue(0)).toBe('0')
    const missingStep = step()
    missingStep.assertions[1].actual = null
    missingStep.assertions[1].actualPresent = false
    const value = report({
      cases: [{ name: 'Missing actual', outcome: 'passed', steps: [missingStep] }]
    })
    expect(
      agentValidationReportView(value, binding(value), candidate).cases[0].steps[0].assertions[1]
        .actual
    ).toBe('(missing value)')
    expect(agentValidationReportView(value, binding(value), candidate).outcome).toBe('Failed')
  })

  it('has a safe fallback for an undisplayable value', () => {
    const circular: { value?: unknown } = {}
    circular.value = circular
    expect(formatValidationValue(circular)).toBe('(value could not be displayed)')
  })

  it('does not mutate the report, candidate, or binding', () => {
    const value = report()
    const bound = binding(value)
    const before = structuredClone({ value, bound, candidate })
    agentValidationReportView(value, bound, candidate)
    expect({ value, bound, candidate }).toEqual(before)
  })
})
