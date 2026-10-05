import { describe, expect, it } from 'vitest'
import {
  clipAgentLintDiagnostics,
  stringifyAgentToolResult,
  MAX_AGENT_TOOL_RESULT_CHARS
} from './agentToolResult'
import { lintBCFD } from '../../shared/bcfdLint'

describe('bounded agent tool result envelopes', () => {
  it('caps actual oversized unknown-name diagnostics, including name, without losing repair controls', () => {
    const source = Array.from(
      { length: 8 },
      (_, index) => `$${'unknown'.repeat(1360)}${index}`
    ).join(' ')
    const diagnostics = clipAgentLintDiagnostics(lintBCFD(source))
    expect(diagnostics).toHaveLength(8)
    expect(diagnostics.every((item) => item.name!.length <= 64)).toBe(true)
    const output = stringifyAgentToolResult({
      success: false,
      saved: false,
      attemptsRemaining: 2,
      message: 'Repair this draft',
      validation: { outcome: 'failed' },
      diagnostics
    })
    expect(output.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_RESULT_CHARS)
    expect(JSON.parse(output)).toMatchObject({
      success: false,
      saved: false,
      attemptsRemaining: 2,
      message: 'Repair this draft',
      validation: { outcome: 'failed' }
    })
  })

  it('bounds the complete result while retaining full validation where it fits', () => {
    const output = stringifyAgentToolResult({
      success: false,
      saved: false,
      attemptsRemaining: 1,
      message: 'Repair',
      diagnostics: [{ name: 'x'.repeat(50000) }],
      validation: {
        outcome: 'failed',
        cases: [],
        details: 'valid-report'.repeat(1000)
      }
    })
    expect(output.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_RESULT_CHARS)
    expect(JSON.parse(output)).toMatchObject({
      attemptsRemaining: 1,
      saved: false,
      truncated: true,
      validation: { outcome: 'failed', details: 'valid-report'.repeat(1000) }
    })
  })

  it('compacts escaped oversized report envelopes as valid JSON without hiding outcome or repair budget', () => {
    const output = stringifyAgentToolResult({
      success: false,
      saved: false,
      attemptsRemaining: 0,
      message: '\u0000'.repeat(5000),
      validation: {
        outcome: 'not_run',
        candidateId: 'draft',
        candidateHash: 'hash',
        fixtureHash: 'fixtures',
        details: '\u0000'.repeat(5000)
      }
    })
    expect(output.length).toBeLessThanOrEqual(MAX_AGENT_TOOL_RESULT_CHARS)
    expect(JSON.parse(output)).toMatchObject({
      attemptsRemaining: 0,
      saved: false,
      truncated: true,
      validation: { outcome: 'not_run', candidateId: 'draft', truncated: true }
    })
  })
})
