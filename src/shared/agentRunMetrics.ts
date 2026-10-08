import type { AgentResult, Usage } from '@ayayaq/vivi'
import type { AgentRunMetrics, AgentRunToolMetric, AgentToolCall } from './agentTypes'

const cacheKeys = ['cachedInputTokens', 'cacheWriteInputTokens'] as const
const runStatuses = new Set(['running', 'completed', 'error', 'cancelled', 'interrupted'])
const toolStatuses = new Set([
  'running',
  'reviewing',
  'waiting_approval',
  'approved',
  'rejected',
  'completed',
  'error',
  'unknown'
])
const lintTools = new Set(['lint_js', 'lint_bcfd', 'lint_command', 'lint_interaction'])
const mutationLintTools = new Set([
  'create_command',
  'edit_command',
  'create_interaction',
  'edit_interaction',
  'edit_startup_js'
])

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function validTool(value: unknown): value is AgentRunToolMetric {
  if (!value || typeof value !== 'object') return false
  const tool = value as AgentRunToolMetric
  return (
    typeof tool.id === 'string' &&
    !!tool.id.trim() &&
    typeof tool.name === 'string' &&
    !!tool.name.trim() &&
    typeof tool.status === 'string' &&
    toolStatuses.has(tool.status)
  )
}

function validTools(value: unknown): value is AgentRunToolMetric[] {
  if (!Array.isArray(value) || !value.every(validTool)) return false
  return new Set(value.map((tool) => tool.id)).size === value.length
}

export function createAgentRunMetrics(runId: string, timestamp: string): AgentRunMetrics {
  return {
    runId,
    providerRounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    documentationCalls: 0,
    uniqueDocumentationCalls: 0,
    duplicateDocumentationCalls: 0,
    documentationResultChars: 0,
    startedAt: timestamp,
    checkpointAt: timestamp,
    status: 'running',
    usageReconciled: false,
    tools: []
  }
}

/** Interim events cover fully completed rounds only, not a round still executing tools. */
export function recordAgentRound(
  metrics: AgentRunMetrics,
  round: number,
  usage?: Usage
): AgentRunMetrics {
  if (metrics.usageReconciled || round !== metrics.providerRounds + 1) return metrics
  const next = {
    ...metrics,
    providerRounds: round,
    inputTokens: metrics.inputTokens + (usage?.inputTokens ?? 0),
    outputTokens: metrics.outputTokens + (usage?.outputTokens ?? 0),
    totalTokens: metrics.totalTokens + (usage?.totalTokens ?? 0)
  }
  for (const key of cacheKeys) {
    const count = usage?.[key]
    // Match vivi: one unreported committed round makes the entire cache aggregate unknown.
    if (count !== undefined && (round === 1 || metrics[key] !== undefined))
      next[key] = (metrics[key] ?? 0) + count
    else delete next[key]
  }
  return next
}

/** Replace, never add: core includes committed rounds whose completion hook did not run. */
export function reconcileAgentRunUsage(
  metrics: AgentRunMetrics,
  result: Pick<AgentResult, 'rounds' | 'usage'>
): AgentRunMetrics {
  const next = {
    ...metrics,
    providerRounds: result.rounds,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    totalTokens: result.usage.totalTokens,
    usageReconciled: true
  }
  for (const key of cacheKeys) {
    if (result.usage[key] !== undefined) next[key] = result.usage[key]
    else delete next[key]
  }
  return next
}

function lintEvidence(call: AgentToolCall): AgentRunToolMetric['lint'] {
  if (call.status !== 'completed') return undefined
  const diagnostics = lintTools.has(call.name)
    ? call.result
    : mutationLintTools.has(call.name) && call.result && typeof call.result === 'object'
      ? (call.result as { diagnostics?: unknown }).diagnostics
      : undefined
  if (
    !Array.isArray(diagnostics) ||
    !diagnostics.every(
      (item) =>
        item &&
        typeof item === 'object' &&
        ['error', 'warning'].includes(item.severity) &&
        typeof item.message === 'string'
    )
  )
    return undefined
  return {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length
  }
}

export function recordAgentRunTool(metrics: AgentRunMetrics, call: AgentToolCall): AgentRunMetrics {
  const lint = lintEvidence(call)
  const tool: AgentRunToolMetric = {
    id: call.id,
    name: call.name,
    status: call.status,
    ...(lint ? { lint } : {})
  }
  const tools = validTools(metrics.tools) ? metrics.tools : []
  return {
    ...metrics,
    tools: tools.some((item) => item.id === call.id)
      ? tools.map((item) => (item.id === call.id ? tool : item))
      : [...tools, tool]
  }
}

export function finishAgentRunMetrics(
  metrics: AgentRunMetrics,
  status: 'completed' | 'error' | 'cancelled',
  timestamp: string
): AgentRunMetrics {
  if (metrics.status === status && metrics.finishedAt !== undefined) return metrics
  return {
    ...metrics,
    status,
    checkpointAt: timestamp,
    finishedAt: timestamp,
    tools: settleUnfinishedTools(metrics.tools)
  }
}

function settleUnfinishedTools(tools: AgentRunToolMetric[] | undefined) {
  // Optional analytics are not the recovery authority. Preserve damaged metadata safely.
  if (!Array.isArray(tools)) return tools
  return tools.map((tool) =>
    validTool(tool) &&
    ['running', 'reviewing', 'waiting_approval', 'approved'].includes(tool.status)
      ? { ...tool, status: 'unknown' as const }
      : tool
  )
}

/** Closure time and in-flight provider usage are unknown. Keep the last durable observation. */
export function interruptAgentRunMetrics(metrics: AgentRunMetrics): AgentRunMetrics {
  const next = {
    ...metrics,
    status: 'interrupted' as const,
    tools: settleUnfinishedTools(metrics.tools)
  }
  delete next.finishedAt
  return next
}

export function formatAgentTokenCount(value: number | undefined): string {
  return validCount(value) ? value.toLocaleString() : 'Unavailable'
}

export function agentRunOutcome(metrics: AgentRunMetrics): string {
  return typeof metrics.status === 'string' && runStatuses.has(metrics.status)
    ? metrics.status
    : 'Unavailable'
}

export function agentRunElapsed(metrics: AgentRunMetrics): string {
  const startedAt = metrics.startedAt
  const endedAt = metrics.finishedAt ?? metrics.checkpointAt
  if (typeof startedAt !== 'string' || typeof endedAt !== 'string') return 'Unavailable'
  const start = Date.parse(startedAt)
  const end = Date.parse(endedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 'Unavailable'
  const seconds = Math.floor((end - start) / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function agentRunToolSummary(metrics: AgentRunMetrics): string {
  if (!validTools(metrics.tools)) return 'Unavailable'
  if (metrics.tools.length === 0) return 'None recorded'
  const counts = new Map<string, number>()
  for (const tool of metrics.tools) counts.set(tool.status, (counts.get(tool.status) ?? 0) + 1)
  const details = [...counts].map(([status, count]) => `${count} ${status.replace('_', ' ')}`)
  return `${metrics.tools.length} attempted (${details.join(', ')})`
}

export function agentRunValidationSummary(metrics: AgentRunMetrics): string {
  if (metrics.tools === undefined) return 'Unavailable (older run)'
  if (!validTools(metrics.tools)) return 'Unavailable (invalid recorded evidence)'
  const lint = metrics.tools.flatMap((tool) => (tool.lint !== undefined ? [tool.lint] : []))
  if (lint.some((item) => !item || !validCount(item.errors) || !validCount(item.warnings)))
    return 'Unavailable (invalid recorded evidence)'
  if (lint.length === 0) return 'No validation evidence recorded'
  const errors = lint.reduce((sum, item) => sum + item.errors, 0)
  const warnings = lint.reduce((sum, item) => sum + item.warnings, 0)
  if (!validCount(errors) || !validCount(warnings)) return 'Unavailable (invalid recorded evidence)'
  return `Lint only: ${lint.length} checks, ${errors} errors, ${warnings} warnings. No runtime validation recorded.`
}
