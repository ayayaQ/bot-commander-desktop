import { describe, expect, it } from 'vitest'
import { createAgentRunMetrics } from '../../shared/agentRunMetrics'
import { decodeAgentSessions, validAgentDisplayHistory } from './agentSessionPersistence'

const session = {
  id: 'fixture',
  title: 'Fixture',
  model: 'fixture-model',
  mode: 'planning',
  reasoningEffort: 'none',
  status: 'idle',
  createdAt: '',
  updatedAt: '',
  messages: [],
  history: [],
  planReady: false,
  tokenCount: 0
}

describe('agent session persistence validation', () => {
  it('loads legacy metrics and optional cache values without replacing absence with zero', () => {
    const {
      startedAt: _start,
      checkpointAt: _checkpoint,
      tools: _tools,
      status: _status,
      usageReconciled: _reconciled,
      ...legacy
    } = createAgentRunMetrics('legacy-run', '2026-10-05T01:00:00Z')
    const result = decodeAgentSessions(
      JSON.stringify({
        sessions: [
          { ...session, id: 'legacy', lastRunMetrics: legacy },
          {
            ...session,
            id: 'known',
            lastRunMetrics: { ...legacy, cachedInputTokens: 0, cacheWriteInputTokens: 12 }
          },
          { ...session, id: 'absent' }
        ]
      })
    )
    expect(result.sessions[0].lastRunMetrics).toEqual(legacy)
    expect(result.sessions[0].lastRunMetrics).not.toHaveProperty('cachedInputTokens')
    expect(result.sessions[0].lastRunMetrics).not.toHaveProperty('cacheWriteInputTokens')
    expect(result.sessions[1].lastRunMetrics).toMatchObject({
      cachedInputTokens: 0,
      cacheWriteInputTokens: 12
    })
    expect(result.sessions[2].lastRunMetrics).toBeUndefined()
    expect(decodeAgentSessions(JSON.stringify(result))).toEqual(result)
  })

  it('rejects duplicate renderer keys but allows legacy call IDs repeated across messages', () => {
    const call = {
      id: 'legacy-call',
      name: 'edit_command',
      arguments: {},
      status: 'completed',
      createdAt: ''
    }
    const message = {
      id: 'first',
      role: 'tool',
      content: 'Result',
      timestamp: '',
      toolCalls: [call]
    }
    expect(validAgentDisplayHistory([message, message])).toBe(false)
    expect(validAgentDisplayHistory([{ ...message, toolCalls: [call, call] }])).toBe(false)
    expect(validAgentDisplayHistory([message, { ...message, id: 'second' }])).toBe(true)
  })

  it.each(['mode', 'reasoningEffort', 'status'] as const)(
    'rejects array/object-valued session %s instead of coercing it',
    (field) => {
      for (const value of [[session[field]], { value: session[field] }, null, 1]) {
        expect(() =>
          decodeAgentSessions(JSON.stringify({ sessions: [{ ...session, [field]: value }] }))
        ).toThrow('invalid session record')
      }
    }
  )

  it('rejects malformed envelopes and duplicate identities without dropping records', () => {
    for (const value of [
      null,
      [],
      {},
      { sessions: null },
      { sessions: [null] },
      { sessions: [session, session] }
    ]) {
      expect(() => decodeAgentSessions(JSON.stringify(value))).toThrow()
    }
  })

  it('accepts absent legacy history while leaving history validation to per-session quarantine', () => {
    const { history: _history, ...legacy } = session
    const result = decodeAgentSessions(
      JSON.stringify({ sessions: [legacy, { ...session, id: 'damaged', history: [null] }] })
    )
    expect(Object.hasOwn(result.sessions[0], 'history')).toBe(false)
    expect(result.sessions[1].history).toEqual([null])
  })

  it('quarantines array/object-valued display roles and tool statuses without string coercion', () => {
    const message = { id: 'display', timestamp: '', role: 'tool', content: 'edit_command' }
    const call = {
      id: 'call',
      name: 'edit_command',
      arguments: {},
      status: 'approved',
      createdAt: ''
    }
    expect(validAgentDisplayHistory([{ ...message, toolCalls: [call] }])).toBe(true)
    for (const role of [['user'], { value: 'user' }, null, 1]) {
      expect(validAgentDisplayHistory([{ ...message, role }])).toBe(false)
    }
    for (const status of [['approved'], { value: 'approved' }, null, 1]) {
      expect(validAgentDisplayHistory([{ ...message, toolCalls: [{ ...call, status }] }])).toBe(
        false
      )
    }
  })
})
