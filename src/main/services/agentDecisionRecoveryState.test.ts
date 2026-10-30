import { describe, expect, it, vi } from 'vitest'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import {
  createDecisionLedger,
  type AgentDecisionAuditBinding,
  type AgentDecisionLedgerRow
} from './agentDecisionLedger'

vi.mock('electron', () => ({ app: { getPath: () => '/unused-offline-recovery-fixture' } }))

const binding: AgentDecisionAuditBinding = {
  provider: 'openai',
  accountRevision: 'account-fixture',
  policyRevision: AUTO_REVIEW_POLICY_REVISION
}
const read = async () => ({ resourceRevision: 'b'.repeat(16), targetRevision: null })
function unknown(id = 'decision-fixture'): AgentDecisionLedgerRow {
  return {
    id,
    sessionId: 'previous-session',
    runId: 'run-fixture',
    callBinding: 'a'.repeat(64),
    snapshotBinding: 'b'.repeat(64),
    tool: 'create_memory',
    policyRevision: binding.policyRevision,
    provider: 'openai',
    model: 'gpt-6-luna',
    reasonCode: 'requirements_met',
    recommendation: 'allow',
    source: 'automatic',
    state: 'unknown',
    createdAt: '2026-10-30T00:00:00.000Z',
    targetType: 'memory',
    targetId: 'memory-fixture'
  }
}
function fixture(rows: AgentDecisionLedgerRow[] = []) {
  let stored = { version: 1 as const, rows: structuredClone(rows) }
  const persistence = {
    load: async () => ({ data: structuredClone(stored), writable: true }),
    assertWritable: vi.fn(),
    confirmed: vi.fn(() => true),
    save: vi.fn(async (value: typeof stored) => {
      stored = structuredClone(value)
    })
  }
  return {
    ledger: createDecisionLedger(persistence),
    persistence,
    rows: () => structuredClone(stored.rows)
  }
}
async function recovered() {
  const f = fixture([unknown()])
  const inspection = await f.ledger.inspect(read, () => binding)
  expect(inspection.recoveryRequired).toBe(true)
  await f.ledger.acknowledge(inspection.id, read, () => binding)
  return f
}

describe('ordinary audit recovery status for Auto activation', () => {
  it('keeps reconciled history visible without requiring recovery again, including restart', async () => {
    const f = await recovered()
    for (const ledger of [f.ledger, fixture(f.rows()).ledger]) {
      const inspection = await ledger.inspect(read, () => binding)
      expect(inspection.recoveryRequired).toBe(false)
      expect(inspection.rows).toHaveLength(1)
      expect(inspection.rows[0]).toMatchObject({ outcome: 'unknown' })
      expect(inspection.rows[0]).not.toHaveProperty('reconciliation')
      expect(await ledger.available(binding)).toBe(true)
    }
    expect(f.rows()[0]).toMatchObject({ state: 'unknown', reconciliation: binding })
  })

  it.each(['provider', 'accountRevision', 'policyRevision'] as const)(
    'requires recovery again when the selected %s changes',
    async (key) => {
      const f = await recovered()
      const changed = { ...binding }
      if (key === 'provider') changed.provider = 'openrouter'
      else changed[key] = 'changed-fixture'
      const inspection = await f.ledger.inspect(read, () => changed)
      expect(inspection.recoveryRequired).toBe(true)
      expect(await f.ledger.available(changed)).toBe(false)
    }
  )

  it('still requires recovery for a new unknown outcome from another session', async () => {
    const f = await recovered()
    const fresh = { ...unknown('new-decision'), sessionId: 'different-session' }
    const ledger = fixture([...f.rows(), fresh]).ledger
    const inspection = await ledger.inspect(read, () => binding)
    expect(inspection.recoveryRequired).toBe(true)
    expect(inspection.rows).toHaveLength(2)
    expect(await ledger.available(binding)).toBe(false)
  })

  it('does not treat an in-flight commit as reconciled history', async () => {
    const f = fixture()
    const row = { ...unknown(), state: 'reviewed' as const }
    await f.ledger.record(row)
    await f.ledger.settle(row.id, { state: 'commit_started' })
    const inspection = await f.ledger.inspect(read, () => binding)
    expect(inspection.recoveryRequired).toBe(true)
    expect(inspection.rows).toHaveLength(1)
  })

  it('keeps unbound or unavailable unknown targets in recovery', async () => {
    const row = unknown()
    delete row.targetId
    const unbound = await fixture([row]).ledger.inspect(read, () => binding)
    expect(unbound).toMatchObject({ recoveryRequired: true, canAcknowledge: false })
    const unavailable = await fixture([unknown()]).ledger.inspect(
      async () => {
        throw new Error('Ordinary offline resource unavailable')
      },
      () => binding
    )
    expect(unavailable).toMatchObject({ recoveryRequired: true, canAcknowledge: false })
  })

  it('does not conflate recovered history with storage or durability availability', async () => {
    const f = await recovered()
    f.persistence.confirmed.mockReturnValue(false)
    expect((await f.ledger.inspect(read, () => binding)).recoveryRequired).toBe(false)
    expect(await f.ledger.available(binding)).toBe(false)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
    f.persistence.confirmed.mockReturnValue(true)
    f.ledger.suspend()
    expect((await f.ledger.inspect(read, () => binding)).recoveryRequired).toBe(false)
    expect(await f.ledger.available(binding)).toBe(false)
    expect(() => f.ledger.assertAutomaticAdmission(binding)).toThrow('recovery')
  })

  it('does not publish inspection for a changed binding', async () => {
    const current = { ...binding }
    const f = fixture([unknown()])
    await expect(
      f.ledger.inspect(
        async () => {
          current.accountRevision = 'changed-during-inspection'
          return read()
        },
        () => ({ ...current })
      )
    ).rejects.toThrow('changed during inspection')
  })
})
