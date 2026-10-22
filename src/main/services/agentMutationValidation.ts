import { RUNTIME_VERSION } from '../../shared/runtime/version'
import { commandEvents } from '../../shared/runtime/dispatch'
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

const evidence = new WeakMap<
  PreparedMutation,
  { binding: AgentValidationBinding; report: AgentValidationReport }
>()

/** Only evidence produced by this process may authorize a resource commit. */
export function validatedCommitGuard(
  prepared: PreparedMutation
): (snapshot: PreparedMutation) => void {
  if (!isValidatedResourceMutation(prepared)) return () => {}
  const validated = evidence.get(prepared)
  if (!validated)
    throw new Error('Passing playground validation is required before saving this draft')
  return (snapshot) => assertAgentValidationBinding(snapshot, validated.binding, validated.report)
}

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
    report.runtimeVersion !== RUNTIME_VERSION ||
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
  return (
    ['create_command', 'edit_command', 'create_interaction', 'edit_interaction'].includes(
      prepared.name
    ) ||
    prepared.target.type === 'command' ||
    prepared.target.type === 'interaction'
  )
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
  evidence.delete(prepared)
  const binding = bindingFor(prepared)
  const request: AgentValidationRequest = {
    candidateKind: prepared.target.type as 'command' | 'interaction',
    candidate: structuredClone(prepared.after) as BCFDCommand | BCFDInteractionCommand,
    ...binding,
    suite: { cases: [] }
  }
  // Every command and interaction write requires explicit fixtures.
  if (prepared.arguments.validation !== undefined) {
    try {
      request.suite = validateAgentValidationSuite(prepared.arguments.validation)
      const wrongKind = request.suite.cases.some((item) =>
        item.steps.some((step) =>
          request.candidateKind === 'command'
            ? !commandEvents.includes(step.kind as (typeof commandEvents)[number])
            : commandEvents.includes(step.kind as (typeof commandEvents)[number])
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
  if (passed) evidence.set(prepared, structuredClone({ binding, report }))
  return { binding, report, canCommit: passed, requiresApproval: false }
}
