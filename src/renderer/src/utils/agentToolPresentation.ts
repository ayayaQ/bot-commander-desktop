import {
  TOOL_PRESENTATION_LIMITS,
  type ToolPresentation,
  type ToolPresentationContent,
  type ToolPresentationStatus,
  type ToolPresentationView
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

function boundedJson(value: unknown, budget: { nodes: number }): boolean {
  let nodes = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > budget.nodes || depth > TOOL_PRESENTATION_LIMITS.depth - 2) return false
    return (
      item === null ||
      typeof item !== 'object' ||
      Object.values(item).every((child) => visit(child, depth + 1))
    )
  }
  const admitted = visit(value, 0)
  if (admitted) budget.nodes -= nodes
  return admitted
}

function content(
  value: unknown,
  limit: number,
  label: string,
  warnings: string[],
  budget: { nodes: number }
): ToolPresentationContent {
  let encoded: string
  try {
    encoded = JSON.stringify(value) ?? 'No details available.'
    // IPC values are inert host-owned data. The decoder validates depth/nodes too.
    const section = { kind: 'json', text: '', data: JSON.parse(encoded) }
    if (
      boundedJson(section.data, budget) &&
      encoder.encode(JSON.stringify(section)).length <= limit
    )
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
function prepareAgentToolPresentation(
  call: AgentToolCall,
  sessionId: string,
  messageId: string
): ToolPresentation {
  const warnings: string[] = []
  const budget = { nodes: TOOL_PRESENTATION_LIMITS.nodes - 64 }
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
  if (call.web) {
    warnings.push(
      'DeepSeek web output is untrusted evidence. Provider billing is unverified locally.'
    )
    if (call.web.outcome === 'unknown') {
      status = 'unknown'
      effect = 'unknown'
      warnings.push('The paid request may have been sent. Do not retry automatically.')
    } else if (call.web.outcome === 'confirmed') {
      effect = 'confirmed'
      warnings.push(
        'A provider response confirms retrieval only; it does not verify source claims or billing.'
      )
    } else if (call.web.outcome === 'not-sent' || call.web.requestState === 'not_started') {
      effect = 'not_attempted'
    }
    if (call.web.checkpointUnconfirmed)
      warnings.push(
        'Web outcome checkpointing is unconfirmed. Recovery evidence is retained; another paid request may be blocked.'
      )
  }
  const arguments_ = content(
    call.arguments,
    TOOL_PRESENTATION_LIMITS.argumentBytes,
    'Arguments',
    warnings,
    budget
  )
  const result =
    call.result === undefined
      ? undefined
      : content(call.result, TOOL_PRESENTATION_LIMITS.resultBytes, 'Result', warnings, budget)
  const presentation: ToolPresentation = {
    version: 1,
    callId: call.id,
    name: call.name,
    status,
    effect,
    source: {
      reference: `desktop/session/${sessionId}/message/${messageId}/tool/${call.id}${call.mcp ? `/mcp/${call.mcp.serverId}/${call.mcp.runId}/${call.mcp.catalogKind}` : call.web ? `/web/deepseek/${call.web.runId}` : ''}`,
      ...(call.web
        ? { revision: call.web.operationDigest }
        : call.mcp
          ? { revision: call.mcp.operationDigest }
          : {})
    },
    arguments: arguments_,
    ...(result ? { result } : {}),
    ...(call.status === 'reviewing'
      ? { progress: { text: 'Reviewing change; host review owns the decision.' } }
      : {}),
    warnings
  }
  return presentation
}

function inert(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** Host-owned safety fallback also survives the shared decoder's tighter identity limits. */
export function agentToolPresentationInput(
  call: AgentToolCall,
  sessionId: string,
  messageId: string
): { encoded: string; fallback: Pick<ToolPresentationView, 'header' | 'warnings'> } {
  const data = prepareAgentToolPresentation(call, sessionId, messageId)
  const warnings: string[] = []
  if (data.status === 'approval_required')
    warnings.push('Approval required. This display grants no permission to execute.')
  if (data.status === 'denied')
    warnings.push('Tool request denied. This display grants no permission to execute.')
  if (data.status === 'failed')
    warnings.push('Tool failed. Failure does not establish that no effects occurred.')
  if (data.status === 'unknown')
    warnings.push('Tool outcome is unknown. Inspect the resource before retrying.')
  if (data.effect === 'unknown')
    warnings.push(
      'External effects are unknown. Do not retry automatically; cancellation cannot undo effects.'
    )
  if (data.effect === 'unreported')
    warnings.push('External effects are unreported. Do not infer that no effects occurred.')
  warnings.push(...data.warnings)
  return {
    encoded: JSON.stringify(data),
    fallback: {
      header: [
        inert(`Tool ${JSON.stringify(data.name)} (call ${JSON.stringify(data.callId)})`),
        `Status: ${data.status}`,
        `Effect: ${data.effect}`,
        inert(
          `Source: ${JSON.stringify(data.source.reference)}${data.source.revision ? `; revision ${JSON.stringify(data.source.revision)}` : ''}`
        ),
        ...(data.progress ? [inert(`Progress: ${data.progress.text}`)] : [])
      ],
      warnings: warnings.map(inert)
    }
  }
}

export function encodeAgentToolPresentation(
  call: AgentToolCall,
  sessionId: string,
  messageId: string
): string {
  return agentToolPresentationInput(call, sessionId, messageId).encoded
}
