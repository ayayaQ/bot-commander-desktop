import type { BCFDCommand, BCFDInteractionCommand } from '../main/types/types'
import type {
  PlaygroundExecutionOutcome,
  PlaygroundMessage,
  PlaygroundState
} from './playground/types'

export type AgentValidationJSON =
  null | string | number | boolean | AgentValidationJSON[] | { [key: string]: AgentValidationJSON }
export type AgentValidationOutcome =
  'passed' | 'failed' | 'blocked' | 'unmatched' | 'unsupported' | 'not_run'
export type AgentValidationAssertion = { path: string; equals: AgentValidationJSON }
export type AgentValidationStep = {
  kind: 'message' | 'slash' | 'button'
  senderId: string
  content?: string
  options?: Record<string, string | number | boolean>
  customId?: string
  messageId?: number
  advanceClockMs?: number
  assertions: AgentValidationAssertion[]
}
export type AgentValidationCase = {
  name: string
  state: PlaygroundState
  steps: AgentValidationStep[]
}
export type AgentValidationSuite = { cases: AgentValidationCase[] }
export type AgentValidationRequest = {
  candidateKind: 'command' | 'interaction'
  candidate: BCFDCommand | BCFDInteractionCommand
  candidateHash: string
  baseRevision: string | null
  fixtureHash: string
  /** Snapshot of the production eval mode selected when preparing validation. */
  wrapEvalInIIFE: boolean
  suite: AgentValidationSuite
}
export type AgentValidationChange = {
  path: string
  before: AgentValidationJSON | null
  after: AgentValidationJSON | null
  beforePresent: boolean
  afterPresent: boolean
}
export type AgentValidationEffects = {
  /** Bot/DM messages emitted by this step; the incoming user message is excluded. */
  messages: PlaygroundMessage[]
  deletedMessageIds: number[]
  memberChanges: AgentValidationChange[]
  botStateChanges: AgentValidationChange[]
  variableChanges: AgentValidationChange[]
  cooldownChanges: AgentValidationChange[]
}
export type AgentValidationAssertionResult = {
  path: string
  expected: AgentValidationJSON
  actual: AgentValidationJSON | null
  actualPresent: boolean
  passed: boolean
}
export type AgentValidationStepReport = {
  index: number
  kind: AgentValidationStep['kind']
  outcome: AgentValidationOutcome
  executionOutcome: PlaygroundExecutionOutcome
  expectedNegative: boolean
  matched: boolean
  executed: boolean
  reason: string
  assertions: AgentValidationAssertionResult[]
  effects: AgentValidationEffects
  trace: string[]
  errors: string[]
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
}
export type AgentValidationCoverage = {
  matched: number
  executed: number
  blocked: number
  errors: number
  unmatched: number
  unsupported: number
  notRun: number
}
export type AgentValidationReport = {
  version: 1
  candidateKind: AgentValidationRequest['candidateKind']
  candidateId: string
  candidateHash: string
  baseRevision: string | null
  fixtureHash: string
  wrapEvalInIIFE: boolean
  outcome: AgentValidationOutcome
  cases: { name: string; outcome: AgentValidationOutcome; steps: AgentValidationStepReport[] }[]
  coverage: AgentValidationCoverage
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
  limitations: string[]
}

export const AGENT_VALIDATION_LIMITS = {
  cases: 6,
  steps: 12,
  assertionsPerStep: 8,
  assertions: 64,
  fixtureChars: 524_288,
  candidateChars: 131_072,
  nodes: 20_000,
  depth: 32,
  assertionValueChars: 2048,
  reportChars: 19_999,
  stepTimeoutMs: 1000
} as const

export const AGENT_VALIDATION_LIMITATIONS = [
  'Offline simulation of one unsaved candidate only; no saved resources, Discord, network or disk access',
  'AI responses and errors are explicit fixture mocks; AI provider behavior is not tested',
  'Startup JavaScript is not loaded; initial botState and variables come only from fixtures',
  'Effects commit atomically per command/action; production partial effects and async timing may differ',
  'Publication, Discord permissions/limits, event commands, reaction and external-destination effects are not tested',
  'Only the supplied bounded cases and assertions are tested; this is not a production guarantee'
] as const

export function emptyAgentValidationEffects(): AgentValidationEffects {
  return {
    messages: [],
    deletedMessageIds: [],
    memberChanges: [],
    botStateChanges: [],
    variableChanges: [],
    cooldownChanges: []
  }
}

/** Main-safe helper: no evaluator or runnable sandbox dependencies. */
export function createNotRunAgentValidationReport(
  request: AgentValidationRequest,
  reason: string,
  flags: { timedOut?: boolean; cancelled?: boolean } = {}
): AgentValidationReport {
  const cases = request.suite.cases.map((item) => ({
    name: item.name.slice(0, 100),
    outcome: 'not_run' as const,
    steps: item.steps.map((step, index): AgentValidationStepReport => ({
      index,
      kind: step.kind,
      outcome: 'not_run',
      executionOutcome: 'not_run',
      expectedNegative: false,
      matched: false,
      executed: false,
      reason: reason.slice(0, 500),
      assertions: [],
      effects: emptyAgentValidationEffects(),
      trace: [],
      errors: [],
      timedOut: !!flags.timedOut,
      cancelled: !!flags.cancelled,
      truncated: false
    }))
  }))
  const report: AgentValidationReport = {
    version: 1,
    candidateKind: request.candidateKind,
    candidateId: request.candidate.id,
    candidateHash: request.candidateHash,
    baseRevision: request.baseRevision,
    fixtureHash: request.fixtureHash,
    wrapEvalInIIFE: request.wrapEvalInIIFE,
    outcome: 'not_run',
    cases,
    coverage: {
      matched: 0,
      executed: 0,
      blocked: 0,
      errors: 0,
      unmatched: 0,
      unsupported: 0,
      notRun: cases.reduce((count, item) => count + item.steps.length, 0)
    },
    timedOut: !!flags.timedOut,
    cancelled: !!flags.cancelled,
    truncated: false,
    limitations: [...AGENT_VALIDATION_LIMITATIONS, reason.slice(0, 500)]
  }
  if (JSON.stringify(report).length > AGENT_VALIDATION_LIMITS.reportChars) {
    // Escaped control characters can occupy six JSON characters each. Retain
    // the single top-level reason/limitations and all identity/coverage fields.
    report.truncated = true
    for (const item of report.cases)
      for (const step of item.steps) {
        step.reason = ''
        step.truncated = true
      }
  }
  if (JSON.stringify(report).length > AGENT_VALIDATION_LIMITS.reportChars)
    throw new Error('Not-run report requires bounded prepared metadata and fixtures')
  return report
}
export const createAgentValidationNotRunReport = createNotRunAgentValidationReport
