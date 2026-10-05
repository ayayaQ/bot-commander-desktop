import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentSession } from '../../shared/agentTypes'
import {
  closeInterruptedAgentHistory,
  initializeAgentHistory,
  migrateAgentHistory
} from './agentHistory'

describe('agent history recovery', () => {
  it('migrates legacy UI tool records without replay and preserves denials/errors', () => {
    const messages = [
      { role: 'user', content: 'Edit' },
      {
        role: 'tool',
        content: '{"denied":true}',
        toolCalls: [{ id: 'c1', name: 'edit', arguments: { revision: 'r1' }, status: 'rejected' }]
      },
      {
        role: 'tool',
        content: '{"error":"stale"}',
        toolCalls: [{ id: 'c2', name: 'edit', arguments: {}, status: 'error' }]
      },
      { role: 'assistant', content: 'Kept unchanged' }
    ] as AgentMessage[]
    const history = migrateAgentHistory(messages)
    expect(history.map((item) => item.kind)).toEqual([
      'message',
      'assistant',
      'tool_result',
      'assistant',
      'tool_result',
      'assistant'
    ])
    expect(history[2]).toMatchObject({ callId: 'c1', content: '{"denied":true}', isError: true })
    expect(history[4]).toMatchObject({ callId: 'c2', content: '{"error":"stale"}', isError: true })
  })

  it('closes only missing outputs after a process interruption without mutating input', () => {
    const original = [
      {
        kind: 'assistant' as const,
        content: '',
        toolCalls: [
          { id: 'c1', name: 'write', arguments: {} },
          { id: 'c2', name: 'read', arguments: {} }
        ]
      },
      { kind: 'tool_result' as const, callId: 'c1', name: 'write', content: '{"saved":true}' }
    ]
    const recovered = closeInterruptedAgentHistory(original)
    expect(original).toHaveLength(2)
    expect(recovered).toHaveLength(3)
    expect(recovered[2]).toMatchObject({ kind: 'tool_result', callId: 'c2', isError: true })
    expect(JSON.parse(recovered[2].content)).toMatchObject({
      success: false,
      error: { code: 'interrupted', message: expect.stringContaining('outcome may be unknown') }
    })
    expect(closeInterruptedAgentHistory(recovered)).toEqual(recovered)
  })

  it('normalizes repeated legacy IDs once and preserves result matching', () => {
    const messages = [
      {
        role: 'tool',
        content: '{"value":1}',
        toolCalls: [{ id: 'call_0', name: 'read', arguments: {}, status: 'completed' }]
      },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Again' },
      {
        role: 'tool',
        content: '{"value":2}',
        toolCalls: [{ id: 'call_0', name: 'read', arguments: {}, status: 'completed' }]
      }
    ] as AgentMessage[]
    const history = migrateAgentHistory(messages)
    const ids = history
      .filter((item) => item.kind === 'assistant')
      .flatMap((item) => item.toolCalls.map((call) => call.id))
    expect(ids).toEqual(['call_0', 'call_0_legacy_1'])
    expect(
      history.filter((item) => item.kind === 'tool_result').map((item) => item.callId)
    ).toEqual(ids)
    expect(migrateAgentHistory(messages)).toEqual(history)
  })

  it('preserves legacy unfinished calls as explicit unknown-outcome results', () => {
    const messages = [
      {
        role: 'tool',
        content: 'edit',
        toolCalls: [{ id: 'unfinished', name: 'edit', arguments: {}, status: 'approved' }]
      }
    ] as AgentMessage[]
    const history = migrateAgentHistory(messages)
    expect(JSON.parse(history[1].content)).toEqual({
      success: false,
      error: {
        code: 'interrupted',
        message:
          'Tool call interrupted; the outcome may be unknown. Read current state before retrying.'
      }
    })
    expect(closeInterruptedAgentHistory(history)).toEqual(history)
  })

  it('migrates display records only when canonical history is absent', () => {
    const session = {
      messages: [{ role: 'user', content: 'Legacy request' }]
    } as AgentSession
    initializeAgentHistory(session)
    expect(session.history).toEqual([{ kind: 'message', role: 'user', content: 'Legacy request' }])
  })

  it.each([null, undefined, {}, 'damaged', 0])(
    'does not rebuild a present non-array history (%j) from display messages',
    (history) => {
      const session = {
        history,
        messages: [{ role: 'user', content: 'Do not substitute this display text' }]
      } as unknown as AgentSession
      const original = structuredClone(session)
      expect(() => initializeAgentHistory(session)).toThrow(
        'Existing agent history must be an array'
      )
      expect(session).toEqual(original)
      expect(Object.hasOwn(session, 'history')).toBe(true)
    }
  )

  it('preserves an existing malformed canonical array and its optional native state on failure', () => {
    const session = {
      history: [
        { kind: 'assistant', content: 'Old response', toolCalls: [], providerState: { items: [] } }
      ],
      messages: [{ role: 'assistant', content: 'Do not replace canonical history' }]
    } as unknown as AgentSession
    const original = structuredClone(session)
    expect(() => initializeAgentHistory(session)).toThrow(
      'Provider state must identify its adapter'
    )
    expect(session).toEqual(original)
  })
})
