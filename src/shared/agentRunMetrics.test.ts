import { describe, expect, it } from 'vitest'
import type { AgentRunMetrics, AgentToolCall } from './agentTypes'
import {
  agentRunElapsed,
  agentRunOutcome,
  agentRunToolSummary,
  agentRunValidationSummary,
  createAgentRunMetrics,
  finishAgentRunMetrics,
  formatAgentTokenCount,
  interruptAgentRunMetrics,
  reconcileAgentRunUsage,
  recordAgentRound,
  recordAgentRunTool
} from './agentRunMetrics'

const start = '2026-10-05T01:00:00.000Z'
const later = '2026-10-05T01:01:12.000Z'
const usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cachedInputTokens: 60,
  cacheWriteInputTokens: 10
}
function call(overrides: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    id: 'call-1',
    name: 'read_bot_state',
    arguments: {},
    createdAt: start,
    status: 'completed',
    ...overrides
  }
}

describe('truthful agent run metrics', () => {
  it('starts without cache or validation evidence and distinguishes zero from unavailable', () => {
    const metrics = createAgentRunMetrics('run-1', start)
    expect(metrics).not.toHaveProperty('cachedInputTokens')
    expect(metrics).not.toHaveProperty('cacheWriteInputTokens')
    expect(metrics.usageReconciled).toBe(false)
    expect(formatAgentTokenCount(undefined)).toBe('Unavailable')
    expect(formatAgentTokenCount(0)).toBe('0')
    expect(agentRunValidationSummary(metrics)).toBe('No validation evidence recorded')
    expect(agentRunToolSummary(metrics)).toBe('None recorded')
  })

  it('accumulates cache subsets without inflating input or total, independently per field', () => {
    const initial = createAgentRunMetrics('run-1', start)
    const first = recordAgentRound(initial, 1, usage)
    const second = recordAgentRound(first, 2, { ...usage, cachedInputTokens: 0 })
    expect(second).toMatchObject({
      providerRounds: 2,
      inputTokens: 200,
      outputTokens: 40,
      totalTokens: 240,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 20
    })
    expect(initial.providerRounds).toBe(0)
    const { cacheWriteInputTokens: _write, ...readOnly } = usage
    const third = recordAgentRound(second, 3, readOnly)
    expect(third.cachedInputTokens).toBe(120)
    expect(third).not.toHaveProperty('cacheWriteInputTokens')
    expect(recordAgentRound(third, 4, usage)).not.toHaveProperty('cacheWriteInputTokens')
  })

  it('keeps an omitted first-round field unavailable, including a round with no usage', () => {
    for (const first of [undefined, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]) {
      const metrics = recordAgentRound(createAgentRunMetrics('run-1', start), 1, first)
      const next = recordAgentRound(metrics, 2, usage)
      expect(next).not.toHaveProperty('cachedInputTokens')
      expect(next).not.toHaveProperty('cacheWriteInputTokens')
      expect(next.totalTokens).toBe(120)
    }
    const zero = recordAgentRound(createAgentRunMetrics('run-1', start), 1, {
      ...usage,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0
    })
    expect(zero.cachedInputTokens).toBe(0)
    expect(zero.cacheWriteInputTokens).toBe(0)
    expect(recordAgentRound(zero, 2)).not.toHaveProperty('cachedInputTokens')
  })

  it('ignores repeated round ordinals and overwrites authoritative final totals exactly once', () => {
    const interim = recordAgentRound(createAgentRunMetrics('run-1', start), 1, usage)
    expect(recordAgentRound(interim, 1, usage)).toBe(interim)
    expect(recordAgentRound(interim, 3, usage)).toBe(interim)
    const final = { rounds: 2, usage: { inputTokens: 220, outputTokens: 30, totalTokens: 250 } }
    const reconciled = reconcileAgentRunUsage(interim, final)
    expect(reconciled).toMatchObject({ providerRounds: 2, ...final.usage, usageReconciled: true })
    expect(reconciled).not.toHaveProperty('cachedInputTokens')
    expect(reconciled).not.toHaveProperty('cacheWriteInputTokens')
    expect(reconcileAgentRunUsage(reconciled, final)).toEqual(reconciled)
    expect(recordAgentRound(reconciled, 3, usage)).toBe(reconciled)
  })

  it.each(['cancelled', 'error'] as const)(
    'reconciles a committed %s round even when no round_completed event was delivered',
    (status) => {
      const pending = recordAgentRunTool(
        createAgentRunMetrics('run-1', start),
        call({ status: 'running' })
      )
      const final = finishAgentRunMetrics(
        reconcileAgentRunUsage(pending, { rounds: 1, usage }),
        status,
        later
      )
      expect(final).toMatchObject({ providerRounds: 1, ...usage, status, usageReconciled: true })
      expect(final.tools).toEqual([{ id: 'call-1', name: 'read_bot_state', status: 'unknown' }])
      const reloaded = JSON.parse(JSON.stringify(final)) as AgentRunMetrics
      expect(reconcileAgentRunUsage(reloaded, { rounds: 1, usage })).toEqual(final)
      expect(agentRunElapsed(reloaded)).toBe('1:12')
    }
  )

  it('deduplicates tool state observations by run-local call ID', () => {
    const started = recordAgentRunTool(
      createAgentRunMetrics('run-1', start),
      call({ status: 'running' })
    )
    const waiting = recordAgentRunTool(started, call({ status: 'waiting_approval' }))
    const rejected = recordAgentRunTool(waiting, call({ status: 'rejected' }))
    const finished = finishAgentRunMetrics(rejected, 'completed', later)
    expect(started.tools![0].status).toBe('running')
    expect(finished.tools).toHaveLength(1)
    expect(agentRunToolSummary(finished)).toBe('1 attempted (1 rejected)')
    expect(createAgentRunMetrics('run-2', later).tools).toEqual([])
  })

  it('records valid explicit lint or mutation diagnostics, never arbitrary success or empty results', () => {
    const initial = createAgentRunMetrics('run-1', start)
    const unrelated = recordAgentRunTool(initial, call({ result: [] }))
    expect(agentRunValidationSummary(unrelated)).toBe('No validation evidence recorded')
    const noErrors = recordAgentRunTool(initial, call({ name: 'lint_js', result: [] }))
    expect(agentRunValidationSummary(noErrors)).toBe(
      'Lint only: 1 checks, 0 errors, 0 warnings. No runtime validation recorded.'
    )
    const mutation = recordAgentRunTool(
      noErrors,
      call({
        id: 'call-2',
        name: 'edit_command',
        result: {
          success: true,
          diagnostics: [
            { severity: 'error', message: 'Bad syntax' },
            { severity: 'warning', message: 'Check this' }
          ]
        }
      })
    )
    expect(agentRunValidationSummary(mutation)).toBe(
      'Lint only: 2 checks, 1 errors, 1 warnings. No runtime validation recorded.'
    )
    for (const result of [
      undefined,
      {},
      { success: true },
      [{ severity: 'error' }],
      [{ message: 'bad' }]
    ]) {
      expect(
        recordAgentRunTool(initial, call({ name: 'lint_js', result })).tools![0].lint
      ).toBeUndefined()
    }
    expect(
      recordAgentRunTool(initial, call({ name: 'lint_js', status: 'error', result: [] })).tools![0]
        .lint
    ).toBeUndefined()
  })

  it('recovers only checkpoint evidence, without adding duration, usage, or successful outcomes', () => {
    const checkpoint = {
      ...recordAgentRunTool(
        recordAgentRound(createAgentRunMetrics('run-1', start), 1, usage),
        call({ status: 'approved' })
      ),
      checkpointAt: later
    }
    const interrupted = interruptAgentRunMetrics(JSON.parse(JSON.stringify(checkpoint)))
    expect(interrupted).toMatchObject({
      status: 'interrupted',
      providerRounds: 1,
      ...usage,
      usageReconciled: false
    })
    expect(interrupted).not.toHaveProperty('finishedAt')
    expect(agentRunElapsed(interrupted)).toBe('1:12')
    expect(interrupted.tools![0].status).toBe('unknown')
    expect(interruptAgentRunMetrics(interrupted)).toEqual(interrupted)
    expect(agentRunValidationSummary(interrupted)).toBe('No validation evidence recorded')
  })

  it('keeps repeated terminal observations stable and permits an actual error outcome change', () => {
    const finished = finishAgentRunMetrics(
      createAgentRunMetrics('run-1', start),
      'completed',
      later
    )
    expect(finishAgentRunMetrics(finished, 'completed', '2026-10-05T02:00:00Z')).toBe(finished)
    const failedSave = finishAgentRunMetrics(finished, 'error', '2026-10-05T01:01:13Z')
    expect(failedSave.status).toBe('error')
    expect(agentRunElapsed(failedSave)).toBe('1:13')
    expect(agentRunOutcome(failedSave)).toBe('error')
  })

  it.each([null, {}, 'invalid', [null], [{}], [{ id: 'id', name: 'tool', status: ['completed'] }]])(
    'handles malformed optional tool metadata without breaking recovery or inventing evidence: %j',
    (tools) => {
      const metrics = {
        ...createAgentRunMetrics('run-1', start),
        tools
      } as unknown as AgentRunMetrics
      expect(agentRunToolSummary(metrics)).toBe('Unavailable')
      expect(agentRunValidationSummary(metrics)).toBe('Unavailable (invalid recorded evidence)')
      expect(interruptAgentRunMetrics(metrics).tools).toEqual(tools)
      expect(finishAgentRunMetrics(metrics, 'error', later).tools).toEqual(tools)
    }
  )

  it.each([null, {}, { errors: -1, warnings: 0 }, { errors: '0', warnings: 0 }])(
    'keeps malformed lint evidence unavailable: %j',
    (lint) => {
      const metrics = {
        ...createAgentRunMetrics('run-1', start),
        tools: [{ id: 'id', name: 'lint_js', status: 'completed', lint }]
      } as unknown as AgentRunMetrics
      expect(agentRunToolSummary(metrics)).toBe('1 attempted (1 completed)')
      expect(agentRunValidationSummary(metrics)).toBe('Unavailable (invalid recorded evidence)')
    }
  )

  it('does not count duplicate saved tool identities or coerce malformed timing/outcomes', () => {
    const tool = { id: 'id', name: 'lint_js', status: 'completed' as const }
    const metrics = {
      ...createAgentRunMetrics('run-1', start),
      tools: [tool, tool],
      startedAt: [],
      status: ['completed']
    } as unknown as AgentRunMetrics
    expect(agentRunToolSummary(metrics)).toBe('Unavailable')
    expect(agentRunValidationSummary(metrics)).toBe('Unavailable (invalid recorded evidence)')
    expect(agentRunElapsed(metrics)).toBe('Unavailable')
    expect(agentRunOutcome(metrics)).toBe('Unavailable')
  })

  it('shows legacy missing timing and tool evidence as unavailable', () => {
    const {
      startedAt: _start,
      checkpointAt: _checkpoint,
      status: _status,
      tools: _tools,
      usageReconciled: _reconciled,
      ...legacy
    } = createAgentRunMetrics('legacy', start)
    expect(agentRunElapsed(legacy)).toBe('Unavailable')
    expect(agentRunToolSummary(legacy)).toBe('Unavailable')
    expect(agentRunValidationSummary(legacy)).toBe('Unavailable (older run)')
    expect(agentRunElapsed({ ...legacy, startedAt: later, checkpointAt: start })).toBe(
      'Unavailable'
    )
    expect(formatAgentTokenCount(-1)).toBe('Unavailable')
    expect(formatAgentTokenCount(NaN)).toBe('Unavailable')
  })
})
