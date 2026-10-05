import type { AgentLintDiagnostic } from '../../shared/agentTypes'

export const MAX_AGENT_TOOL_RESULT_CHARS = 24_000

/** Only known bounded fields can enter a diagnostic returned to the model. */
export function clipAgentLintDiagnostics(items: AgentLintDiagnostic[]): AgentLintDiagnostic[] {
  return items.slice(0, 8).map((item) => ({
    severity: item.severity,
    message: item.message.slice(0, 256),
    ...(item.path ? { path: item.path.slice(0, 128) } : {}),
    ...(item.name ? { name: item.name.slice(0, 64) } : {}),
    ...(Number.isFinite(item.position) ? { position: item.position } : {}),
    ...(Number.isFinite(item.length) ? { length: item.length } : {})
  }))
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
function text(value: unknown, limit: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, limit) : undefined
}
function summary(value: unknown): Record<string, unknown> {
  const report = record(value)
  return {
    outcome: text(report.outcome, 30),
    candidateKind: text(report.candidateKind, 20),
    candidateId: text(report.candidateId, 100),
    candidateHash: text(report.candidateHash, 64),
    baseRevision: report.baseRevision === null ? null : text(report.baseRevision, 64),
    fixtureHash: text(report.fixtureHash, 64),
    ...(typeof report.wrapEvalInIIFE === 'boolean'
      ? { wrapEvalInIIFE: report.wrapEvalInIIFE }
      : {}),
    timedOut: report.timedOut === true,
    cancelled: report.cancelled === true,
    truncated: true,
    message:
      'Validation details exceeded the model-result budget; the full bounded report remains in the proposed-change panel'
  }
}

/** Return valid bounded JSON, retaining repair/decision fields instead of slicing JSON mid-value. */
export function boundAgentToolResult(result: unknown): unknown {
  const serialized = JSON.stringify(result) ?? 'null'
  if (serialized.length <= MAX_AGENT_TOOL_RESULT_CHARS) return result
  const source = record(result)
  const bounded = {
    success: source.success === true,
    ...(typeof source.saved === 'boolean' ? { saved: source.saved } : {}),
    ...(typeof source.denied === 'boolean' ? { denied: source.denied } : {}),
    ...(Number.isSafeInteger(source.attemptsRemaining)
      ? { attemptsRemaining: source.attemptsRemaining }
      : {}),
    message:
      text(source.message, 500) ??
      'Tool result exceeded the bounded output limit; inspect smaller resources or fixtures',
    ...(typeof source.error === 'string' ? { error: text(source.error, 500) } : {}),
    ...(source.validation ? { validation: source.validation } : {}),
    truncated: true
  }
  if (JSON.stringify(bounded).length <= MAX_AGENT_TOOL_RESULT_CHARS) return bounded
  const compact = {
    ...bounded,
    ...(source.validation ? { validation: summary(source.validation) } : {})
  }
  return compact
}

export function stringifyAgentToolResult(result: unknown): string {
  return JSON.stringify(boundAgentToolResult(result)) ?? 'null'
}
