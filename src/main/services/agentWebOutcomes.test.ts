import { describe, expect, it, vi } from 'vitest'
import {
  createAgentWebOutcomes,
  decodeAgentWebOutcomes,
  type AgentWebOutcomeRecord
} from './agentWebOutcomes'
vi.mock('electron', () => ({ app: { getPath: () => '/unopened-fixture' } }))
vi.mock('./agentPersistence', () => ({ createAgentPersistence: () => ({}) }))
vi.mock('./atomicPersistence', () => ({ hasUncertainAtomicWrites: () => false }))
const pending: AgentWebOutcomeRecord = {
  sessionId: 'session',
  runId: 'run',
  callId: 'call',
  provider: 'deepseek',
  operationDigest: 'a'.repeat(64),
  requestState: 'unknown',
  outcome: 'pending',
  intentAt: '2026-10-18T01:00:00.000Z'
}
function fixture(records: AgentWebOutcomeRecord[] = []) {
  let data = { version: 1 as const, records: structuredClone(records) }
  const save = vi.fn(async (next: typeof data) => {
    data = structuredClone(next)
  })
  const ledger = createAgentWebOutcomes({
    load: async () => ({ data: structuredClone(data), writable: true }),
    assertWritable: () => {},
    save
  })
  return { ledger, save, data: () => data }
}
describe('durable paid web intent and outcomes', () => {
  it('persists minimal identity only, prohibits replay and settles independent of owner cancellation', async () => {
    const f = fixture()
    await f.ledger.intent(pending)
    expect(f.ledger.records()).toEqual([pending])
    expect(f.ledger.uncertain(pending.operationDigest)).toBe(true)
    await expect(f.ledger.intent(pending)).rejects.toThrow('replayed')
    await f.ledger.settle({
      ...pending,
      outcome: 'confirmed',
      requestState: 'response_received',
      settledAt: '2026-10-18T01:00:01.000Z'
    })
    expect(f.ledger.uncertain(pending.operationDigest)).toBe(false)
    expect(JSON.stringify(f.data())).not.toMatch(/query|apiKey|authorization|content/)
  })
  it('projects crash-time pending intents as unknown and never invents non-delivery or replays', async () => {
    const f = fixture([pending])
    await f.ledger.load()
    expect(f.ledger.records()[0]).toMatchObject({
      outcome: 'unknown',
      requestState: 'unknown',
      settledAt: expect.any(String)
    })
    expect(f.ledger.uncertain(pending.operationDigest)).toBe(true)
    expect(f.save).toHaveBeenCalledOnce()
    await expect(f.ledger.intent(pending)).rejects.toThrow('replayed')
  })
  it('suspends on uncertain intent or outcome persistence', async () => {
    const f = fixture()
    f.save.mockRejectedValueOnce(new Error('disk failed'))
    await expect(f.ledger.intent(pending)).rejects.toThrow('could not be confirmed')
    expect(() => f.ledger.assertWritable()).toThrow('unavailable')
    const g = fixture()
    await g.ledger.intent(pending)
    g.save.mockRejectedValueOnce(new Error('disk failed'))
    await expect(
      g.ledger.settle({ ...pending, outcome: 'unknown', settledAt: '2026-10-18T01:00:01.000Z' })
    ).rejects.toThrow('could not be confirmed')
    expect(() => g.ledger.assertWritable()).toThrow('unavailable')
  })
  it('rejects arbitrary body fields, mixed receipt claims and duplicate identities', () => {
    const encode = (records: unknown[]) => JSON.stringify({ version: 1, records })
    expect(() => decodeAgentWebOutcomes(encode([{ ...pending, apiKey: 'never' }]))).toThrow()
    expect(() =>
      decodeAgentWebOutcomes(
        encode([
          {
            ...pending,
            outcome: 'confirmed',
            requestState: 'not_started',
            settledAt: '2026-10-18T01:00:01.000Z'
          }
        ])
      )
    ).toThrow()
    expect(() => decodeAgentWebOutcomes(encode([pending, pending]))).toThrow()
  })
})
