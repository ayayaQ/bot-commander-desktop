import { describe, expect, it, vi } from 'vitest'
import type { AgentRunMetrics } from '../../shared/agentTypes'
import {
  createDocumentationPolicyState,
  executeDocumentationCall
} from './agentDocumentationPolicy'

function metrics(): AgentRunMetrics {
  return {
    runId: 'run_1',
    providerRounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    documentationCalls: 0,
    uniqueDocumentationCalls: 0,
    duplicateDocumentationCalls: 0,
    documentationResultChars: 0
  }
}

describe('agent documentation policy', () => {
  it('suppresses duplicate calls using normalized arguments', async () => {
    const state = createDocumentationPolicyState()
    const usage = metrics()
    const execute = vi.fn(async () => ({ bestMatch: { title: 'State' } }))

    await executeDocumentationCall(
      state,
      usage,
      'call_1',
      'search_documentation',
      {
        query: '  Persistent State '
      },
      execute
    )
    const duplicate = (await executeDocumentationCall(
      state,
      usage,
      'call_2',
      'search_documentation',
      { query: 'persistent state', limit: 3 },
      execute
    )) as any

    expect(execute).toHaveBeenCalledOnce()
    expect(duplicate).toMatchObject({ duplicate: true, previousToolCallId: 'call_1' })
    expect(usage).toMatchObject({
      documentationCalls: 2,
      uniqueDocumentationCalls: 1,
      duplicateDocumentationCalls: 1
    })
  })

  it('warns but does not block calls beyond the soft budget', async () => {
    const state = createDocumentationPolicyState()
    const usage = metrics()
    for (let index = 0; index < 2; index++) {
      await executeDocumentationCall(
        state,
        usage,
        `call_${index}`,
        'read_documentation',
        { id: `section_${index}` },
        async () => ({ id: `section_${index}` })
      )
    }
    const third = (await executeDocumentationCall(
      state,
      usage,
      'call_3',
      'read_documentation',
      { id: 'section_3' },
      async () => ({ id: 'section_3' })
    )) as any

    expect(third.id).toBe('section_3')
    expect(third.policyWarning).toContain('soft budget exceeded')
    expect(usage.uniqueDocumentationCalls).toBe(3)
  })

  it('allows a failed documentation lookup to be retried', async () => {
    const state = createDocumentationPolicyState()
    const usage = metrics()
    const args = { id: 'section_1' }

    await expect(
      executeDocumentationCall(state, usage, 'call_1', 'read_documentation', args, async () => {
        throw new Error('temporary failure')
      })
    ).rejects.toThrow('temporary failure')
    const retry = await executeDocumentationCall(
      state,
      usage,
      'call_2',
      'read_documentation',
      args,
      async () => ({ id: 'section_1' })
    )

    expect(retry).toEqual({ id: 'section_1' })
    expect(usage.duplicateDocumentationCalls).toBe(0)
  })
})
