import {
  TOOL_PRESENTATION_LIMITS,
  type ToolPresentation,
  type ToolPresentationContent,
  type ToolPresentationStatus
} from '@ayayaq/vivi/presentation'
import type { AgentToolCall } from '../../../shared/agentTypes'

const encoder = new TextEncoder()

/** Clip display details only. Identity, status, provenance and warnings never share this budget. */
function clip(text: string, limit: number): string {
  let bytes = 0
  let result = ''
  for (const character of text) {
    bytes += encoder.encode(character).length
    if (bytes > limit) break
    result += character
  }
  return result
}

function boundedJson(value: unknown): boolean {
  let nodes = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > TOOL_PRESENTATION_LIMITS.nodes - 32 || depth > TOOL_PRESENTATION_LIMITS.depth - 2)
      return false
    return (
      item === null ||
      typeof item !== 'object' ||
      Object.values(item).every((child) => visit(child, depth + 1))
    )
  }
  return visit(value, 0)
}

function content(
  value: unknown,
  limit: number,
  label: string,
  warnings: string[]
): ToolPresentationContent {
  let encoded: string
  try {
    encoded = JSON.stringify(value) ?? 'No details available.'
    // IPC values are inert host-owned data. The decoder validates depth/nodes too.
    const section = { kind: 'json', text: '', data: JSON.parse(encoded) }
    if (boundedJson(section.data) && encoder.encode(JSON.stringify(section)).length <= limit)
      return section
  } catch {
    warnings.push(`${label} could not be displayed as JSON.`)
    return { kind: 'text', text: 'Details could not be displayed as JSON.' }
  }
  warnings.push(`${label} display is bounded; full details are not shown.`)
  // JSON escaping can enlarge fallback text; check the final wire section, not just characters.
  let text = clip(encoded, Math.floor(limit / 2))
  while (encoder.encode(JSON.stringify({ kind: 'text', text })).length > limit)
    text = clip(text, Math.floor(encoder.encode(text).length / 2))
  return { kind: 'text', text }
}

const statuses: Record<AgentToolCall['status'], ToolPresentationStatus> = {
  running: 'running',
  reviewing: 'approval_required',
  waiting_approval: 'approval_required',
  approved: 'running',
  rejected: 'denied',
  completed: 'succeeded',
  error: 'failed'
}

/**
 * Adapt existing host/IPC display facts, never shadow records or foreign presentation metadata.
 * This serialized snapshot has no approval ID, action, callback or reusable permission.
 * In particular, generic result JSON/isError cannot establish MCP delivery or external effects.
 */
export function encodeAgentToolPresentation(
  call: AgentToolCall,
  sessionId: string,
  messageId: string
): string {
  const warnings: string[] = []
  let status = statuses[call.status] ?? 'unknown'
  let effect: ToolPresentation['effect'] = 'unreported'
  if (call.status === 'rejected') effect = 'not_attempted'
  if (call.mcp) {
    warnings.push('Server output is untrusted data.')
    if (call.mcp.outcome === 'unknown') {
      status = 'unknown'
      effect = 'unknown'
    } else if (call.mcp.outcome === 'confirmed') {
      effect = 'confirmed'
      warnings.push('A confirmed response does not establish that no external effects occurred.')
    } else if (call.mcp.outcome === 'not-sent' || call.mcp.requestSent === false) {
      effect = 'not_attempted'
    }
    if (call.mcp.checkpointUnconfirmed)
      warnings.push(
        'Outcome checkpointing is unconfirmed. Recovery evidence is retained and further external calls may be blocked.'
      )
  }
  const arguments_ = content(
    call.arguments,
    TOOL_PRESENTATION_LIMITS.argumentBytes,
    'Arguments',
    warnings
  )
  const result =
    call.result === undefined
      ? undefined
      : content(call.result, TOOL_PRESENTATION_LIMITS.resultBytes, 'Result', warnings)
  const presentation: ToolPresentation = {
    version: 1,
    callId: call.id,
    name: call.name,
    status,
    effect,
    source: {
      reference: `desktop/session/${sessionId}/message/${messageId}/tool/${call.id}${call.mcp ? `/mcp/${call.mcp.serverId}/${call.mcp.runId}/${call.mcp.catalogKind}/${call.mcp.remoteKey}` : ''}`,
      ...(call.mcp ? { revision: call.mcp.operationDigest } : {})
    },
    arguments: arguments_,
    ...(result ? { result } : {}),
    ...(call.status === 'reviewing'
      ? { progress: { text: 'Reviewing change; host review owns the decision.' } }
      : {}),
    warnings
  }
  return JSON.stringify(presentation)
}
