import type {
  AgentValidationEffects,
  AgentValidationReport,
  AgentValidationStepReport
} from '../../../shared/agentValidationTypes'

export const AGENT_VALIDATION_DISPLAY_LIMITS = {
  cases: 8,
  steps: 8,
  assertions: 8,
  effectItems: 4,
  lines: 8,
  text: 600
} as const

export type ValidationReportBinding = Pick<
  AgentValidationReport,
  'candidateHash' | 'baseRevision' | 'fixtureHash'
>

export type ValidationReportTone = 'success' | 'warning' | 'error'

export interface ValidationAssertionView {
  path: string
  expected: string
  actual: string
  passed: boolean
}

export interface ValidationStepView {
  label: string
  outcome: string
  tone: ValidationReportTone
  execution: string
  reason: string
  assertions: ValidationAssertionView[]
  hiddenAssertions: number
  effects: ValidationEffectView[]
  trace: string[]
  hiddenTrace: number
  errors: string[]
  hiddenErrors: number
}

export interface ValidationEffectView {
  label: string
  count: number
  preview: string
  hiddenItems: number
  truncated: boolean
}

export interface ValidationCaseView {
  name: string
  outcome: string
  tone: ValidationReportTone
  steps: ValidationStepView[]
  hiddenSteps: number
}

export interface ValidationReportView {
  outcome: string
  tone: ValidationReportTone
  summary: string
  warnings: string[]
  coverage: Array<{ label: string; count: number }>
  identity: Array<{ label: string; value: string }>
  cases: ValidationCaseView[]
  caseCount: number
  hiddenCases: number
  limitations: string[]
  hiddenLimitations: number
}

const outcomeLabels: Record<AgentValidationReport['outcome'], string> = {
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  unmatched: 'Unmatched',
  unsupported: 'Unsupported',
  not_run: 'Not run'
}

function boundedText(value: string): string {
  return value.length > AGENT_VALIDATION_DISPLAY_LIMITS.text
    ? `${value.slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.text - 1)}…`
    : value
}

/** Preserve false/null/empty values, and distinguish a missing actual assertion value. */
export function formatValidationValue(value: unknown, present = true): string {
  if (!present) return '(missing value)'
  try {
    const formatted = JSON.stringify(value, null, 2)
    return boundedText(formatted === undefined ? String(value) : formatted)
  } catch {
    return '(value could not be displayed)'
  }
}

function toneFor(outcome: AgentValidationReport['outcome']): ValidationReportTone {
  if (outcome === 'passed') return 'success'
  return outcome === 'failed' ? 'error' : 'warning'
}

function candidateId(candidate: unknown): string | null {
  if (!candidate || typeof candidate !== 'object' || !('id' in candidate)) return null
  return typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : null
}

function effectViews(effects: AgentValidationEffects): ValidationEffectView[] {
  const groups: Array<{ label: string; values: unknown[] }> = [
    { label: 'Messages', values: effects.messages },
    { label: 'Deleted messages', values: effects.deletedMessageIds },
    { label: 'Member changes', values: effects.memberChanges },
    { label: 'Bot state changes', values: effects.botStateChanges },
    { label: 'Variable changes', values: effects.variableChanges },
    { label: 'Cooldown changes', values: effects.cooldownChanges }
  ]
  return groups.map(({ label, values }) => {
    const preview = formatValidationValue(
      values.slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.effectItems)
    )
    return {
      label,
      count: values.length,
      preview,
      hiddenItems: Math.max(0, values.length - AGENT_VALIDATION_DISPLAY_LIMITS.effectItems),
      truncated: preview.endsWith('…')
    }
  })
}

function isVerifiedExpectedNegative(step: AgentValidationStepReport): boolean {
  return (
    step.expectedNegative &&
    step.matched &&
    ['blocked', 'error'].includes(step.executionOutcome) &&
    step.assertions.some(
      (assertion) =>
        assertion.path === '/outcome' &&
        assertion.expected === step.executionOutcome &&
        assertion.passed &&
        assertion.actualPresent
    ) &&
    step.assertions.some((assertion) => assertion.path.startsWith('/effects/')) &&
    step.assertions.some(
      (assertion) =>
        assertion.passed &&
        assertion.actualPresent &&
        (assertion.path === '/reason' || /^\/errors\/(0|[1-9]\d*)$/.test(assertion.path)) &&
        typeof assertion.expected === 'string' &&
        assertion.expected.trim().length > 0
    )
  )
}

function displayedStepOutcome(step: AgentValidationStepReport): AgentValidationReport['outcome'] {
  if (
    step.outcome === 'passed' &&
    (step.assertions.some((assertion) => !assertion.passed || !assertion.actualPresent) ||
      ((['blocked', 'error'].includes(step.executionOutcome) || step.expectedNegative) &&
        !isVerifiedExpectedNegative(step)))
  )
    return 'failed'
  return step.outcome
}

function displayedCaseOutcome(
  entry: AgentValidationReport['cases'][number]
): AgentValidationReport['outcome'] {
  return entry.outcome === 'passed' &&
    entry.steps.some((step) => displayedStepOutcome(step) === 'failed')
    ? 'failed'
    : entry.outcome
}

/** Pure presentation logic: no IPC, execution, hashing, provider calls, or approval side effects. */
export function agentValidationReportView(
  report: AgentValidationReport,
  binding?: ValidationReportBinding,
  candidate?: unknown
): ValidationReportView {
  const steps = report.cases.flatMap((entry) => entry.steps)
  const assertions = steps.flatMap((step) => step.assertions)
  const passedAssertions = assertions.filter(
    (assertion) => assertion.passed && assertion.actualPresent
  ).length
  const hasExecution =
    report.coverage.executed > 0 &&
    steps.some((step) => step.matched && step.executed && step.executionOutcome === 'executed')
  const hasAssertions = assertions.length > 0
  const currentCandidateId = candidateId(candidate)
  const hasBinding = !!binding?.candidateHash && !!binding?.fixtureHash
  const stale =
    (hasBinding &&
      (binding.candidateHash !== report.candidateHash ||
        binding.baseRevision !== report.baseRevision ||
        binding.fixtureHash !== report.fixtureHash)) ||
    (currentCandidateId !== null && currentCandidateId !== report.candidateId)
  const warnings: string[] = []

  if (stale)
    warnings.push('This report belongs to a different candidate, revision, or fixture set.')
  if (!hasBinding || currentCandidateId === null)
    warnings.push('The report identity cannot be verified against this tool candidate.')
  if (!hasExecution) warnings.push('No candidate execution was verified.')
  if (!hasAssertions) warnings.push('No explicit behavior assertions were tested.')
  else if (steps.some((step) => step.assertions.length === 0))
    warnings.push('Some validation steps have no explicit behavior assertions.')
  else if (
    steps.some(
      (step) =>
        !step.assertions.some((assertion) => assertion.path === '/outcome') ||
        !step.assertions.some(
          (assertion) =>
            assertion.path.startsWith('/effects/') || assertion.path.startsWith('/errors/')
        )
    )
  )
    warnings.push('Some validation steps are missing outcome or behavior assertions.')
  if (report.timedOut || steps.some((step) => step.timedOut))
    warnings.push('Validation timed out before a complete result was available.')
  if (report.cancelled || steps.some((step) => step.cancelled))
    warnings.push('Validation was cancelled.')
  if (report.truncated || steps.some((step) => step.truncated))
    warnings.push('The validation report was truncated.')
  if (
    report.coverage.unsupported > 0 ||
    report.coverage.unmatched > 0 ||
    report.coverage.notRun > 0 ||
    steps.some((step) => ['unsupported', 'unmatched', 'not_run'].includes(step.executionOutcome))
  )
    warnings.push('Some supplied steps were unsupported, unmatched, or not run.')

  let outcome = outcomeLabels[report.outcome]
  let tone = toneFor(report.outcome)
  if (stale) {
    outcome = 'Stale report'
    tone = 'warning'
  } else if (report.outcome === 'passed') {
    const inconsistent =
      passedAssertions !== assertions.length ||
      report.cases.some((entry) => entry.outcome !== 'passed') ||
      steps.some(
        (step) =>
          step.outcome !== 'passed' ||
          ((['blocked', 'error'].includes(step.executionOutcome) || step.expectedNegative) &&
            !isVerifiedExpectedNegative(step))
      )
    if (inconsistent) {
      outcome = 'Failed'
      tone = 'error'
      warnings.push('The reported pass conflicts with the case or assertion results.')
    } else if (warnings.length > 0) {
      outcome = 'Not verified'
      tone = 'warning'
    }
  }

  const cases: ValidationCaseView[] = report.cases
    .slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.cases)
    .map((entry) => ({
      name: boundedText(entry.name),
      outcome: outcomeLabels[displayedCaseOutcome(entry)],
      tone: toneFor(displayedCaseOutcome(entry)),
      hiddenSteps: Math.max(0, entry.steps.length - AGENT_VALIDATION_DISPLAY_LIMITS.steps),
      steps: entry.steps.slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.steps).map((step) => ({
        label: `Step ${step.index + 1} · ${step.kind}`,
        outcome: `${outcomeLabels[displayedStepOutcome(step)]}${
          isVerifiedExpectedNegative(step) ? ' (expected negative)' : ''
        }`,
        tone: toneFor(displayedStepOutcome(step)),
        execution: `${step.matched ? 'Matched candidate' : 'Candidate unmatched'} · ${
          step.executed ? 'Executed' : step.executionOutcome.replace('_', ' ')
        }`,
        reason: boundedText(step.reason || ''),
        assertions: step.assertions
          .slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.assertions)
          .map((assertion) => ({
            path: boundedText(assertion.path),
            expected: formatValidationValue(assertion.expected),
            actual: formatValidationValue(assertion.actual, assertion.actualPresent),
            passed: assertion.passed && assertion.actualPresent
          })),
        hiddenAssertions: Math.max(
          0,
          step.assertions.length - AGENT_VALIDATION_DISPLAY_LIMITS.assertions
        ),
        effects: effectViews(step.effects),
        trace: step.trace.slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.lines).map(boundedText),
        hiddenTrace: Math.max(0, step.trace.length - AGENT_VALIDATION_DISPLAY_LIMITS.lines),
        errors: step.errors.slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.lines).map(boundedText),
        hiddenErrors: Math.max(0, step.errors.length - AGENT_VALIDATION_DISPLAY_LIMITS.lines)
      }))
    }))
  const limitations = [...new Set(report.limitations)].map(boundedText)

  return {
    outcome,
    tone,
    summary: `${report.coverage.executed} candidate execution${
      report.coverage.executed === 1 ? '' : 's'
    } · ${passedAssertions}/${assertions.length} assertions passed`,
    warnings,
    coverage: [
      { label: 'Matched', count: report.coverage.matched },
      { label: 'Executed', count: report.coverage.executed },
      { label: 'Blocked', count: report.coverage.blocked },
      { label: 'Errors', count: report.coverage.errors },
      { label: 'Unmatched', count: report.coverage.unmatched },
      { label: 'Unsupported', count: report.coverage.unsupported },
      { label: 'Not run', count: report.coverage.notRun }
    ],
    identity: [
      { label: 'Candidate', value: boundedText(`${report.candidateKind} · ${report.candidateId}`) },
      { label: 'Candidate hash', value: boundedText(report.candidateHash) },
      { label: 'Base revision', value: boundedText(report.baseRevision ?? '(new resource)') },
      { label: 'Fixture hash', value: boundedText(report.fixtureHash) }
    ],
    cases,
    caseCount: report.cases.length,
    hiddenCases: Math.max(0, report.cases.length - AGENT_VALIDATION_DISPLAY_LIMITS.cases),
    limitations: limitations.slice(0, AGENT_VALIDATION_DISPLAY_LIMITS.lines),
    hiddenLimitations: Math.max(0, limitations.length - AGENT_VALIDATION_DISPLAY_LIMITS.lines)
  }
}
