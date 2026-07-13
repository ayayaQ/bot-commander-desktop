import type { AgentRunMetrics } from '../../shared/agentTypes'

const DOCUMENTATION_TOOLS = new Set(['search_documentation', 'read_documentation'])
const DOCUMENTATION_SOFT_LIMIT = 2

export interface DocumentationPolicyState {
  calls: Map<string, string>
}

export function createDocumentationPolicyState(): DocumentationPolicyState {
  return { calls: new Map() }
}

export function isDocumentationTool(name: string): boolean {
  return DOCUMENTATION_TOOLS.has(name)
}

function normalizedKey(name: string, args: Record<string, unknown>): string {
  if (name === 'search_documentation') {
    return `${name}:${JSON.stringify({
      query: String(args.query || '')
        .trim()
        .toLowerCase(),
      category: args.category ? String(args.category).trim().toLowerCase() : undefined,
      limit: Number(args.limit) || 3
    })}`
  }
  const normalized = Object.fromEntries(
    Object.entries(args)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, typeof value === 'string' ? value.trim().toLowerCase() : value])
  )
  return `${name}:${JSON.stringify(normalized)}`
}

function addWarning(result: unknown, warning: string): unknown {
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return { ...(result as Record<string, unknown>), policyWarning: warning }
  }
  return { result, policyWarning: warning }
}

export async function executeDocumentationCall(
  state: DocumentationPolicyState,
  metrics: AgentRunMetrics,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  execute: () => Promise<unknown>
): Promise<unknown> {
  metrics.documentationCalls += 1
  const key = normalizedKey(name, args)
  const previousToolCallId = state.calls.get(key)
  if (previousToolCallId) {
    metrics.duplicateDocumentationCalls += 1
    const duplicate = {
      duplicate: true,
      previousToolCallId,
      message: 'This documentation result is already available in the current run. Reuse it.'
    }
    metrics.documentationResultChars += JSON.stringify(duplicate).length
    return duplicate
  }

  metrics.uniqueDocumentationCalls += 1
  let result = await execute()
  state.calls.set(key, callId)
  if (metrics.uniqueDocumentationCalls > DOCUMENTATION_SOFT_LIMIT) {
    result = addWarning(
      result,
      'Documentation soft budget exceeded. Reuse gathered results unless the user explicitly requested further documentation research.'
    )
  }
  metrics.documentationResultChars += (JSON.stringify(result) ?? 'undefined').length
  return result
}
