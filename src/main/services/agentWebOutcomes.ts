import { app } from 'electron'
import { join } from 'node:path'
import { createAgentPersistence } from './agentPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import { hasUncertainAtomicWrites } from './atomicPersistence'
import type { AgentWebCallEvidence } from '../../shared/agentWeb'

export interface AgentWebOutcomeRecord extends AgentWebCallEvidence {
  sessionId: string
  callId: string
}
interface Data {
  version: 1
  records: AgentWebOutcomeRecord[]
}
interface Persistence {
  load(): Promise<{ data: Data; writable: boolean }>
  assertWritable(): void
  save(data: Data): Promise<void>
}
export function decodeAgentWebOutcomes(raw: string): Data {
  if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('Web outcome audit is oversized')
  const data = JSON.parse(raw) as Data
  if (
    !data ||
    data.version !== 1 ||
    Object.keys(data).sort().join(',') !== 'records,version' ||
    !Array.isArray(data.records) ||
    data.records.length > 128
  )
    throw new Error('Invalid web outcome audit')
  const ids = new Set<string>()
  for (const row of data.records) {
    if (
      !row ||
      Object.keys(row).some(
        (key) =>
          ![
            'runId',
            'operationDigest',
            'provider',
            'requestState',
            'outcome',
            'intentAt',
            'settledAt',
            'checkpointUnconfirmed',
            'sessionId',
            'callId'
          ].includes(key)
      ) ||
      !['runId', 'sessionId', 'callId'].every(
        (key) =>
          typeof row[key] === 'string' &&
          row[key].length > 0 &&
          row[key].length <= 256 &&
          !/[\u0000-\u001f]/.test(row[key])
      ) ||
      !/^[a-f0-9]{64}$/.test(row.operationDigest) ||
      row.provider !== 'deepseek' ||
      !['not_started', 'unknown', 'response_received'].includes(row.requestState) ||
      !['pending', 'not-sent', 'confirmed', 'unknown'].includes(row.outcome) ||
      ['intentAt', 'settledAt'].some(
        (key) =>
          row[key] !== undefined &&
          (typeof row[key] !== 'string' ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row[key]))
      ) ||
      (row.checkpointUnconfirmed !== undefined && typeof row.checkpointUnconfirmed !== 'boolean')
    )
      throw new Error('Invalid web outcome record')
    if (
      !row.intentAt ||
      (row.outcome === 'pending'
        ? row.requestState !== 'unknown' || row.settledAt !== undefined
        : !row.settledAt ||
          (row.outcome === 'not-sent'
            ? row.requestState !== 'not_started'
            : row.outcome === 'confirmed'
              ? row.requestState !== 'response_received'
              : row.requestState !== 'unknown'))
    )
      throw new Error('Conflicting web outcome receipt state')
    const id = JSON.stringify([row.sessionId, row.runId, row.callId])
    if (ids.has(id)) throw new Error('Duplicate web outcome record')
    ids.add(id)
  }
  return data
}
export function createAgentWebOutcomes(persistence: Persistence) {
  let data: Data
  let loading: Promise<void>
  let writable = false
  let chain: Promise<unknown> = Promise.resolve()
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = chain.catch(() => {}).then(operation)
    chain = pending.catch(() => {})
    return pending
  }
  async function load() {
    if (!loading)
      loading = (async () => {
        const stored = await persistence.load()
        data = structuredClone(stored.data)
        writable = stored.writable
        let changed = false
        for (const row of data.records)
          if (row.outcome === 'pending') {
            row.outcome = 'unknown'
            row.requestState = 'unknown'
            row.settledAt = new Date().toISOString()
            changed = true
          }
        if (changed && writable) {
          try {
            await persistence.save(data)
          } catch {
            writable = false
          }
        }
      })()
    await loading
  }
  function assertWritable() {
    if (!data || !writable || hasUncertainAtomicWrites())
      throw new Error(
        'Web outcome audit is unavailable; resolve storage before another web request.'
      )
    persistence.assertWritable()
  }
  async function intent(row: AgentWebOutcomeRecord) {
    return queue(async () => {
      await load()
      assertWritable()
      if (
        data.records.some(
          (item) =>
            item.sessionId === row.sessionId &&
            item.runId === row.runId &&
            item.callId === row.callId
        )
      )
        throw new Error('This web request already has a durable intent; it will not be replayed.')
      const next = structuredClone(data)
      // Unknown records are retained; only confirmed/not-sent history can make room.
      while (next.records.length >= 128) {
        const index = next.records.findIndex(
          (item) => item.outcome === 'confirmed' || item.outcome === 'not-sent'
        )
        if (index < 0)
          throw new Error('Web outcome audit capacity requires inspection of unresolved requests.')
        next.records.splice(index, 1)
      }
      next.records.push(structuredClone(row))
      decodeAgentWebOutcomes(JSON.stringify(next))
      try {
        await persistence.save(next)
        data = next
        assertWritable()
      } catch {
        writable = false
        throw new Error('Web intent persistence could not be confirmed')
      }
    })
  }
  async function settle(row: AgentWebOutcomeRecord) {
    return queue(async () => {
      await load()
      assertWritable()
      const next = structuredClone(data)
      const index = next.records.findIndex(
        (item) =>
          item.sessionId === row.sessionId &&
          item.runId === row.runId &&
          item.callId === row.callId &&
          item.operationDigest === row.operationDigest
      )
      if (index < 0) return // No intent means the provider was never admitted.
      next.records[index] = structuredClone(row)
      decodeAgentWebOutcomes(JSON.stringify(next))
      try {
        await persistence.save(next)
        data = next
        assertWritable()
      } catch {
        writable = false
        throw new Error('Web outcome settlement could not be confirmed')
      }
    })
  }
  return {
    load,
    assertWritable,
    intent,
    settle,
    records: () => structuredClone(data?.records || []),
    uncertain: (digest: string) =>
      data?.records.some(
        (row) =>
          row.operationDigest === digest && (row.outcome === 'pending' || row.outcome === 'unknown')
      ),
    drain: () => chain
  }
}
const persistence = createAgentPersistence<Data>({
  path: () => join(app.getPath('userData'), 'agent-web-outcomes.json'),
  label: 'Agent web outcomes',
  decode: decodeAgentWebOutcomes,
  empty: () => ({ version: 1, records: [] })
})
export const agentWebOutcomes = createAgentWebOutcomes({
  load: () => withAgentPersistenceOperation(() => persistence.load()),
  assertWritable: () => persistence.assertWritable(),
  save: (data) => withAgentPersistenceOperation(() => persistence.save(data))
})
