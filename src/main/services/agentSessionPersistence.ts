import type { AgentSessionsData } from '../../shared/agentTypes'

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function validAgentDisplayHistory(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  const messageIds = new Set<string>()
  for (const message of value) {
    if (
      !record(message) ||
      typeof message.id !== 'string' ||
      !message.id.trim() ||
      messageIds.has(message.id) ||
      typeof message.content !== 'string' ||
      typeof message.timestamp !== 'string' ||
      typeof message.role !== 'string' ||
      !['user', 'assistant', 'system', 'tool'].includes(message.role)
    )
      return false
    messageIds.add(message.id)
    if (message.toolCalls === undefined) continue
    if (!Array.isArray(message.toolCalls)) return false
    const callIds = new Set<string>()
    for (const call of message.toolCalls) {
      if (
        !record(call) ||
        typeof call.id !== 'string' ||
        !call.id.trim() ||
        callIds.has(call.id) ||
        typeof call.name !== 'string' ||
        !call.name.trim() ||
        !record(call.arguments) ||
        typeof call.createdAt !== 'string' ||
        typeof call.status !== 'string' ||
        ![
          'running',
          'reviewing',
          'waiting_approval',
          'approved',
          'rejected',
          'completed',
          'error'
        ].includes(call.status)
      )
        return false
      callIds.add(call.id)
    }
  }
  return true
}

/** Validate the store envelope; individual display/canonical histories are quarantined later. */
export function decodeAgentSessions(raw: string): AgentSessionsData {
  const value: unknown = JSON.parse(raw)
  if (!record(value) || !Array.isArray(value.sessions)) {
    throw new Error('Agent session store must contain a sessions array')
  }
  if (value.activeSessionId != null && typeof value.activeSessionId !== 'string') {
    throw new Error('Agent active session ID must be text or null')
  }
  const ids = new Set<string>()
  for (const session of value.sessions) {
    if (
      !record(session) ||
      typeof session.id !== 'string' ||
      !session.id.trim() ||
      ids.has(session.id) ||
      typeof session.title !== 'string' ||
      typeof session.model !== 'string' ||
      typeof session.mode !== 'string' ||
      !['manual', 'auto', 'planning'].includes(session.mode) ||
      typeof session.reasoningEffort !== 'string' ||
      !['none', 'disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(
        session.reasoningEffort
      ) ||
      typeof session.status !== 'string' ||
      ![
        'idle',
        'running',
        'waiting_approval',
        'completed',
        'error',
        'cancelled',
        'interrupted'
      ].includes(session.status) ||
      typeof session.createdAt !== 'string' ||
      typeof session.updatedAt !== 'string' ||
      (session.tokenCount !== undefined &&
        (typeof session.tokenCount !== 'number' ||
          !Number.isFinite(session.tokenCount) ||
          session.tokenCount < 0)) ||
      (session.planReady !== undefined && typeof session.planReady !== 'boolean')
    ) {
      throw new Error('Agent session store contains an invalid session record')
    }
    ids.add(session.id)
  }
  return value as unknown as AgentSessionsData
}
