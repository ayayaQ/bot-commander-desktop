import { describe, expect, it, vi } from 'vitest'
import {
  createDecisionLedger,
  decodeAgentDecisionLedger,
  MAX_DECISION_LEDGER_ROWS,
  type AgentDecisionLedgerRow,
  type AgentDecisionAuditBinding
} from './agentDecisionLedger'

vi.mock('electron', () => ({ app: { getPath: () => '/offline-user-data' } }))

function row(index = 0): AgentDecisionLedgerRow {
  return {
    id: `decision-${index}`,
    sessionId: 'agent-fixture',
    runId: 'run-fixture',
    callBinding: 'a'.repeat(64),
    snapshotBinding: 'b'.repeat(64),
    tool: 'create_memory',
    policyRevision: 'desktop-reviewed-auto-v1',
    provider: 'openai',
    model: 'gpt-6-luna',
    reasonCode: 'requirements_met',
    recommendation: 'allow',
    source: 'automatic',
    checks: [{ name: 'request_authorizes_change', probability: 0.999 }],
    usage: { inputTokens: 10, outputTokens: 5 },
    state: 'reviewed',
    createdAt: '2026-10-08T01:00:00.000Z'
  }
}
function fixture(rows: AgentDecisionLedgerRow[] = []) {
  let stored = { version: 1 as const, rows }
  const persistence = {
    load: vi.fn(async () => ({ data: structuredClone(stored), writable: true })),
    assertWritable: vi.fn(),
    save: vi.fn(async (value) => {
      stored = decodeAgentDecisionLedger(JSON.stringify(value))
    })
  }
  return {
    ledger: createDecisionLedger(persistence),
    persistence,
    data: () => structuredClone(stored)
  }
}

describe('bounded metadata-only decision ledger', () => {
  it('records and settles exact metadata without a request payload', async () => {
    const f = fixture()
    await f.ledger.record(row())
    await f.ledger.settle('decision-0', { state: 'commit_started' })
    await f.ledger.settle('decision-0', {
      state: 'committed',
      resultingRevision: '0123456789abcdef'
    })
    expect(f.data().rows[0]).toMatchObject({
      state: 'committed',
      resultingRevision: '0123456789abcdef'
    })
    expect(Object.keys(f.data().rows[0])).not.toContain('arguments')
  })

  it('bounds completed records without rewriting unresolved authority', async () => {
    const rows = Array.from({ length: MAX_DECISION_LEDGER_ROWS }, (_, index) => ({
      ...row(index),
      state: 'committed' as const
    }))
    const f = fixture(rows)
    await f.ledger.record(row(MAX_DECISION_LEDGER_ROWS))
    expect(f.data().rows).toHaveLength(MAX_DECISION_LEDGER_ROWS)
    expect(f.data().rows[0].id).toBe('decision-1')
  })

  it('recovers an interrupted commit as unknown and never enables a replay', async () => {
    const f = fixture([{ ...row(), state: 'commit_started' }])
    expect(await f.ledger.available()).toBe(false)
    expect(f.data().rows[0].state).toBe('unknown')
    await expect(f.ledger.record(row(1))).rejects.toThrow('recovery')
    expect(f.data().rows).toHaveLength(1)
  })

  it('retains existing records on a precommit save failure', async () => {
    const existing = { ...row(), state: 'committed' as const }
    const f = fixture([existing])
    f.persistence.save.mockRejectedValueOnce(new Error('offline save failed'))
    await expect(f.ledger.record(row(1))).rejects.toThrow('offline save failed')
    expect(f.data().rows).toEqual([existing])
  })

  it('suspends further Auto writes after settlement fails', async () => {
    const f = fixture()
    await f.ledger.record(row())
    f.persistence.save.mockRejectedValueOnce(new Error('offline save failed'))
    await expect(f.ledger.settle('decision-0', { state: 'committed' })).rejects.toThrow(
      'settlement'
    )
    expect(await f.ledger.available()).toBe(false)
    expect(f.data().rows[0].state).toBe('reviewed')
  })

  it('inspects and explicitly acknowledges an unknown outcome without changing that outcome', async () => {
    const f = fixture([
      {
        ...row(),
        state: 'commit_started',
        targetType: 'memory',
        targetId: 'memory-fixture',
        candidateRevision: 'a'.repeat(16)
      }
    ])
    const binding = {
      provider: 'openai' as const,
      accountRevision: 'account-fixture-1',
      policyRevision: 'desktop-reviewed-auto-v1'
    }
    const read = vi.fn(async () => ({ resourceRevision: 'b'.repeat(16), targetRevision: null }))
    expect(await f.ledger.available(binding)).toBe(false)
    const inspected = await f.ledger.inspect(read, () => binding)
    expect(inspected.rows[0]).toMatchObject({
      outcome: 'unknown',
      currentResourceRevision: 'b'.repeat(16),
      currentTargetRevision: null
    })
    await f.ledger.acknowledge(inspected.id, read, () => binding)
    expect(await f.ledger.available(binding)).toBe(true)
    expect(f.data().rows[0]).toMatchObject({
      state: 'unknown',
      reconciliation: { accountRevision: 'account-fixture-1', targetRevision: null }
    })
    await expect(f.ledger.acknowledge(inspected.id, read, () => binding)).rejects.toThrow('Inspect')
    await f.ledger.record(row(1))
    expect(f.data().rows[0].state).toBe('unknown')
    await f.ledger.settle('decision-1', { state: 'cancelled' })
    const restarted = fixture(f.data().rows)
    expect(await restarted.ledger.available(binding)).toBe(true)
    expect(restarted.data().rows[0].state).toBe('unknown')
  })

  it.each(['provider', 'accountRevision', 'policyRevision'] as const)(
    'invalidates recovery acknowledgment on %s change',
    async (key) => {
      const f = fixture([
        { ...row(), state: 'unknown', targetType: 'memory', targetId: 'memory-fixture' }
      ])
      const binding: AgentDecisionAuditBinding = {
        provider: 'openai',
        accountRevision: 'account-fixture-1',
        policyRevision: 'desktop-reviewed-auto-v1'
      }
      const read = vi.fn(async () => ({ resourceRevision: 'b'.repeat(16), targetRevision: null }))
      const inspected = await f.ledger.inspect(read, () => binding)
      if (key === 'provider') binding.provider = 'openrouter'
      else binding[key] = 'changed-fixture'
      await expect(f.ledger.acknowledge(inspected.id, read, () => binding)).rejects.toThrow(
        'changed'
      )
      expect(await f.ledger.available(binding)).toBe(false)
      expect(f.data().rows[0].reconciliation).toBeUndefined()
    }
  )

  it('rejects recovery if the inspected resource changed or cannot be bound', async () => {
    const binding = {
      provider: 'openai' as const,
      accountRevision: 'account-fixture-1',
      policyRevision: 'desktop-reviewed-auto-v1'
    }
    const f = fixture([
      { ...row(), state: 'unknown', targetType: 'memory', targetId: 'memory-fixture' }
    ])
    let revision = 'b'.repeat(16)
    const read = vi.fn(async () => ({ resourceRevision: revision, targetRevision: null }))
    const inspected = await f.ledger.inspect(read, () => binding)
    revision = 'c'.repeat(16)
    await expect(f.ledger.acknowledge(inspected.id, read, () => binding)).rejects.toThrow('changed')
    expect(await f.ledger.available(binding)).toBe(false)
    const unbound = fixture([{ ...row(), state: 'unknown' }])
    const metadata = await unbound.ledger.inspect(read, () => binding)
    expect(metadata.canAcknowledge).toBe(false)
    expect(metadata.reasonCode).toBe('audit_target_unbound')
    await expect(unbound.ledger.acknowledge(metadata.id, read, () => binding)).rejects.toThrow(
      'Inspect'
    )
  })

  it('keeps recovery Manual when the acknowledgment save fails', async () => {
    const f = fixture([
      { ...row(), state: 'unknown', targetType: 'memory', targetId: 'memory-fixture' }
    ])
    const binding = {
      provider: 'openai' as const,
      accountRevision: 'account-fixture-1',
      policyRevision: 'desktop-reviewed-auto-v1'
    }
    const read = vi.fn(async () => ({ resourceRevision: 'b'.repeat(16), targetRevision: null }))
    const inspected = await f.ledger.inspect(read, () => binding)
    f.persistence.save.mockRejectedValueOnce(new Error('offline save failure'))
    await expect(f.ledger.acknowledge(inspected.id, read, () => binding)).rejects.toThrow(
      'save failure'
    )
    expect(await f.ledger.available(binding)).toBe(false)
    expect(f.data().rows[0].reconciliation).toBeUndefined()
  })

  it('never evicts unresolved records to make space', async () => {
    const f = fixture()
    for (let index = 0; index < MAX_DECISION_LEDGER_ROWS; index++) await f.ledger.record(row(index))
    await expect(f.ledger.record(row(MAX_DECISION_LEDGER_ROWS))).rejects.toThrow('unresolved')
    expect(f.data().rows).toHaveLength(MAX_DECISION_LEDGER_ROWS)
    expect(f.data().rows[0].id).toBe('decision-0')
  })

  it.each(['arguments', 'userRequest', 'before', 'after', 'reasoning', 'responseBody'])(
    'rejects raw %s content',
    (key) => {
      expect(() =>
        decodeAgentDecisionLedger(
          JSON.stringify({ version: 1, rows: [{ ...row(), [key]: 'ordinary private payload' }] })
        )
      ).toThrow('audit row')
    }
  )
})
