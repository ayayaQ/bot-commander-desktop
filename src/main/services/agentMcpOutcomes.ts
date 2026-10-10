import fs from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { AgentSession } from '../../shared/agentTypes'
import { closeInterruptedHistory, type ToolCall, type ToolResult } from '@ayayaq/vivi'
import {
  assertMcpJson,
  assertMcpOperationCurrent,
  mcpDigest,
  mcpFailure,
  type McpPreparedOperation
} from '@ayayaq/vivi/extensions/mcp'
import { createAgentPersistence, reportAgentPersistenceNotice } from './agentPersistence'
import { hasUncertainAtomicWrites } from './atomicPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'

export const MAX_AGENT_MCP_OUTCOME_RECORDS = 64
export const MAX_AGENT_MCP_OUTCOME_BYTES = 8 * 1024 * 1024
const MAX_RESULT_BYTES = 64 * 1024
const MAX_ARGUMENT_BYTES = 16 * 1024
const MAX_RECORD_BYTES = 192 * 1024
// A pending attempt must have room for the worst escaped bounded result, before any send.
const RESULT_RESERVATION_BYTES = 2 * MAX_RESULT_BYTES + 1024

type OutcomeState = 'pending' | 'not-sent' | 'confirmed' | 'unknown'
export interface AgentMcpOutcomeScope {
  sessionId: string
  runId: string
}
export interface AgentMcpOutcome {
  result: ToolResult
  outcome: Exclude<OutcomeState, 'pending'>
  requestSent?: boolean
  unknownOutcome: boolean
  doNotRetry: boolean
  checkpointUnconfirmed?: boolean
}
export interface AgentMcpOutcomeRecord extends AgentMcpOutcomeScope {
  call: ToolCall
  operationDigest: string
  serverId: string
  catalogKind: 'tools' | 'resources'
  remoteKey: string
  intentAt?: string
  settledAt?: string
  outcome: OutcomeState
  // An unsettled durable intent proves neither delivery nor non-delivery.
  requestSent?: boolean
  unknownOutcome?: boolean
  doNotRetry?: boolean
  checkpointUnconfirmed?: boolean
  result?: ToolResult
}
interface LedgerData {
  version: 1
  records: AgentMcpOutcomeRecord[]
}
interface LedgerOptions {
  /** A private userData/agent-mcp/outcomes.json path, resolved by the host. */
  path: string | (() => string)
  /** Synchronous privacy assertion. Never provide approval or credential stores. */
  assertAllowed: (value: unknown) => void
}
const recordKeys = new Set([
  'sessionId',
  'runId',
  'call',
  'operationDigest',
  'serverId',
  'catalogKind',
  'remoteKey',
  'intentAt',
  'settledAt',
  'outcome',
  'requestSent',
  'unknownOutcome',
  'doNotRetry',
  'checkpointUnconfirmed',
  'result'
])
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}
function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 32 &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}
function assertPrivacy(assertAllowed: LedgerOptions['assertAllowed'], value: unknown): void {
  // Validation precedes the clone: getters, custom prototypes and cyclic values cannot run.
  const frozen = freezeJson(structuredClone(value))
  const returned = assertAllowed(frozen) as unknown
  if (returned !== undefined) {
    if (returned instanceof Promise) void returned.catch(() => undefined)
    throw new Error('MCP privacy assertion must be synchronous')
  }
}
function freezeJson<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeJson(child)
    Object.freeze(value)
  }
  return value
}
function assertScope(scope: AgentMcpOutcomeScope): void {
  assertMcpJson(scope, 1024)
  if (
    !object(scope) ||
    Object.keys(scope).length !== 2 ||
    !text(scope.sessionId, 256) ||
    !text(scope.runId, 256)
  )
    throw new Error('Invalid MCP outcome scope')
}
function identity(
  scope: AgentMcpOutcomeScope,
  operation: McpPreparedOperation
): AgentMcpOutcomeRecord {
  assertScope(scope)
  // Reuse the reviewed binding validator, without treating its checks as authorization.
  assertMcpOperationCurrent(
    operation,
    operation.snapshot,
    operation.binding.launchDigest as string,
    true,
    operation.snapshot.configRevision
  )
  return {
    ...scope,
    call: structuredClone(operation.call),
    operationDigest: operation.binding.operationDigest as string,
    serverId: operation.serverId,
    catalogKind: operation.catalogKind,
    remoteKey: operation.remoteKey,
    outcome: 'pending'
  }
}
function sameIdentity(a: AgentMcpOutcomeRecord, b: AgentMcpOutcomeRecord): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.call.id === b.call.id &&
    a.call.name === b.call.name &&
    mcpDigest(a.call.arguments) === mcpDigest(b.call.arguments) &&
    a.operationDigest === b.operationDigest &&
    a.serverId === b.serverId &&
    a.catalogKind === b.catalogKind &&
    a.remoteKey === b.remoteKey
  )
}
function parseResult(result: ToolResult): Record<string, unknown> {
  assertMcpJson(result, 2 * MAX_RESULT_BYTES + 1024)
  if (
    !object(result) ||
    Object.keys(result).some((key) => !['content', 'isError'].includes(key)) ||
    typeof result.content !== 'string' ||
    Buffer.byteLength(result.content) > MAX_RESULT_BYTES ||
    (result.isError !== undefined && typeof result.isError !== 'boolean')
  )
    throw new Error('Invalid bounded MCP outcome result')
  const body: unknown = JSON.parse(result.content)
  assertMcpJson(body, MAX_RESULT_BYTES)
  if (
    !object(body) ||
    body.source !== 'mcp' ||
    body.untrusted !== true ||
    typeof body.success !== 'boolean'
  )
    throw new Error('Invalid MCP result projection')
  return body
}
function resultFor(record: AgentMcpOutcomeRecord): ToolResult {
  if (!record.result) throw new Error('MCP outcome has no result')
  const body = parseResult(record.result)
  if (
    (body.requestSent !== undefined && body.requestSent !== record.requestSent) ||
    (body.unknownOutcome !== undefined &&
      body.unknownOutcome !== (record.unknownOutcome === true)) ||
    (body.doNotRetry !== undefined && body.doNotRetry !== (record.doNotRetry === true))
  )
    throw new Error('MCP result has conflicting send/outcome safety fields')
  const projection = {
    ...body,
    ...(record.requestSent !== undefined ? { requestSent: record.requestSent } : {}),
    unknownOutcome: record.unknownOutcome === true,
    doNotRetry: record.doNotRetry === true,
    ...(record.checkpointUnconfirmed ? { checkpointUnconfirmed: true } : {})
  }
  // Reserve this field at admission, so a later failed checkpoint never requires clipping.
  assertMcpJson({ ...projection, checkpointUnconfirmed: true }, MAX_RESULT_BYTES)
  return {
    content: JSON.stringify(projection),
    ...(record.result.isError !== undefined ? { isError: record.result.isError } : {})
  }
}
function assertRecord(record: AgentMcpOutcomeRecord): void {
  assertMcpJson(record, MAX_RECORD_BYTES, { nodes: 16384, depth: 36 })
  if (
    !object(record) ||
    Object.keys(record).some((key) => !recordKeys.has(key)) ||
    !text(record.sessionId, 256) ||
    !text(record.runId, 256) ||
    !object(record.call) ||
    Object.keys(record.call).sort().join(',') !== 'arguments,id,name' ||
    !text(record.call.id, 1024) ||
    !text(record.call.name, 64) ||
    !object(record.call.arguments) ||
    typeof record.operationDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.operationDigest) ||
    typeof record.serverId !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,15}$/.test(record.serverId) ||
    !['tools', 'resources'].includes(record.catalogKind) ||
    !text(record.remoteKey, record.catalogKind === 'tools' ? 256 : 4096) ||
    !['pending', 'not-sent', 'confirmed', 'unknown'].includes(record.outcome) ||
    (record.intentAt !== undefined && !timestamp(record.intentAt)) ||
    (record.settledAt !== undefined && !timestamp(record.settledAt)) ||
    (record.checkpointUnconfirmed !== undefined &&
      typeof record.checkpointUnconfirmed !== 'boolean')
  )
    throw new Error('Invalid MCP outcome record')
  assertMcpJson(record.call.arguments, MAX_ARGUMENT_BYTES)
  if (
    record.catalogKind === 'resources' &&
    (record.call.name !== 'read_mcp_resource' ||
      Object.keys(record.call.arguments).sort().join(',') !== 'serverId,uri' ||
      record.call.arguments.serverId !== record.serverId ||
      record.call.arguments.uri !== record.remoteKey)
  )
    throw new Error('MCP resource outcome differs from its call')
  if (record.outcome === 'pending') {
    if (
      !record.intentAt ||
      record.settledAt !== undefined ||
      record.result !== undefined ||
      record.requestSent !== undefined ||
      record.unknownOutcome !== undefined ||
      record.doNotRetry !== undefined ||
      record.checkpointUnconfirmed !== undefined
    )
      throw new Error('Invalid pending MCP send intent')
    return
  }
  if (
    !record.settledAt ||
    !record.result ||
    (record.outcome !== 'not-sent' && !record.intentAt) ||
    (record.outcome === 'not-sent' && record.requestSent !== false) ||
    (record.outcome === 'confirmed' && record.requestSent !== true) ||
    (record.outcome === 'unknown' &&
      record.requestSent !== undefined &&
      record.requestSent !== true) ||
    record.unknownOutcome !== (record.outcome === 'unknown') ||
    typeof record.doNotRetry !== 'boolean' ||
    (record.outcome === 'unknown' && record.doNotRetry !== true) ||
    (record.doNotRetry &&
      record.outcome !== 'unknown' &&
      !(record.outcome === 'confirmed' && record.result.isError === true))
  )
    throw new Error('Inconsistent MCP outcome safety fields')
  const body = parseResult(record.result)
  if (
    (record.outcome !== 'confirmed' &&
      (body.success !== false || record.result.isError !== true)) ||
    (record.outcome === 'confirmed' &&
      (body.serverId !== record.serverId ||
        body.method !== (record.catalogKind === 'tools' ? 'tools/call' : 'resources/read') ||
        body.remoteKey !== record.remoteKey ||
        !Array.isArray(body.content) ||
        body.content.length > 128 ||
        (record.result.isError === true) === body.success)) ||
    (body.serverId !== undefined && body.serverId !== record.serverId) ||
    (body.method !== undefined &&
      body.method !== (record.catalogKind === 'tools' ? 'tools/call' : 'resources/read')) ||
    (body.remoteKey !== undefined && body.remoteKey !== record.remoteKey) ||
    body.requestSent !== record.requestSent ||
    body.unknownOutcome !== record.unknownOutcome ||
    body.doNotRetry !== record.doNotRetry ||
    (body.checkpointUnconfirmed === true) !== (record.checkpointUnconfirmed === true)
  )
    throw new Error('MCP result differs from its recorded outcome')
  resultFor(record)
}
function decode(raw: string, assertAllowed: LedgerOptions['assertAllowed']): LedgerData {
  if (Buffer.byteLength(raw) > MAX_AGENT_MCP_OUTCOME_BYTES)
    throw new Error('MCP outcome ledger is oversized')
  const data: unknown = JSON.parse(raw)
  assertMcpJson(data, MAX_AGENT_MCP_OUTCOME_BYTES, { nodes: 1024 * 1024, depth: 40 })
  if (
    !object(data) ||
    data.version !== 1 ||
    Object.keys(data).sort().join(',') !== 'records,version' ||
    !Array.isArray(data.records) ||
    data.records.length > MAX_AGENT_MCP_OUTCOME_RECORDS
  )
    throw new Error('Invalid MCP outcome ledger')
  const ids = new Set<string>()
  for (const item of data.records) {
    assertRecord(item as AgentMcpOutcomeRecord)
    const record = item as AgentMcpOutcomeRecord
    const id = JSON.stringify([record.sessionId, record.runId, record.call.id])
    if (ids.has(id)) throw new Error('Duplicate MCP outcome identity')
    ids.add(id)
  }
  assertPrivacy(assertAllowed, data)
  return data as unknown as LedgerData
}
function assertCapacity(data: LedgerData): void {
  if (
    data.records.length > MAX_AGENT_MCP_OUTCOME_RECORDS ||
    Buffer.byteLength(JSON.stringify(data, null, 2)) +
      data.records.filter((record) => record.outcome === 'pending').length *
        RESULT_RESERVATION_BYTES >
      MAX_AGENT_MCP_OUTCOME_BYTES
  )
    throw new Error('MCP outcome ledger capacity needs checkpointed history reconciliation')
}
function unknownAfterRestart(record: AgentMcpOutcomeRecord): AgentMcpOutcomeRecord {
  const next: AgentMcpOutcomeRecord = {
    ...record,
    outcome: 'unknown',
    unknownOutcome: true,
    doNotRetry: true,
    settledAt: new Date().toISOString(),
    result: mcpFailure(
      'mcp_unknown_outcome',
      'Recorded send intent interrupted before confirmation; delivery is unconfirmed. Do not retry automatically.',
      true
    )
  }
  next.result = resultFor(next)
  return next
}

/** Host-owned evidence only. This store contains no approvals and never sends or replays a call. */
export function createAgentMcpOutcomeLedger(options: LedgerOptions) {
  let data: LedgerData = { version: 1, records: [] }
  let dataLoaded = false
  let loading: Promise<void> | undefined
  let chain = Promise.resolve()
  const operations = new Set<Promise<unknown>>()
  function track<T>(pending: Promise<T>): Promise<T> {
    operations.add(pending)
    void pending.then(
      () => operations.delete(pending),
      () => operations.delete(pending)
    )
    return pending
  }
  let unsafeRecovery = false
  let checkpointFailed = false
  let persistedSnapshot: LedgerData | undefined
  let path: string
  const persistence = createAgentPersistence<LedgerData>({
    path: () => path,
    label: 'Agent MCP outcomes',
    decode: (raw) => decode(raw, options.assertAllowed),
    empty: () => ({ version: 1, records: [] }),
    notice: (notice) => {
      // A backup cannot prove that the lost latest primary contained no additional attempt.
      unsafeRecovery = true
      reportAgentPersistenceNotice(notice)
    }
  })
  async function privateDirectory(): Promise<void> {
    path ??= typeof options.path === 'function' ? options.path() : options.path
    if (!isAbsolute(path) || basename(dirname(path)) !== 'agent-mcp')
      throw new Error('MCP outcome ledger requires a private agent-mcp directory')
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const directory = await fs.lstat(dirname(path))
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('MCP outcome ledger directory is unsafe')
    const privateOwner = (stat: { uid: number; mode: number }): boolean =>
      process.platform === 'win32' ||
      ((typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
        (stat.mode & 0o077) === 0)
    if (!privateOwner(directory)) throw new Error('MCP outcome ledger directory is not private')
    for (const file of [path, `${path}.bak`]) {
      try {
        const stat = await fs.lstat(file)
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error('MCP outcome ledger file is unsafe')
        if (!privateOwner(stat)) throw new Error('MCP outcome ledger file is not private')
        if (stat.size > MAX_AGENT_MCP_OUTCOME_BYTES)
          throw new Error('MCP outcome ledger file is oversized')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    // Existing app persistence reopens these owner-protected paths by name. This is
    // not protection against concurrent replacement by a malicious same-user process.
  }
  async function snapshotOnDisk(): Promise<LedgerData | undefined> {
    await privateDirectory()
    let current: LedgerData | undefined
    try {
      current = decode(await fs.readFile(path, 'utf8'), options.assertAllowed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // A valid primary does not authorize destroying a damaged backup on the next save.
    try {
      decode(await fs.readFile(`${path}.bak`, 'utf8'), options.assertAllowed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return current
  }
  async function save(value: LedgerData): Promise<void> {
    const current = await snapshotOnDisk()
    if (
      (current === undefined) !== (persistedSnapshot === undefined) ||
      (current && persistedSnapshot && mcpDigest(current) !== mcpDigest(persistedSnapshot))
    )
      throw new Error('MCP outcome evidence changed outside its committed checkpoint')
    // Reject changed/corrupt/unreadable files instead of letting an ordinary atomic save
    // replace them. Path-based persistence still has the same-user replacement race above.
    await persistence.save(value)
    persistedSnapshot = structuredClone(value)
  }
  function load(): Promise<void> {
    if (!loading)
      loading = track(
        withAgentPersistenceOperation(async () => {
          try {
            // A backup may predate an unconfirmed send. Never let generic recovery
            // replace corrupt/missing primary evidence and erase that ambiguity on restart.
            const primary = await snapshotOnDisk()
            if (!primary) {
              try {
                await fs.lstat(`${path}.bak`)
                throw new Error(
                  'MCP outcome primary is missing; older backup delivery evidence is ambiguous'
                )
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              }
            }
            const stored = await persistence.load()
            data = structuredClone(stored.data)
            dataLoaded = true
            unsafeRecovery ||= !stored.writable
            if (stored.writable) {
              persistedSnapshot = await snapshotOnDisk()
              if (
                (persistedSnapshot && mcpDigest(persistedSnapshot) !== mcpDigest(stored.data)) ||
                (!persistedSnapshot && stored.data.records.length > 0)
              )
                throw new Error('MCP outcome evidence changed during loading')
            }
            const pending = data.records.some((record) => record.outcome === 'pending')
            data.records = data.records.map((record) =>
              record.outcome === 'pending' ? unknownAfterRestart(record) : record
            )
            if (pending && stored.writable) {
              try {
                await save(data)
                checkpointFailed = hasUncertainAtomicWrites()
              } catch {
                checkpointFailed = true
                data.records = data.records.map((record) =>
                  record.outcome === 'unknown'
                    ? {
                        ...record,
                        checkpointUnconfirmed: true,
                        result: resultFor({ ...record, checkpointUnconfirmed: true })
                      }
                    : record
                )
              }
            }
          } catch {
            unsafeRecovery = true
            throw new Error('MCP outcome ledger needs safe file recovery')
          }
        })
      )
    return loading
  }
  function records(): AgentMcpOutcomeRecord[] {
    if (!dataLoaded) throw new Error('MCP outcome ledger has not finished loading')
    return structuredClone(data.records)
  }
  function assertWritable(): void {
    persistence.assertWritable()
    if (!dataLoaded || unsafeRecovery || checkpointFailed || hasUncertainAtomicWrites())
      throw new Error('MCP outcome ledger needs confirmed persistence recovery')
    if (data.records.some((record) => ['pending', 'unknown'].includes(record.outcome)))
      throw new Error('MCP outcome ledger has an unreconciled possible send; do not retry')
    assertCapacity(data)
    if (data.records.length >= MAX_AGENT_MCP_OUTCOME_RECORDS)
      throw new Error('MCP outcome ledger capacity needs checkpointed history reconciliation')
  }
  function queue<T>(work: () => Promise<T>): Promise<T> {
    return track(
      withAgentPersistenceOperation(() => {
        const pending = chain.then(work)
        chain = pending.then(
          () => undefined,
          () => undefined
        )
        return pending
      })
    )
  }
  async function intent(
    scope: AgentMcpOutcomeScope,
    operation: McpPreparedOperation
  ): Promise<void> {
    const captured = { ...identity(scope, operation), intentAt: new Date().toISOString() }
    assertRecord(captured)
    assertPrivacy(options.assertAllowed, captured)
    return queue(async () => {
      await load()
      assertWritable()
      if (
        data.records.some(
          (record) =>
            record.sessionId === captured.sessionId &&
            record.runId === captured.runId &&
            record.call.id === captured.call.id
        )
      )
        throw new Error('MCP call was already recorded; repeated send refused')
      const next: LedgerData = { version: 1, records: [...data.records, captured] }
      assertCapacity(next)
      try {
        await save(next)
        data = next
        if (hasUncertainAtomicWrites()) throw new Error('MCP send intent durability is uncertain')
      } catch {
        checkpointFailed = true
        throw new Error('MCP send intent checkpoint failed; no transport send is permitted')
      }
    })
  }
  async function settle(
    scope: AgentMcpOutcomeScope,
    operation: McpPreparedOperation,
    outcome: AgentMcpOutcome
  ): Promise<void> {
    const captured = identity(scope, operation)
    assertMcpJson(outcome, 2 * MAX_RESULT_BYTES + 2048)
    if (
      !object(outcome) ||
      Object.keys(outcome).some(
        (key) =>
          ![
            'result',
            'outcome',
            'requestSent',
            'unknownOutcome',
            'doNotRetry',
            'checkpointUnconfirmed'
          ].includes(key)
      )
    )
      throw new Error('Invalid MCP outcome settlement')
    const admitted = structuredClone(outcome)
    return queue(async () => {
      await load()
      const index = data.records.findIndex(
        (record) =>
          record.sessionId === captured.sessionId &&
          record.runId === captured.runId &&
          record.call.id === captured.call.id
      )
      const previous = index < 0 ? undefined : data.records[index]
      if (previous && !sameIdentity(previous, captured))
        throw new Error('MCP outcome identity mismatch')
      if (!previous && admitted.outcome !== 'not-sent')
        throw new Error('MCP send intent is missing')
      const nextRecord: AgentMcpOutcomeRecord = {
        ...captured,
        ...(previous?.intentAt ? { intentAt: previous.intentAt } : {}),
        ...admitted,
        settledAt: new Date().toISOString()
      }
      nextRecord.result = resultFor(nextRecord)
      assertRecord(nextRecord)
      assertPrivacy(options.assertAllowed, nextRecord)
      if (previous && previous.outcome !== 'pending') {
        if (
          previous.outcome !== nextRecord.outcome ||
          previous.result?.content !== nextRecord.result.content ||
          previous.result?.isError !== nextRecord.result.isError
        )
          throw new Error('MCP outcome already settled; conflicting result refused')
        return
      }
      const next: LedgerData = { version: 1, records: data.records.slice() }
      if (index < 0) next.records.push(nextRecord)
      else next.records[index] = nextRecord
      assertCapacity(next)
      // Known host output survives a rejected checkpoint in memory, while disk retains intent.
      data = next
      try {
        persistence.assertWritable()
        if (unsafeRecovery) throw new Error('MCP outcome ledger needs safe file recovery')
        await save(next)
        if (hasUncertainAtomicWrites())
          throw new Error('MCP outcome checkpoint durability is uncertain')
      } catch {
        checkpointFailed = true
        nextRecord.checkpointUnconfirmed = true
        nextRecord.result = resultFor(nextRecord)
        throw new Error('MCP outcome checkpoint failed; retained evidence needs reconciliation')
      }
    })
  }
  async function acknowledge(
    scope: AgentMcpOutcomeScope,
    checkpointedSession: AgentSession
  ): Promise<void> {
    assertScope(scope)
    const snapshot = structuredClone(checkpointedSession)
    return queue(async () => {
      await load()
      persistence.assertWritable()
      if (unsafeRecovery || hasUncertainAtomicWrites())
        throw new Error('MCP outcome evidence cannot be removed without confirmed persistence')
      if (scope.sessionId !== snapshot.id)
        throw new Error('MCP history checkpoint session mismatch')
      const remaining = data.records.filter(
        (record) =>
          record.sessionId !== scope.sessionId ||
          record.runId !== scope.runId ||
          record.outcome === 'pending' ||
          !checkpointContains(snapshot, record)
      )
      if (remaining.length === data.records.length) return
      const next: LedgerData = { version: 1, records: remaining }
      try {
        await save(next)
        data = next
        if (hasUncertainAtomicWrites())
          throw new Error('MCP reconciliation durability is uncertain')
        checkpointFailed = false
      } catch {
        checkpointFailed = true
        throw new Error(
          'MCP history acknowledgement checkpoint failed; retained evidence needs recovery'
        )
      }
    })
  }
  async function checkpoint(): Promise<void> {
    return queue(async () => {
      await load()
      persistence.assertWritable()
      if (unsafeRecovery) throw new Error('MCP outcome ledger needs safe file recovery')
      try {
        await save(data)
        if (hasUncertainAtomicWrites())
          throw new Error('MCP outcome checkpoint durability is uncertain')
        checkpointFailed = false
      } catch {
        checkpointFailed = true
        throw new Error('MCP outcome checkpoint failed; retained evidence needs recovery')
      }
    })
  }
  return {
    load,
    intent,
    settle,
    records,
    assertWritable,
    acknowledge,
    checkpoint,
    drain: async (): Promise<void> => {
      const errors: unknown[] = []
      while (operations.size) {
        const settled = await Promise.allSettled([...operations])
        for (const item of settled) if (item.status === 'rejected') errors.push(item.reason)
      }
      if (errors.length)
        throw new AggregateError(errors, 'MCP outcome persistence needs reconciliation')
    }
  }
}

function matched(session: AgentSession, record: AgentMcpOutcomeRecord) {
  if (record.sessionId !== session.id || !Array.isArray(session.history)) return undefined
  const display = session.messages
    .flatMap((message) => (message.toolCalls ?? []).map((call) => ({ message, call })))
    .filter((item) => item.call.id === record.call.id)
  if (display.length !== 1) return undefined
  const { message, call } = display[0]
  const metadata = call.mcp
  if (
    message.role !== 'tool' ||
    (message.toolCalls?.length ?? 0) !== 1 ||
    call.name !== record.call.name ||
    mcpDigest(call.arguments) !== mcpDigest(record.call.arguments) ||
    !metadata ||
    metadata.runId !== record.runId ||
    metadata.operationDigest !== record.operationDigest ||
    metadata.serverId !== record.serverId ||
    metadata.catalogKind !== record.catalogKind ||
    metadata.remoteKey !== record.remoteKey
  )
    return undefined
  const assistantCalls = session.history.flatMap((item, index) =>
    item.kind === 'assistant'
      ? item.toolCalls
          .filter((candidate) => candidate.id === record.call.id)
          .map((candidate) => ({ candidate, index }))
      : []
  )
  const outputs = session.history.filter(
    (item) => item.kind === 'tool_result' && item.callId === record.call.id
  )
  if (assistantCalls.length !== 1 || outputs.length !== 1) return undefined
  const { candidate, index } = assistantCalls[0]
  if (
    candidate.name !== record.call.name ||
    mcpDigest(candidate.arguments) !== mcpDigest(record.call.arguments)
  )
    return undefined
  let resultIndex = index + 1
  while (
    resultIndex < session.history.length &&
    session.history[resultIndex].kind === 'tool_result'
  ) {
    const output = session.history[resultIndex]
    if (
      output.kind === 'tool_result' &&
      output.callId === record.call.id &&
      output.name === record.call.name
    )
      return { message, call, metadata, resultIndex, output }
    resultIndex++
  }
  return undefined
}
/** A confirmed saved host checkpoint is stronger evidence than an older bare send intent. */
function outcomeFromCheckpoint(
  session: AgentSession,
  record: AgentMcpOutcomeRecord
): AgentMcpOutcomeRecord | undefined {
  if (record.outcome !== 'unknown' || record.requestSent !== undefined) return undefined
  const match = matched(session, record)
  if (
    !match ||
    !['confirmed', 'not-sent'].includes(match.metadata.outcome) ||
    match.call.result === undefined ||
    match.message.content !== match.output.content
  )
    return undefined
  try {
    const candidate: AgentMcpOutcomeRecord = {
      ...record,
      outcome: match.metadata.outcome as 'confirmed' | 'not-sent',
      requestSent: match.metadata.requestSent,
      unknownOutcome: false,
      doNotRetry: JSON.parse(match.output.content).doNotRetry === true,
      result: {
        content: match.output.content,
        ...(match.output.isError !== undefined ? { isError: match.output.isError } : {})
      },
      ...(match.metadata.checkpointUnconfirmed ? { checkpointUnconfirmed: true } : {})
    }
    if (!match.metadata.checkpointUnconfirmed) delete candidate.checkpointUnconfirmed
    assertRecord(candidate)
    if (mcpDigest(match.call.result) !== mcpDigest(JSON.parse(match.output.content)))
      return undefined
    const expectedStatus =
      candidate.outcome === 'not-sent' &&
      (match.call.result as Record<string, unknown>).denied === true
        ? 'rejected'
        : candidate.result!.isError
          ? 'error'
          : 'completed'
    if (match.call.status !== expectedStatus) return undefined
    return candidate
  } catch {
    // Generic cancellation, unbound display state, and malformed output cannot promote evidence.
    return undefined
  }
}
function checkpointContains(session: AgentSession, record: AgentMcpOutcomeRecord): boolean {
  record = outcomeFromCheckpoint(session, record) ?? record
  const match = matched(session, record)
  if (!match || !record.result || match.call.result === undefined) return false
  const result = resultFor(record)
  return (
    match.output.content === result.content &&
    match.output.isError === result.isError &&
    match.message.content === result.content &&
    mcpDigest(match.call.result) === mcpDigest(JSON.parse(result.content)) &&
    match.metadata.outcome === record.outcome &&
    match.metadata.requestSent === record.requestSent &&
    match.metadata.checkpointUnconfirmed === record.checkpointUnconfirmed
  )
}

/** Pure terminal/restart reconciliation. Matching requires host metadata and actual call history. */
export function reconcileAgentMcpOutcomes(
  session: AgentSession,
  records: readonly AgentMcpOutcomeRecord[]
): AgentSession {
  const result = structuredClone(session)
  if (!Array.isArray(result.history)) return result
  result.history = closeInterruptedHistory(result.history)
  const ids = new Set<string>()
  const ambiguous = new Set<string>()
  for (const record of records) {
    assertRecord(record)
    const id = JSON.stringify([record.sessionId, record.runId, record.call.id])
    if (ids.has(id)) ambiguous.add(id)
    ids.add(id)
  }
  for (const storedRecord of records) {
    const record = outcomeFromCheckpoint(result, storedRecord) ?? storedRecord
    if (
      record.outcome === 'pending' ||
      ambiguous.has(JSON.stringify([record.sessionId, record.runId, record.call.id]))
    )
      continue
    const match = matched(result, record)
    if (!match) continue
    const projection = resultFor(record)
    result.history[match.resultIndex] = {
      kind: 'tool_result',
      callId: record.call.id,
      name: record.call.name,
      ...projection
    }
    const body = JSON.parse(projection.content)
    match.call.result = body
    match.call.status =
      record.outcome === 'not-sent' && body.denied === true
        ? 'rejected'
        : projection.isError
          ? 'error'
          : 'completed'
    match.call.error = projection.isError
      ? record.outcome === 'unknown'
        ? 'Outcome unconfirmed; do not retry automatically'
        : record.outcome === 'not-sent'
          ? 'Not attempted'
          : record.doNotRetry
            ? 'MCP server returned an error; effects were not verified. Do not retry automatically'
            : 'MCP server returned an error'
      : undefined
    match.call.mcp = {
      ...match.metadata,
      outcome: record.outcome,
      ...(record.requestSent !== undefined ? { requestSent: record.requestSent } : {}),
      ...(record.checkpointUnconfirmed ? { checkpointUnconfirmed: true } : {})
    }
    // Avoid retaining a previous false delivery claim or stale checkpoint marker.
    if (record.requestSent === undefined) delete match.call.mcp!.requestSent
    if (!record.checkpointUnconfirmed) delete match.call.mcp!.checkpointUnconfirmed
    match.message.content = projection.content
  }
  return result
}
