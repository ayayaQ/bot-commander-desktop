import { describe, expect, it } from 'vitest'
import type { AgentSession, AgentToolCall } from '../../../shared/agentTypes'
import { deriveAgentNavigationStatus } from './agentAttention'

function session(
  id: string,
  status: AgentSession['status'],
  toolCalls: AgentToolCall[] = []
): AgentSession {
  return {
    id,
    title: id,
    mode: 'manual',
    model: 'test',
    reasoningEffort: 'none',
    status,
    messages: toolCalls.length
      ? [{ id: `message-${id}`, role: 'tool', content: '', timestamp: '', toolCalls }]
      : [],
    createdAt: '',
    updatedAt: '',
    tokenCount: 0
  }
}

function approval(id: string): AgentToolCall {
  return {
    id,
    name: 'update_command',
    arguments: {},
    status: 'waiting_approval',
    createdAt: ''
  }
}

describe('agent navigation attention', () => {
  it('prioritizes and counts approvals across sessions', () => {
    const result = deriveAgentNavigationStatus(
      [
        session('one', 'waiting_approval', [approval('a')]),
        session('two', 'waiting_approval', [approval('b'), approval('c')]),
        session('three', 'running')
      ],
      { old: 'error' }
    )

    expect(result).toMatchObject({ kind: 'approval', count: 3 })
  })

  it('shows running before unseen terminal results', () => {
    expect(
      deriveAgentNavigationStatus([session('one', 'running')], { old: 'error' })
    ).toMatchObject({ kind: 'running', count: 1 })
  })

  it('prioritizes unseen errors over successful completions', () => {
    expect(
      deriveAgentNavigationStatus([], { one: 'completed', two: 'error', three: 'error' })
    ).toMatchObject({ kind: 'error', count: 2 })
  })

  it('returns idle when no session needs attention', () => {
    expect(deriveAgentNavigationStatus([session('one', 'completed')], {})).toEqual({
      kind: 'idle',
      count: 0,
      label: 'Agent'
    })
  })
})
