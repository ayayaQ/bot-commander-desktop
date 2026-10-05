import { describe, expect, it } from 'vitest'
import type { AgentSession, AgentStreamEvent } from '../../../shared/agentTypes'
import { isStaleAgentRunEvent, reduceAgentProgress } from './agentProgress'

const session: AgentSession = {
  id: 'session_1',
  title: 'Inspect',
  mode: 'manual',
  model: 'gpt-test',
  reasoningEffort: 'none',
  status: 'running',
  activeRunId: 'run_1',
  messages: [],
  history: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:01Z',
  planReady: false,
  tokenCount: 0
}
const delta: AgentStreamEvent = {
  sessionId: session.id,
  runId: 'run_1',
  type: 'text_delta',
  delta: 'Inspecting '
}
const progress = { [session.id]: { runId: 'run_1', text: 'Inspecting ' } }

describe('display-only agent progress', () => {
  it('accumulates active run text without changing durable messages or history', () => {
    const original = structuredClone(session)
    const first = reduceAgentProgress({}, delta, [session])
    expect(first).toEqual(progress)
    expect(reduceAgentProgress(first, { ...delta, delta: 'state' }, [session])).toEqual({
      [session.id]: { runId: 'run_1', text: 'Inspecting state' }
    })
    expect(session).toEqual(original)
  })

  it('ignores stale, unscoped, unknown-session and post-terminal deltas', () => {
    for (const event of [
      { ...delta, runId: 'older_run' },
      { ...delta, runId: undefined },
      { ...delta, sessionId: 'missing' }
    ]) {
      expect(reduceAgentProgress(progress, event, [session])).toBe(progress)
    }
    for (const status of ['cancelled', 'completed', 'error', 'interrupted'] as const) {
      expect(reduceAgentProgress({}, delta, [{ ...session, status }])).toEqual({})
    }
  })

  it.each(['progress_reset', 'done', 'error'] as const)(
    'clears accepted or terminal %s progress',
    (type) => {
      expect(
        reduceAgentProgress(progress, { ...delta, type, delta: undefined }, [session])
      ).toEqual({})
    }
  )

  it('clears progress on an accepted assistant message and the next run', () => {
    expect(
      reduceAgentProgress(
        progress,
        {
          ...delta,
          type: 'message',
          message: { id: 'answer', timestamp: '', role: 'assistant', content: 'Done' }
        },
        [session]
      )
    ).toEqual({})
    expect(
      reduceAgentProgress(
        progress,
        {
          ...delta,
          type: 'session',
          runId: 'run_2',
          session: { ...session, activeRunId: 'run_2', updatedAt: '2026-01-01T00:00:02Z' }
        },
        [session]
      )
    ).toEqual({})
  })

  it('guards stale resets and terminal/session events from an older run', () => {
    const newer = { ...session, activeRunId: 'run_2', updatedAt: '2026-01-01T00:00:02Z' }
    const current = { [session.id]: { runId: 'run_2', text: 'New response' } }
    for (const type of ['progress_reset', 'done', 'error', 'session'] as const) {
      const event = { ...delta, type, session }
      expect(isStaleAgentRunEvent(event, [newer])).toBe(true)
      expect(reduceAgentProgress(current, event, [newer])).toBe(current)
    }
  })

  it('bounds transient text and keeps simultaneous sessions independent', () => {
    const other = { ...session, id: 'session_2' }
    const original = { ...progress, [other.id]: { runId: 'run_1', text: 'Other' } }
    const next = reduceAgentProgress(original, { ...delta, delta: 'x'.repeat(50_000) }, [
      session,
      other
    ])
    expect(next[session.id].text).toHaveLength(24_000)
    expect(next[other.id]).toBe(original[other.id])
    expect(reduceAgentProgress(next, { ...delta, type: 'done' }, [session, other])).toEqual({
      [other.id]: original[other.id]
    })
  })
})
