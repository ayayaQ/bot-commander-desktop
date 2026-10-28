import type { AgentSessionsData } from '../../shared/agentTypes'
import { expandAgentMcpTemplate } from './agentMcpTemplates'

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
      if (call.web !== undefined) {
        const web = call.web
        if (
          !record(web) ||
          Object.keys(web).some(
            (key) =>
              ![
                'runId',
                'operationDigest',
                'provider',
                'requestState',
                'outcome',
                'intentAt',
                'settledAt',
                'checkpointUnconfirmed'
              ].includes(key)
          ) ||
          typeof web.runId !== 'string' ||
          !web.runId ||
          web.runId.length > 256 ||
          typeof web.operationDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(web.operationDigest) ||
          web.provider !== 'deepseek' ||
          !['not_started', 'unknown', 'response_received'].includes(web.requestState as string) ||
          !['pending', 'not-sent', 'confirmed', 'unknown'].includes(web.outcome as string) ||
          (web.checkpointUnconfirmed !== undefined &&
            typeof web.checkpointUnconfirmed !== 'boolean') ||
          ['intentAt', 'settledAt'].some(
            (key) =>
              web[key] !== undefined &&
              (typeof web[key] !== 'string' ||
                !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(web[key] as string))
          )
        )
          return false
      }
      if (call.mcp !== undefined) {
        const mcp = call.mcp
        if (
          !record(mcp) ||
          typeof mcp.runId !== 'string' ||
          !mcp.runId.trim() ||
          mcp.runId.length > 1024 ||
          typeof mcp.operationDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(mcp.operationDigest) ||
          typeof mcp.serverId !== 'string' ||
          !/^[a-z][a-z0-9_-]{0,15}$/.test(mcp.serverId) ||
          !['tools', 'resources', 'resourceTemplates'].includes(mcp.catalogKind as string) ||
          typeof mcp.remoteKey !== 'string' ||
          !mcp.remoteKey ||
          mcp.remoteKey.length > 4096 ||
          !['pending', 'not-sent', 'confirmed', 'unknown'].includes(mcp.outcome as string) ||
          (mcp.disclosure !== undefined &&
            (typeof mcp.disclosure !== 'string' || mcp.disclosure.length > 96 * 1024)) ||
          (mcp.requestSent !== undefined && typeof mcp.requestSent !== 'boolean') ||
          (mcp.checkpointUnconfirmed !== undefined &&
            typeof mcp.checkpointUnconfirmed !== 'boolean')
        )
          return false
        if (mcp.catalogKind === 'resourceTemplates') {
          try {
            if (
              call.name !== 'read_mcp_resource_template' ||
              Object.keys(call.arguments).sort().join(',') !== 'serverId,uriTemplate,variables' ||
              call.arguments.serverId !== mcp.serverId ||
              call.arguments.uriTemplate !== mcp.remoteKey ||
              mcp.resourceUri !==
                expandAgentMcpTemplate(
                  mcp.remoteKey as string,
                  call.arguments.variables as Readonly<Record<string, string>>
                )
            )
              return false
          } catch {
            return false
          }
        } else if (mcp.resourceUri !== undefined) return false
      }
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
    if (
      session.pendingInputs !== undefined &&
      (!Array.isArray(session.pendingInputs) ||
        session.pendingInputs.length > 32 ||
        session.pendingInputs.some(
          (entry) =>
            !record(entry) ||
            typeof entry.id !== 'string' ||
            !entry.id ||
            typeof entry.content !== 'string' ||
            !entry.content.trim() ||
            entry.content.length > 64 * 1024
        ) ||
        new Set(session.pendingInputs.map((entry) => entry.id)).size !==
          session.pendingInputs.length)
    )
      throw new Error('Agent session store contains invalid pending inputs')
    ids.add(session.id)
  }
  return value as unknown as AgentSessionsData
}
