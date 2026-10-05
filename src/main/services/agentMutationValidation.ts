import crypto from 'node:crypto'
import type { BCFDCommand, BCFDInteractionCommand } from '../types/types'
import type {
  AgentValidationReport,
  AgentValidationRequest
} from '../../shared/agentValidationTypes'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import {
  copyAgentValidationJSON,
  validateAgentValidationSuite
} from '../../shared/playground/agentValidationFixtures'
import { AGENT_VALIDATION_LIMITS } from '../../shared/agentValidationTypes'
import { resourceRevision } from './resourceChangeService'
import { validatePreparedResource } from './agentValidationService'
import { getSettings } from './settingsService'
import type { PreparedMutation } from './agentTools'

export type AgentValidationBinding = {
  candidateHash: string
  baseRevision: string | null
  fixtureHash: string
  wrapEvalInIIFE: boolean
}

export function validationHash(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
}

function fixtureHash(value: unknown): string {
  try {
    return validationHash(
      copyAgentValidationJSON(value ?? { cases: [] }, AGENT_VALIDATION_LIMITS.fixtureChars)
    )
  } catch {
    // Invalid input is never evaluated/approved, and hashing must not invoke an accessor.
    return validationHash('invalid validation fixture')
  }
}

function bindingFor(prepared: PreparedMutation): AgentValidationBinding {
  return {
    candidateHash: validationHash(prepared.after),
    baseRevision: prepared.before === null ? null : resourceRevision(prepared.before),
    fixtureHash: fixtureHash(prepared.arguments.validation),
    wrapEvalInIIFE: !getSettings().useLegacyInterpreter
  }
}

export function assertAgentValidationBinding(
  prepared: PreparedMutation,
  binding: AgentValidationBinding,
  report: AgentValidationReport
): void {
  const current = bindingFor(prepared)
  if (
    current.candidateHash !== binding.candidateHash ||
    current.baseRevision !== binding.baseRevision ||
    current.fixtureHash !== binding.fixtureHash ||
    current.wrapEvalInIIFE !== binding.wrapEvalInIIFE ||
    report.candidateHash !== binding.candidateHash ||
    report.baseRevision !== binding.baseRevision ||
    report.fixtureHash !== binding.fixtureHash ||
    report.wrapEvalInIIFE !== binding.wrapEvalInIIFE ||
    report.candidateId !== prepared.target.id ||
    report.candidateKind !== prepared.target.type
  )
    throw new Error(
      'Draft validation is stale; validate the exact current candidate, fixtures and interpreter mode again'
    )
}

export function isValidatedResourceMutation(prepared: PreparedMutation): boolean {
  return prepared.target.type === 'command' || prepared.target.type === 'interaction'
}

export async function validateAgentMutation(
  prepared: PreparedMutation,
  signal?: AbortSignal
): Promise<{
  binding: AgentValidationBinding
  report: AgentValidationReport
  canCommit: boolean
  requiresApproval: boolean
}> {
  const binding = bindingFor(prepared)
  const request: AgentValidationRequest = {
    candidateKind: prepared.target.type as 'command' | 'interaction',
    candidate: structuredClone(prepared.after) as BCFDCommand | BCFDInteractionCommand,
    ...binding,
    suite: { cases: [] }
  }
  // Supplied fixtures must be valid even for an unsupported dispatch kind.
  // Absence of fixtures is permitted only for genuinely unsupported event commands.
  if (prepared.arguments.validation !== undefined) {
    try {
      request.suite = validateAgentValidationSuite(prepared.arguments.validation)
      const wrongKind = request.suite.cases.some((item) =>
        item.steps.some((step) =>
          request.candidateKind === 'command' ? step.kind !== 'message' : step.kind === 'message'
        )
      )
      if (wrongKind) throw new Error('Validation step kind cannot invoke this candidate kind')
    } catch (error) {
      return {
        binding,
        report: createNotRunAgentValidationReport(
          { ...request, suite: { cases: [] } },
          error instanceof Error ? error.message : 'Invalid fake fixtures'
        ),
        canCommit: false,
        requiresApproval: false
      }
    }
  }
  if (request.candidateKind === 'command' && (request.candidate as BCFDCommand).type !== 0) {
    const report = createNotRunAgentValidationReport(
      request,
      'Event-command dispatch is unsupported by the offline Playground'
    )
    report.outcome = 'unsupported'
    report.coverage.unsupported = 1
    return { binding, report, canCommit: true, requiresApproval: true }
  }
  if (prepared.arguments.validation === undefined) {
    return {
      binding,
      report: createNotRunAgentValidationReport(
        request,
        'No explicit fake fixtures/assertions supplied; read_validation_fixture and validate this draft before saving'
      ),
      canCommit: false,
      requiresApproval: false
    }
  }
  if (validationHash(request.suite) !== binding.fixtureHash)
    throw new Error('Validation fixtures changed during normalization')
  const report = await validatePreparedResource(request, signal)
  assertAgentValidationBinding(prepared, binding, report)
  const steps = report.cases.flatMap((item) => item.steps)
  const passed =
    report.outcome === 'passed' &&
    report.coverage.executed > 0 &&
    !report.timedOut &&
    !report.cancelled &&
    !report.truncated &&
    steps.length > 0 &&
    report.cases.every((item) => item.outcome === 'passed') &&
    steps.every(
      (step) =>
        step.outcome === 'passed' &&
        step.matched &&
        (step.executionOutcome === 'executed' || step.expectedNegative) &&
        step.assertions.length >= 2 &&
        step.assertions.every((item) => item.passed && item.actualPresent)
    )
  // Only a structured unsupported feature after matching this candidate can be
  // reviewed without a pass. Wrong-kind fixtures, unmatched inputs, malformed
  // requests and failing supported assertions cannot become an approval bypass.
  const unsupported =
    report.outcome === 'unsupported' &&
    !report.timedOut &&
    !report.cancelled &&
    !report.truncated &&
    steps.length > 0 &&
    steps.some((step) => step.executionOutcome === 'unsupported' && step.matched) &&
    steps.every((step) =>
      step.executionOutcome === 'unsupported'
        ? step.matched
        : step.outcome === 'passed' &&
          step.assertions.length >= 2 &&
          step.assertions.every((item) => item.passed)
    )
  return { binding, report, canCommit: passed || unsupported, requiresApproval: unsupported }
}
