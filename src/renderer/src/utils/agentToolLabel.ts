import type { AgentToolCall } from '../../../shared/agentTypes'

const QUERY_TOOLS = new Set([
  'search_documentation',
  'search_commands',
  'search_interactions',
  'keyword_grep'
])

export function agentToolLabel(call: AgentToolCall): string {
  if (!QUERY_TOOLS.has(call.name) || typeof call.arguments.query !== 'string') return call.name

  const query = call.arguments.query.replace(/\s+/g, ' ').trim()
  return query ? `${call.name} for '${query}'` : call.name
}
