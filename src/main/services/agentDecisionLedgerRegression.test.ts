import { describe, expect, it, vi } from 'vitest'
import {
  createDecisionLedger,
  decodeAgentDecisionLedger,
  MAX_DECISION_LEDGER_ROWS,
  type AgentDecisionAuditBinding,
  type AgentDecisionLedgerRow
} from './agentDecisionLedger'

vi.mock('electron', () => ({ app: { getPath: () => '/ordinary-offline-ledger-fixture' } }))

const MAX_PRETTY_LEDGER_BYTES = 256 * 1024
const binding: AgentDecisionAuditBinding = {
  provider: 'openai',
  accountRevision: 'ordinary-offline-account-1',
  policyRevision: 'desktop-reviewed-auto-v1'
}
type LedgerData = ReturnType<typeof decodeAgentDecisionLedger>

function ordinaryRow(index: number): AgentDecisionLedgerRow {
  return {
    id: `decision-${String(index).padStart(4, '0')}`,
    sessionId: 'session-ordinary-offline-agent-001',
    runId: 'run-ordinary-offline-agent-001',
    callBinding: 'a'.repeat(64),
    snapshotBinding: 'b'.repeat(64),
    tool: 'create_memory',
    policyRevision: binding.policyRevision,
    provider: 'openai',
    model: 'gpt-6-luna',
    reasonCode: 'requirements_met',
    recommendation: 'allow',
    source: 'automatic',
    checks: [
      { name: 'request_authorizes_change', probability: 0.999 },
      { name: 'effects_within_scope', probability: 0.999 },
      { name: 'evidence_not_redirected', probability: 0.999 },
      { name: 'durable_memory_intent', probability: 0.999 }
    ],
    usage: {
      inputTokens: 1234,
      outputTokens: 456,
      totalTokens: 1690,
      cachedTokens: 120,
      cacheWriteTokens: 0,
      reasoningTokens: 256,
      costUsd: 0.0025
    },
    state: 'reviewed',
    createdAt: '2026-10-08T01:00:00.000Z',
    targetType: 'memory',
    targetId: `memory-ordinary-offline-${String(index).padStart(4, '0')}`,
    candidateRevision: 'c'.repeat(16)
  }
}

function completedRow(index: number): AgentDecisionLedgerRow {
  return {
    ...ordinaryRow(index),
    state: 'committed',
    settledAt: '2026-10-08T01:00:01.000Z',
    resultingRevision: 'c'.repeat(16)
  }
}

function prettyBytes(rows: AgentDecisionLedgerRow[]): number {
  return Buffer.byteLength(JSON.stringify({ version: 1, rows }, null, 2))
}

function fixture(rows: AgentDecisionLedgerRow[] = []) {
  let stored = decodeAgentDecisionLedger(JSON.stringify({ version: 1, rows }, null, 2))
  const savedBytes: number[] = []
  const savedRowCounts: number[] = []
  const persistence = {
    load: vi.fn(async () => ({ data: structuredClone(stored), writable: true })),
    assertWritable: vi.fn(),
    confirmed: vi.fn(() => true),
    save: vi.fn(async (value: LedgerData) => {
      // Production persistence validates pretty JSON, including whitespace in its byte limit.
      const serialized = JSON.stringify(value, null, 2)
      const decoded = decodeAgentDecisionLedger(serialized)
      savedBytes.push(Buffer.byteLength(serialized))
      savedRowCounts.push(decoded.rows.length)
      stored = decoded
    })
  }
  return {
    ledger: createDecisionLedger(persistence),
    persistence,
    savedBytes,
    savedRowCounts,
    data: () => structuredClone(stored)
  }
}

/** Valid ordinary metadata with just enough free bytes to exercise later metadata growth. */
function nearByteBudget(trailingRows: AgentDecisionLedgerRow[], spareBytes = 8) {
  const rows: AgentDecisionLedgerRow[] = []
  const targetBytes = MAX_PRETTY_LEDGER_BYTES - spareBytes
  while (rows.length + trailingRows.length < MAX_DECISION_LEDGER_ROWS) {
    const next = completedRow(rows.length)
    if (prettyBytes([...rows, next, ...trailingRows]) > targetBytes) break
    rows.push(next)
  }
  let remaining = targetBytes - prettyBytes([...rows, ...trailingRows])
  for (const row of rows) {
    const extra = Math.min(remaining, 120 - row.sessionId.length)
    row.sessionId += 'x'.repeat(extra)
    remaining -= extra
    if (remaining === 0) break
  }
  expect(remaining).toBe(0)
  expect(rows.length + trailingRows.length).toBeLessThan(MAX_DECISION_LEDGER_ROWS)
  expect(prettyBytes([...rows, ...trailingRows])).toBe(targetBytes)
  decodeAgentDecisionLedger(
    JSON.stringify({ version: 1, rows: [...rows, ...trailingRows] }, null, 2)
  )
  return rows
}

function expectBoundedSaves(f: ReturnType<typeof fixture>) {
  expect(f.savedBytes.length).toBeGreaterThan(0)
  expect(Math.max(...f.savedBytes)).toBeLessThanOrEqual(MAX_PRETTY_LEDGER_BYTES)
  expect(Math.max(...f.savedRowCounts)).toBeLessThanOrEqual(MAX_DECISION_LEDGER_ROWS)
}

describe('ordinary offline decision ledger regression coverage', () => {
  it('keeps repeated full-metadata reviews available within pretty byte and row budgets', async () => {
    const f = fixture()
    const count = MAX_DECISION_LEDGER_ROWS * 2 + 20
    for (let index = 0; index < count; index++) {
      expect(await f.ledger.available(binding)).toBe(true)
      const row = ordinaryRow(index)
      await f.ledger.record(row)
      await f.ledger.settle(row.id, {
        state: 'committed',
        settledAt: '2026-10-08T01:00:01.000Z',
        resultingRevision: row.candidateRevision
      })
    }
    expectBoundedSaves(f)
    expect(f.data().rows.length).toBeLessThan(MAX_DECISION_LEDGER_ROWS)
    expect(f.data().rows.some((row) => row.id === 'decision-0000')).toBe(false)
    expect(f.data().rows.at(-1)).toMatchObject({
      id: ordinaryRow(count - 1).id,
      state: 'committed'
    })
    expect(await f.ledger.available(binding)).toBe(true)
    const restarted = fixture(f.data().rows)
    expect(await restarted.ledger.available(binding)).toBe(true)
  }, 20000)

  it('compacts terminal records when an already-recorded settlement grows the byte size', async () => {
    const live = ordinaryRow(1000)
    const completed = nearByteBudget([live])
    const f = fixture(completed)
    await f.ledger.record(live)
    const countBeforeSettlement = f.data().rows.length
    expect(prettyBytes(f.data().rows)).toBe(MAX_PRETTY_LEDGER_BYTES - 8)
    await f.ledger.settle(live.id, { state: 'commit_started', source: 'automatic' }, binding)
    await f.ledger.settle(live.id, {
      state: 'committed',
      settledAt: '2026-10-08T01:00:01.000Z',
      resultingRevision: 'c'.repeat(16)
    })
    expectBoundedSaves(f)
    expect(f.data().rows.length).toBeLessThan(countBeforeSettlement)
    expect(f.data().rows.some((row) => row.id === completed[0].id)).toBe(false)
    expect(f.data().rows.find((row) => row.id === live.id)).toMatchObject({
      state: 'committed',
      resultingRevision: 'c'.repeat(16)
    })
    expect(await f.ledger.available(binding)).toBe(true)
  })

  it('compacts eligible history when explicit reconciliation grows unknown metadata', async () => {
    const uncertain: AgentDecisionLedgerRow = { ...ordinaryRow(1000), state: 'unknown' }
    const completed = nearByteBudget([uncertain])
    const f = fixture([...completed, uncertain])
    const read = vi.fn(async (_type: 'command' | 'memory', _id: string) => ({
      resourceRevision: 'd'.repeat(16),
      targetRevision: null
    }))
    expect(await f.ledger.available(binding)).toBe(false)
    const inspected = await f.ledger.inspect(read, () => binding)
    expect(inspected.rows).toHaveLength(1)
    expect(inspected.rows[0]).toMatchObject({ id: uncertain.id, outcome: 'unknown' })
    expect(f.data().rows.at(-1)?.reconciliation).toBeUndefined()
    expect(await f.ledger.available(binding)).toBe(false)
    await f.ledger.acknowledge(inspected.id, read, () => binding)
    expectBoundedSaves(f)
    expect(f.data().rows.length).toBeLessThan(completed.length + 1)
    expect(f.data().rows.some((row) => row.id === completed[0].id)).toBe(false)
    expect(f.data().rows.find((row) => row.id === uncertain.id)).toMatchObject({
      state: 'unknown',
      reconciliation: {
        provider: binding.provider,
        accountRevision: binding.accountRevision,
        policyRevision: binding.policyRevision,
        targetRevision: null
      }
    })
    expect(
      read.mock.calls.every(([type, id]) => type === 'memory' && id === uncertain.targetId)
    ).toBe(true)
    expect(await f.ledger.available(binding)).toBe(true)
    const restarted = fixture(f.data().rows)
    expect(await restarted.ledger.available(binding)).toBe(true)
    expect(restarted.data().rows.find((row) => row.id === uncertain.id)?.state).toBe('unknown')
  })

  it('never evicts active reviewed or commit-started records while pruning completed history', async () => {
    const f = fixture()
    const reviewed = ordinaryRow(1000)
    const started = ordinaryRow(1001)
    await f.ledger.record(reviewed)
    await f.ledger.record(started)
    await f.ledger.settle(started.id, { state: 'commit_started', source: 'automatic' }, binding)
    for (let index = 0; index < MAX_DECISION_LEDGER_ROWS + 20; index++) {
      const row = ordinaryRow(index)
      await f.ledger.record(row)
      await f.ledger.settle(row.id, {
        state: 'committed',
        settledAt: '2026-10-08T01:00:01.000Z',
        resultingRevision: 'c'.repeat(16)
      })
    }
    expectBoundedSaves(f)
    expect(f.data().rows.find((row) => row.id === reviewed.id)).toEqual(reviewed)
    expect(f.data().rows.find((row) => row.id === started.id)).toEqual({
      ...started,
      state: 'commit_started'
    })
    expect(f.data().rows.some((row) => row.id === 'decision-0000')).toBe(false)
  }, 20000)

  it('refuses excess active metadata instead of evicting any unresolved record', async () => {
    const f = fixture()
    const recorded: AgentDecisionLedgerRow[] = []
    let rejected = false
    for (let index = 0; index <= MAX_DECISION_LEDGER_ROWS; index++) {
      const row = ordinaryRow(index)
      try {
        await f.ledger.record(row)
        recorded.push(row)
      } catch (error) {
        expect(String(error)).toMatch(/unresolved|oversized/)
        rejected = true
        break
      }
    }
    expect(rejected).toBe(true)
    expect(recorded.length).toBeLessThan(MAX_DECISION_LEDGER_ROWS)
    expect(f.data().rows).toEqual(recorded)
    expectBoundedSaves(f)
  })

  it('retains every unacknowledged unknown row when recovery prevents another record', async () => {
    const uncertain: AgentDecisionLedgerRow = { ...ordinaryRow(1000), state: 'unknown' }
    const completed = nearByteBudget([uncertain])
    const f = fixture([...completed, uncertain])
    expect(await f.ledger.available(binding)).toBe(false)
    await expect(f.ledger.record(ordinaryRow(1001))).rejects.toThrow('recovery')
    expect(f.data().rows).toEqual([...completed, uncertain])
    expect(f.persistence.save).not.toHaveBeenCalled()
  })

  it('can prune acknowledged unknown history while retaining fresh active records', async () => {
    const acknowledged: AgentDecisionLedgerRow[] = []
    for (let index = 0; index < MAX_DECISION_LEDGER_ROWS; index++) {
      const row: AgentDecisionLedgerRow = {
        ...completedRow(index),
        state: 'unknown',
        reconciliation: {
          id: `ordinary-offline-inspection-${index}`,
          ...binding,
          resourceRevision: 'd'.repeat(16),
          targetRevision: null,
          inspectedAt: '2026-10-08T01:00:02.000Z',
          acknowledgedAt: '2026-10-08T01:00:03.000Z'
        }
      }
      if (prettyBytes([...acknowledged, row]) > MAX_PRETTY_LEDGER_BYTES) break
      acknowledged.push(row)
    }
    expect(acknowledged.length).toBeLessThan(MAX_DECISION_LEDGER_ROWS)
    const f = fixture(acknowledged)
    const first = ordinaryRow(1000)
    const second = ordinaryRow(1001)
    expect(prettyBytes([...acknowledged, first, second])).toBeGreaterThan(MAX_PRETTY_LEDGER_BYTES)
    expect(await f.ledger.available(binding)).toBe(true)
    await f.ledger.record(first)
    await f.ledger.record(second)
    expectBoundedSaves(f)
    expect(f.data().rows.some((row) => row.id === acknowledged[0].id)).toBe(false)
    expect(f.data().rows.find((row) => row.id === first.id)).toEqual(first)
    expect(f.data().rows.find((row) => row.id === second.id)).toEqual(second)
    expect(
      f
        .data()
        .rows.filter((row) => row.reconciliation)
        .every((row) => row.state === 'unknown')
    ).toBe(true)
    expect(await f.ledger.available(binding)).toBe(true)
  })

  it.each(['reviewed', 'commit_started'] as const)(
    'makes an interrupted %s row visibly unknown and requires inspection and acknowledgement',
    async (state) => {
      const interrupted: AgentDecisionLedgerRow = { ...ordinaryRow(1000), state }
      const outcomes = ['committed', 'denied', 'cancelled', 'failed'] as const
      const settled = outcomes.map((outcome, index) => ({
        ...completedRow(index),
        state: outcome
      }))
      const f = fixture([...settled, interrupted])
      const read = vi.fn(async (_type: 'command' | 'memory', _id: string) => ({
        resourceRevision: 'd'.repeat(16),
        targetRevision: null
      }))
      expect(await f.ledger.available(binding)).toBe(false)
      expect(f.data().rows.slice(0, settled.length)).toEqual(settled)
      expect(f.data().rows.at(-1)).toMatchObject({
        ...interrupted,
        state: 'unknown',
        settledAt: expect.any(String)
      })
      await expect(f.ledger.record(ordinaryRow(1001))).rejects.toThrow('recovery')
      await expect(
        f.ledger.acknowledge('uninspected-fixture', read, () => binding)
      ).rejects.toThrow('Inspect')
      expect(read).not.toHaveBeenCalled()
      const inspected = await f.ledger.inspect(read, () => binding)
      expect(inspected.canAcknowledge).toBe(true)
      expect(inspected.rows).toEqual([
        {
          id: interrupted.id,
          tool: interrupted.tool,
          outcome: 'unknown',
          targetType: interrupted.targetType,
          targetId: interrupted.targetId,
          candidateRevision: interrupted.candidateRevision,
          currentResourceRevision: 'd'.repeat(16),
          currentTargetRevision: null
        }
      ])
      expect(await f.ledger.available(binding)).toBe(false)
      expect(f.data().rows.at(-1)?.reconciliation).toBeUndefined()
      await f.ledger.acknowledge(inspected.id, read, () => binding)
      expect(await f.ledger.available(binding)).toBe(true)
      expect(f.data().rows.at(-1)).toMatchObject({
        id: interrupted.id,
        state: 'unknown',
        reconciliation: { id: inspected.id, accountRevision: binding.accountRevision }
      })
      expect(
        read.mock.calls.every(([type, id]) => type === 'memory' && id === interrupted.targetId)
      ).toBe(true)
      const restarted = fixture(f.data().rows)
      expect(await restarted.ledger.available(binding)).toBe(true)
      expect(restarted.data().rows.slice(0, settled.length)).toEqual(settled)
      expect(restarted.data().rows.at(-1)?.state).toBe('unknown')
      expectBoundedSaves(f)
    }
  )

  it('blocks a queued automatic commit after another settlement suspends the audit', async () => {
    const f = fixture()
    const first = ordinaryRow(0)
    const second = ordinaryRow(1)
    await f.ledger.record(first)
    await f.ledger.record(second)
    expect(await f.ledger.available(binding)).toBe(true)
    f.ledger.assertAutomaticAdmission(binding)
    const previousSaves = f.persistence.save.mock.calls.length
    f.persistence.save.mockRejectedValueOnce(new Error('ordinary offline settlement failure'))
    const results = await Promise.allSettled([
      f.ledger.settle(first.id, { state: 'committed', source: 'automatic' }, binding),
      f.ledger.settle(second.id, { state: 'commit_started', source: 'automatic' }, binding)
    ])
    expect(results[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('settlement') })
    })
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: expect.stringContaining('recovery') })
    })
    expect(f.persistence.save).toHaveBeenCalledTimes(previousSaves + 1)
    expect(f.data().rows).toEqual([first, second])
    expect(await f.ledger.available(binding)).toBe(false)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
    // Actual manual/outcome facts still need to be journaled after Auto is suspended.
    await f.ledger.settle(first.id, { state: 'failed', source: 'human_once' })
    expect(f.data().rows.find((row) => row.id === first.id)).toMatchObject({
      state: 'failed',
      source: 'human_once'
    })
    expect(f.data().rows.find((row) => row.id === second.id)).toEqual(second)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
  })

  it('checks automatic admission synchronously after a prior availability check', async () => {
    const f = fixture()
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
    expect(await f.ledger.available(binding)).toBe(true)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).not.toThrow()
    const row = ordinaryRow(0)
    await f.ledger.record(row)
    const saves = f.persistence.save.mock.calls.length
    f.persistence.confirmed.mockReturnValue(false)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
    await expect(
      f.ledger.settle(row.id, { state: 'commit_started', source: 'automatic' }, binding)
    ).rejects.toThrow('recovery')
    expect(f.persistence.save).toHaveBeenCalledTimes(saves)
    expect(f.data().rows).toEqual([row])
    f.persistence.confirmed.mockReturnValue(true)
    f.ledger.suspend()
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
  })

  it.each(['provider', 'accountRevision', 'policyRevision'] as const)(
    'binds automatic admission to the acknowledged %s',
    async (key) => {
      const uncertain: AgentDecisionLedgerRow = {
        ...ordinaryRow(1000),
        state: 'unknown',
        reconciliation: {
          id: 'ordinary-offline-inspection',
          ...binding,
          resourceRevision: 'd'.repeat(16),
          targetRevision: null,
          inspectedAt: '2026-10-08T01:00:02.000Z',
          acknowledgedAt: '2026-10-08T01:00:03.000Z'
        }
      }
      const f = fixture([uncertain])
      expect(await f.ledger.available(binding)).toBe(true)
      expect(() => f.ledger.assertAutomaticAdmission(binding)).not.toThrow()
      const changed = { ...binding }
      if (key === 'provider') changed.provider = 'openrouter'
      else changed[key] = 'ordinary-offline-changed'
      expect(() => f.ledger.assertAutomaticAdmission(changed)).toThrow('recovery')
      expect(() => f.ledger.assertAutomaticAdmission()).toThrow('recovery')
      const live = ordinaryRow(1001)
      await f.ledger.record(live)
      const saves = f.persistence.save.mock.calls.length
      await expect(
        f.ledger.settle(live.id, { state: 'commit_started', source: 'automatic' }, changed)
      ).rejects.toThrow('recovery')
      expect(f.persistence.save).toHaveBeenCalledTimes(saves)
      expect(f.data().rows).toEqual([uncertain, live])
      await f.ledger.settle(live.id, { state: 'commit_started', source: 'automatic' }, binding)
      expect(f.data().rows.find((row) => row.id === live.id)?.state).toBe('commit_started')
      expect(f.data().rows.find((row) => row.id === uncertain.id)).toEqual(uncertain)
    }
  )

  it('keeps interrupted review inspectable when its recovery checkpoint fails', async () => {
    const interrupted = ordinaryRow(1000)
    const f = fixture([interrupted])
    const read = vi.fn(async (_type: 'command' | 'memory', _id: string) => ({
      resourceRevision: 'd'.repeat(16),
      targetRevision: null
    }))
    f.persistence.save.mockRejectedValueOnce(new Error('ordinary offline recovery save failure'))
    expect(await f.ledger.available(binding)).toBe(false)
    expect(f.data().rows).toEqual([interrupted])
    const inspected = await f.ledger.inspect(read, () => binding)
    expect(inspected.canAcknowledge).toBe(true)
    expect(inspected.rows[0]).toMatchObject({ id: interrupted.id, outcome: 'unknown' })
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
    await f.ledger.acknowledge(inspected.id, read, () => binding)
    expect(f.data().rows[0]).toMatchObject({
      id: interrupted.id,
      state: 'unknown',
      reconciliation: { id: inspected.id }
    })
    expect(await f.ledger.available(binding)).toBe(true)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).not.toThrow()
    expectBoundedSaves(f)
  })
})
