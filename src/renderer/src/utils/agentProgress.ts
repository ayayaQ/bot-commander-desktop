import type { AgentSession, AgentStreamEvent } from '../../../shared/agentTypes'

export interface AgentProgress {
  runId: string
  text: string
}

export type AgentProgressBySession = Record<string, AgentProgress>
const MAX_PROGRESS_CHARACTERS = 24_000

export function isStaleAgentRunEvent(
  event: AgentStreamEvent,
  sessions: readonly AgentSession[]
): boolean {
  const session = sessions.find((item) => item.id === event.sessionId)
  if (!event.runId || !session?.activeRunId || event.runId === session.activeRunId) return false
  // A newer session event establishes a new run; old queued IPC cannot replace it.
  return !(
    event.type === 'session' &&
    event.session?.activeRunId === event.runId &&
    event.session.status === 'running' &&
    event.session.updatedAt > session.updatedAt
  )
}

/** Transient display state. Never modify a session, durable message or provider history. */
export function reduceAgentProgress(
  progress: AgentProgressBySession,
  event: AgentStreamEvent,
  sessions: readonly AgentSession[]
): AgentProgressBySession {
  const session = sessions.find((item) => item.id === event.sessionId)
  const current = progress[event.sessionId]
  // A cancelled/finished run may still have queued progress or terminal events in IPC.
  if (isStaleAgentRunEvent(event, sessions)) {
    return progress
  }
  const incoming = event.session
  const shouldClear =
    event.type === 'progress_reset' ||
    event.type === 'done' ||
    event.type === 'error' ||
    (event.message?.role === 'assistant' && event.runId === current?.runId) ||
    (incoming &&
      (incoming.activeRunId !== current?.runId ||
        !['running', 'waiting_approval'].includes(incoming.status)))
  if (shouldClear && current) {
    const next = { ...progress }
    delete next[event.sessionId]
    return next
  }
  if (
    event.type !== 'text_delta' ||
    !event.runId ||
    !event.delta ||
    session?.status !== 'running' ||
    session.activeRunId !== event.runId
  ) {
    return progress
  }
  const text = ((current?.runId === event.runId ? current.text : '') + event.delta).slice(
    0,
    MAX_PROGRESS_CHARACTERS
  )
  return { ...progress, [event.sessionId]: { runId: event.runId, text } }
}
