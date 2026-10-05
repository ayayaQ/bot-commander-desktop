import type { BCFDCommand, BCFDInteractionCommand } from '../../main/types/types'
import {
  AGENT_VALIDATION_LIMITATIONS,
  AGENT_VALIDATION_LIMITS,
  createNotRunAgentValidationReport,
  type AgentValidationAssertionResult,
  type AgentValidationChange,
  type AgentValidationEffects,
  type AgentValidationJSON,
  type AgentValidationOutcome,
  type AgentValidationReport,
  type AgentValidationRequest,
  type AgentValidationStepReport
} from '../agentValidationTypes'
import {
  copyAgentValidationJSON,
  validateAgentValidationCandidate,
  validateAgentValidationSuite
} from './agentValidationFixtures'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { snapshotCommands } from './commandSnapshots'
import { snapshotInteractions } from './snapshots'
import type { ScriptSandboxFactory } from './script'
import { PlaygroundExecutionError, type PlaygroundState, type PlaygroundResult } from './types'

export { validateAgentValidationSuite } from './agentValidationFixtures'
export {
  createNotRunAgentValidationReport,
  createAgentValidationNotRunReport
} from '../agentValidationTypes'

function json(value: unknown): AgentValidationJSON {
  // Engine outputs are inert host-owned values, occasionally containing optional undefined fields.
  return JSON.parse(JSON.stringify(value)) as AgentValidationJSON
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  )
}
function changes(before: unknown, after: unknown, base = ''): AgentValidationChange[] {
  const result: AgentValidationChange[] = []
  const walk = (
    left: unknown,
    right: unknown,
    path: string,
    leftPresent: boolean,
    rightPresent: boolean
  ) => {
    if (leftPresent === rightPresent && equal(left, right)) return
    if (
      leftPresent &&
      rightPresent &&
      left &&
      right &&
      typeof left === 'object' &&
      typeof right === 'object' &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        walk(
          left[key],
          right[key],
          `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
          Object.hasOwn(left, key),
          Object.hasOwn(right, key)
        )
    } else
      result.push({
        path,
        before: leftPresent ? json(left) : null,
        after: rightPresent ? json(right) : null,
        beforePresent: leftPresent,
        afterPresent: rightPresent
      })
  }
  walk(before, after, base, true, true)
  return result
}
function effects(before: PlaygroundState, after: PlaygroundState): AgentValidationEffects {
  const ids = new Set(before.messages.map((message) => message.id))
  return {
    messages: after.messages
      .filter((message) => !ids.has(message.id) && message.kind !== 'user')
      .map((message) => json(message)) as AgentValidationEffects['messages'],
    deletedMessageIds: after.messages
      .filter(
        (message) =>
          message.deleted && !before.messages.find((old) => old.id === message.id)?.deleted
      )
      .map((message) => message.id),
    memberChanges: changes(before.members, after.members, '/members'),
    botStateChanges: changes(before.botState, after.botState, '/botState'),
    variableChanges: changes(before.variables, after.variables, '/variables'),
    cooldownChanges: changes(before.cooldowns, after.cooldowns, '/cooldowns')
  }
}
function actualAt(root: unknown, path: string): { present: boolean; value: unknown } {
  let value = root
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
      return { present: false, value: null }
    value = value[key]
  }
  return { present: value !== undefined, value: value ?? null }
}
function combined(steps: AgentValidationStepReport[]): AgentValidationOutcome {
  if (steps.some((step) => step.outcome === 'failed')) return 'failed'
  for (const outcome of ['not_run', 'unsupported', 'unmatched', 'blocked'] as const)
    if (steps.some((step) => step.outcome === outcome)) return outcome
  return steps.length ? 'passed' : 'not_run'
}

/** Pure off-main runner. Each case starts fresh; steps share only their case's explicit fake state. */
export function runAgentValidation(
  request: AgentValidationRequest,
  sandboxFactory?: ScriptSandboxFactory,
  hooks: { beforeStep?: () => void } = {}
): AgentValidationReport {
  request = copyAgentValidationJSON(
    request,
    AGENT_VALIDATION_LIMITS.fixtureChars + AGENT_VALIDATION_LIMITS.candidateChars + 4096
  ) as AgentValidationRequest
  if (!request || !['command', 'interaction'].includes(request.candidateKind))
    throw new Error('Invalid validation candidate kind')
  if (typeof request.wrapEvalInIIFE !== 'boolean')
    throw new Error('Invalid validation interpreter mode')
  for (const [name, value] of [
    ['candidateHash', request.candidateHash],
    ['fixtureHash', request.fixtureHash]
  ])
    if (typeof value !== 'string' || !value || value.length > 256)
      throw new Error(`Invalid ${name}`)
  if (
    request.baseRevision !== null &&
    (typeof request.baseRevision !== 'string' ||
      !request.baseRevision ||
      request.baseRevision.length > 256)
  )
    throw new Error('Invalid base revision')
  const suite = validateAgentValidationSuite(request.suite)
  validateAgentValidationCandidate(request.candidateKind, request.candidate)
  const safeCandidate = copyAgentValidationJSON(
    request.candidate,
    AGENT_VALIDATION_LIMITS.candidateChars
  )
  // These helpers check definitions only. Execute the exact prepared candidate
  // bound to candidateHash, without introducing defaults, IDs or replacements.
  if (request.candidateKind === 'command') snapshotCommands({ bcfdCommands: [safeCandidate] })
  else snapshotInteractions([safeCandidate])
  const candidate = safeCandidate as BCFDCommand | BCFDInteractionCommand
  const report: AgentValidationReport = {
    version: 1,
    candidateKind: request.candidateKind,
    candidateId: candidate.id,
    candidateHash: request.candidateHash,
    baseRevision: request.baseRevision,
    fixtureHash: request.fixtureHash,
    wrapEvalInIIFE: request.wrapEvalInIIFE,
    outcome: 'not_run',
    cases: [],
    coverage: {
      matched: 0,
      executed: 0,
      blocked: 0,
      errors: 0,
      unmatched: 0,
      unsupported: 0,
      notRun: 0
    },
    timedOut: false,
    cancelled: false,
    truncated: false,
    limitations: [...AGENT_VALIDATION_LIMITATIONS]
  }
  for (const fixture of suite.cases) {
    let state = structuredClone(fixture.state)
    const steps: AgentValidationStepReport[] = []
    for (const [index, step] of fixture.steps.entries()) {
      const nextClock = state.clockMs + (step.advanceClockMs ?? 0)
      if (!Number.isSafeInteger(nextClock))
        throw new Error('Fake clock exceeds the safe integer limit')
      state.clockMs = nextClock
      const before = structuredClone(state)
      hooks.beforeStep?.()
      const deadline = Date.now() + AGENT_VALIDATION_LIMITS.stepTimeoutMs
      const factory: ScriptSandboxFactory | undefined = sandboxFactory
        ? (botState, options) =>
            sandboxFactory(botState, {
              ...options,
              deadline: Math.min(options?.deadline ?? deadline, deadline)
            })
        : undefined
      let result: PlaygroundResult
      if (
        (request.candidateKind === 'command' && step.kind !== 'message') ||
        (request.candidateKind === 'interaction' && step.kind === 'message')
      ) {
        result = {
          state,
          trace: [],
          errors: [],
          resources: [
            {
              resourceId: candidate.id,
              kind: request.candidateKind,
              matched: false,
              executed: false,
              outcome: 'unsupported',
              reason: 'Step kind cannot invoke this candidate kind'
            }
          ]
        }
      } else {
        try {
          result =
            step.kind === 'message'
              ? runMessage(
                  {
                    state,
                    commands: [candidate as BCFDCommand],
                    senderId: step.senderId,
                    wrapEvalInIIFE: request.wrapEvalInIIFE,
                    content: step.content!
                  },
                  factory
                )
              : runInteraction(
                  {
                    kind: step.kind,
                    state,
                    interactions: [candidate as BCFDInteractionCommand],
                    senderId: step.senderId,
                    wrapEvalInIIFE: request.wrapEvalInIIFE,
                    commandId: candidate.id,
                    options: step.options,
                    messageId: step.messageId,
                    customId: step.customId
                  },
                  factory
                )
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'Validation execution failed'
          result = {
            state: before,
            trace: [],
            errors: [reason],
            resources: [
              {
                resourceId: candidate.id,
                kind: request.candidateKind,
                matched: false,
                executed: false,
                outcome: error instanceof PlaygroundExecutionError ? error.outcome : 'error',
                reason,
                error: reason
              }
            ]
          }
        }
      }
      state = result.state
      const resource = result.resources?.find(
        (item) => item.resourceId === candidate.id && item.kind === request.candidateKind
      )
      const executionOutcome = resource?.outcome ?? 'not_run'
      const reason =
        resource?.reason ?? (resource ? '' : 'Engine did not provide structured resource coverage')
      const observedEffects = effects(before, state)
      const observation = {
        outcome: executionOutcome,
        reason,
        state,
        effects: observedEffects,
        errors: result.errors
      }
      const assertions = step.assertions.map((assertion): AgentValidationAssertionResult => {
        const actual = actualAt(observation, assertion.path)
        return {
          path: assertion.path,
          expected: assertion.equals,
          actual: actual.present ? json(actual.value) : null,
          actualPresent: actual.present,
          passed: actual.present && equal(actual.value, assertion.equals)
        }
      })
      const expectedOutcome = step.assertions.find(
        (assertion) => assertion.path === '/outcome'
      )!.equals
      const expectedNegative =
        resource?.matched === true &&
        (executionOutcome === 'blocked' || executionOutcome === 'error') &&
        expectedOutcome === executionOutcome
      const satisfied = assertions.every((assertion) => assertion.passed)
      let outcome: AgentValidationOutcome = satisfied ? 'passed' : 'failed'
      if (['unsupported', 'unmatched', 'not_run'].includes(executionOutcome))
        outcome = executionOutcome as AgentValidationOutcome
      else if (executionOutcome === 'blocked' && !expectedNegative) outcome = 'blocked'
      else if (executionOutcome === 'error' && !expectedNegative) outcome = 'failed'
      const timedOut =
        Date.now() >= deadline ||
        result.errors.some((error) =>
          /Script execution time limit exceeded|interrupted/.test(error)
        )
      if (timedOut) outcome = 'not_run'
      steps.push({
        index,
        kind: step.kind,
        outcome,
        executionOutcome,
        expectedNegative,
        matched: !!resource?.matched,
        executed: !!resource?.executed,
        reason,
        assertions,
        effects: observedEffects,
        trace: result.trace,
        errors: result.errors,
        timedOut,
        cancelled: false,
        truncated: false
      })
      report.coverage.matched += Number(!!resource?.matched)
      report.coverage.executed += Number(!!resource?.executed)
      const coverageKey = {
        blocked: 'blocked',
        error: 'errors',
        unmatched: 'unmatched',
        unsupported: 'unsupported',
        not_run: 'notRun'
      }[executionOutcome]
      if (coverageKey) report.coverage[coverageKey]++
      report.timedOut ||= timedOut
    }
    report.cases.push({ name: fixture.name, outcome: combined(steps), steps })
  }
  const allSteps = report.cases.flatMap((item) => item.steps)
  report.outcome = combined(allSteps)
  if (report.outcome === 'passed' && !report.coverage.executed)
    report.outcome = report.coverage.blocked || report.coverage.errors ? 'blocked' : 'not_run'
  if (JSON.stringify(report).length > AGENT_VALIDATION_LIMITS.reportChars) {
    const compact = createNotRunAgentValidationReport(
      { ...request, suite },
      'Detailed report exceeded the bounded output limit; inspect smaller fixtures/assertions'
    )
    compact.coverage = report.coverage
    compact.timedOut = report.timedOut
    compact.truncated = true
    for (const [caseIndex, item] of compact.cases.entries())
      for (const [stepIndex, step] of item.steps.entries()) {
        const original = report.cases[caseIndex].steps[stepIndex]
        step.executionOutcome = original.executionOutcome
        step.matched = original.matched
        step.executed = original.executed
        step.expectedNegative = original.expectedNegative
        step.timedOut = original.timedOut
        step.truncated = true
      }
    return compact
  }
  return report
}
