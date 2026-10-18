import { describe, expect, it } from 'vitest'
import { agentContextLabel, agentContextTooltip, type AgentContextStatus } from './agentContext'

const snapshot: AgentContextStatus = {
  provider: 'openrouter',
  model: 'exact/model',
  state: 'ready',
  usage: {
    inputTokens: 1234,
    estimated: true,
    contextWindow: 16000,
    outputReserveTokens: 4096
  }
}

describe('agent context meter', () => {
  it('distinguishes estimated current input from lifetime usage', () => {
    expect(agentContextLabel(snapshot, 'openrouter', 'exact/model', 16000)).toBe(
      'Context ~1,234 / 16,000'
    )
    expect(
      agentContextLabel(
        { ...snapshot, usage: { ...snapshot.usage!, estimated: false } },
        'openrouter',
        'exact/model',
        16000
      )
    ).toBe('Context 1,234 / 16,000')
  })

  it('never reuses a different model or provider snapshot', () => {
    expect(agentContextLabel(snapshot, 'openai', 'exact/model')).toBe('Context unknown / unknown')
    expect(agentContextLabel(snapshot, 'openrouter', 'smaller/model', 8192)).toBe(
      'Context unknown / 8,192'
    )
  })

  it('labels missing limits honestly and uses freshly resolved limits', () => {
    expect(agentContextLabel(snapshot, 'openrouter', 'exact/model', undefined)).toBe(
      'Context ~1,234 / unknown'
    )
    expect(agentContextLabel(undefined, 'openai', 'custom')).toBe('Context unknown / unknown')
    expect(agentContextLabel(snapshot, 'openrouter', 'exact/model', 8000)).toBe(
      'Context ~1,234 / 8,000'
    )
  })
  it('does not turn malformed persisted analytics into an occupancy claim', () => {
    expect(
      agentContextLabel(
        { ...snapshot, usage: { ...snapshot.usage!, inputTokens: -1 } },
        'openrouter',
        'exact/model'
      )
    ).toBe('Context unknown / unknown')
    expect(agentContextLabel(undefined, 'openrouter', 'exact/model', -1)).toBe(
      'Context unknown / unknown'
    )
  })
  it('keeps summary usage separate and handles unavailable tooltip analytics safely', () => {
    const tooltip = agentContextTooltip(snapshot, {
      execution: 42,
      summary: 12,
      summaryIncomplete: true
    })
    expect(tooltip).toContain('Output reserve: 4,096 tokens')
    expect(tooltip).toContain('Execution reported usage: 42 tokens')
    expect(tooltip).toContain('Summary reported usage: 12 (incomplete)')
    expect(
      agentContextTooltip({ ...snapshot, usage: {} as AgentContextStatus['usage'] }, {})
    ).toContain('Output reserve: unknown')
  })
})
