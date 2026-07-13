import type { AgentToolCall } from '../../../shared/agentTypes'

const QUERY_TOOLS = new Set([
  'search_documentation',
  'search_commands',
  'search_interactions',
  'keyword_grep'
])

export function agentToolLabel(call: AgentToolCall): string {
  const targetLabel = normalizeLabelText(call.targetLabel)
  if (targetLabel) return `${call.name} '${targetLabel}'`

  if (!QUERY_TOOLS.has(call.name)) return call.name

  const query = normalizeLabelText(call.arguments.query)
  return query ? `${call.name} for '${query}'` : call.name
}

function normalizeLabelText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}
