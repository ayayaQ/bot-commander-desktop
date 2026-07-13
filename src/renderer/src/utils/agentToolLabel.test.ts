import { describe, expect, it } from 'vitest'
import type { AgentToolCall } from '../../../shared/agentTypes'
import { agentToolLabel } from './agentToolLabel'

function toolCall(name: string, query?: unknown): AgentToolCall {
  return {
    id: 'call_1',
    name,
    arguments: query === undefined ? {} : { query },
    status: 'completed',
    createdAt: '2026-07-12T00:00:00.000Z'
  }
}

describe('agent tool labels', () => {
  it.each(['search_documentation', 'search_commands', 'search_interactions', 'keyword_grep'])(
    'includes the query for %s',
    (name) => {
      expect(agentToolLabel(toolCall(name, 'ping'))).toBe(`${name} for 'ping'`)
    }
  )

  it('normalizes query whitespace for a single-line label', () => {
    expect(agentToolLabel(toolCall('search_commands', '  welcome\n  new users  '))).toBe(
      "search_commands for 'welcome new users'"
    )
  })

  it('leaves unsupported tools unchanged', () => {
    expect(agentToolLabel(toolCall('read_command', 'ping'))).toBe('read_command')
  })

  it.each([undefined, null, 123, '', '   \n  '])(
    'falls back to the tool name for an unusable query: %s',
    (query) => {
      expect(agentToolLabel(toolCall('search_commands', query))).toBe('search_commands')
    }
  )
})
