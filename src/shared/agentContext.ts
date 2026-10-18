import type { ContextUsage } from '@ayayaq/vivi'
import type { AgentProvider } from './agentTypes'

/** Display snapshot only. Never a token bill, approval, or replacement for raw history. */
export interface AgentContextStatus {
  provider: AgentProvider
  model: string
  usage?: ContextUsage
  state: 'ready' | 'compacting' | 'error'
  message?: string
}

function validCount(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function validUsage(value: ContextUsage | undefined): value is ContextUsage {
  return (
    !!value &&
    validCount(value.inputTokens) &&
    typeof value.estimated === 'boolean' &&
    validCount(value.outputReserveTokens) &&
    (value.contextWindow === undefined || validCount(value.contextWindow, 1))
  )
}

export function agentContextLabel(
  snapshot: AgentContextStatus | undefined,
  provider: AgentProvider,
  model: string,
  contextWindow?: number
): string {
  const usage =
    snapshot?.provider === provider && snapshot.model === model && validUsage(snapshot.usage)
      ? snapshot.usage
      : undefined
  // Current capability facts are authoritative, including unknown after cache expiry/restart.
  const limit = validCount(contextWindow, 1) ? contextWindow : undefined
  const count = usage
    ? `${usage.estimated ? '~' : ''}${usage.inputTokens.toLocaleString()}`
    : 'unknown'
  return `Context ${count} / ${limit?.toLocaleString() ?? 'unknown'}`
}

export function agentContextTooltip(
  snapshot: AgentContextStatus | undefined,
  reported: { execution?: number; summary?: number; summaryIncomplete?: boolean }
): string {
  const reserve = validUsage(snapshot?.usage)
    ? snapshot.usage.outputReserveTokens.toLocaleString()
    : 'unknown'
  const execution = validCount(reported.execution)
    ? reported.execution.toLocaleString()
    : 'unreported'
  const summary = validCount(reported.summary) ? reported.summary.toLocaleString() : 'unreported'
  return `Latest prepared request input, including guidance and tools. Output reserve: ${reserve} tokens. Execution reported usage: ${execution} tokens. Summary reported usage: ${summary}${reported.summaryIncomplete ? ' (incomplete)' : ''}.`
}
