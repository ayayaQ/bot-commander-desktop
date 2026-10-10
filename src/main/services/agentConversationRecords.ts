// SPDX-License-Identifier: Apache-2.0
// Bounded shadow migration. Session/display storage and the exact MCP ledger remain authoritative.
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { AgentAcceptedUpdate, AgentResult, Usage } from '@ayayaq/vivi'
import { assertMcpJson } from '@ayayaq/vivi/extensions/mcp'
import {
  AGENT_RECORD_LIMITS,
  agentArgumentsDigest,
  createRunSettlement,
  decodeAgentRecord,
  projectAgentRecords,
  type AgentHistoryEntry,
  type AgentOutcomeEvidence,
  type AgentProjection,
  type DurableAgentRecord
} from '@ayayaq/vivi/events'
import {
  AGENT_RUN_RECORD_LIMITS,
  applyAgentRunRecord,
  assertAgentRunCurrent,
  createAgentAcceptedRecord,
  createAgentRunProjection,
  createAgentRunStart,
  createAgentRunTerminal,
  projectAgentRunRecords,
  type AgentRunProjection,
  type AgentRunRecord
} from '@ayayaq/vivi/events/stream'
import type { AgentSession } from '../../shared/agentTypes'
import type { AgentMcpOutcomeRecord } from './agentMcpOutcomes'
import { atomicWrite } from './atomicPersistence'
import { reportAgentPersistenceNotice } from './agentPersistence'

// Includes repeated terminal wrappers and all retained runs, not just one core chain.
// The existing host credential screen admits at most 8 MiB. This stricter host envelope
// budget includes repeated terminal wrappers and never assumes the core's 64 MiB maximum.
export const AGENT_CONVERSATION_BYTES = 8 * 1024 * 1024
const MAX_RUNS = 128
const TERMINAL_RESERVATION = 3 * 1024 * 1024
// Cumulative history and answer content are repeated in the strict 1 MiB terminal.
const ACTIVE_HISTORY_BYTES = 384 * 1024

export interface AgentConversationJournal {
  version: 1
  sessionId: string
  state: 'shadow'
  /** Legacy cumulative input/output/cache counts were never stored by Desktop. */
  usageBasis: { legacyTotalTokens: number; inputOutput: 'since_anchor' }
  sessionRecords: DurableAgentRecord[]
  runs: { runId: string; baseSequence: number; records: AgentRunRecord[] }[]
}
interface Quarantine {
  version: 1
  sessionDigest: string
  state: 'quarantined'
  reason: 'privacy'
}
type Stored = AgentConversationJournal | Quarantine
interface Options {
  path: (sessionId: string) => string
  assertAllowed: (value: unknown) => void
  outcomes?: () => readonly AgentMcpOutcomeRecord[]
  notice?: (message: string) => void
}
interface Owner {
  raw: string | null
  journal?: AgentConversationJournal
  projection?: AgentProjection
  active?: AgentRunProjection
  disabled: boolean
}
class ConversationPrivacyError extends Error {}
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).sort().join(',') === names.sort().join(',')
}
async function read(path: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    if (Buffer.byteLength(raw) > AGENT_CONVERSATION_BYTES)
      throw new Error('Conversation shadow exceeds its encoded limit')
    return raw
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Complete-chain replay only. Never trust a serialized projection or a guessed anchor. */
export function decodeAgentConversationJournal(raw: string, sessionId: string): Stored {
  if (Buffer.byteLength(raw) > AGENT_CONVERSATION_BYTES)
    throw new Error('Conversation shadow exceeds its encoded limit')
  const value: unknown = JSON.parse(raw)
  if (!object(value) || value.version !== 1)
    throw new Error('Unsupported conversation shadow envelope')
  if (value.state === 'quarantined') {
    if (
      !keys(value, ['version', 'sessionDigest', 'state', 'reason']) ||
      value.sessionDigest !== hash(sessionId) ||
      value.reason !== 'privacy'
    )
      throw new Error('Invalid conversation quarantine')
    return value as unknown as Quarantine
  }
  if (
    value.state !== 'shadow' ||
    value.sessionId !== sessionId ||
    !keys(value, ['version', 'sessionId', 'state', 'usageBasis', 'sessionRecords', 'runs']) ||
    !object(value.usageBasis) ||
    !keys(value.usageBasis, ['legacyTotalTokens', 'inputOutput']) ||
    value.usageBasis.inputOutput !== 'since_anchor' ||
    !Number.isSafeInteger(value.usageBasis.legacyTotalTokens) ||
    (value.usageBasis.legacyTotalTokens as number) < 0 ||
    !Array.isArray(value.sessionRecords) ||
    !value.sessionRecords.length ||
    !Array.isArray(value.runs) ||
    value.runs.length > MAX_RUNS
  )
    throw new Error('Invalid conversation shadow envelope')
  projectAgentRecords(sessionId, value.sessionRecords)
  const seen = new Set<string>()
  for (const run of value.runs) {
    if (
      !object(run) ||
      !keys(run, ['runId', 'baseSequence', 'records']) ||
      typeof run.runId !== 'string' ||
      seen.has(run.runId) ||
      !Number.isSafeInteger(run.baseSequence) ||
      (run.baseSequence as number) < 1 ||
      (run.baseSequence as number) > value.sessionRecords.length ||
      !Array.isArray(run.records) ||
      !run.records.length
    )
      throw new Error('Invalid retained conversation run')
    seen.add(run.runId)
    const base = projectAgentRecords(
      sessionId,
      value.sessionRecords.slice(0, run.baseSequence as number)
    )
    const projected = projectAgentRunRecords(base, run.runId, run.records)
    if (projected.state === 'settled') {
      const terminal = run.records.at(-1) as AgentRunRecord
      if (
        terminal.type !== 'run_settled' ||
        !same(terminal.terminal, value.sessionRecords[run.baseSequence as number])
      )
        throw new Error('Run terminal differs from its independent session checkpoint')
    }
  }
  return value as unknown as AgentConversationJournal
}

function entry(session: AgentSession, message: unknown, index: number): AgentHistoryEntry {
  // Canonical history had no message IDs. Keep its original indexed source; never rewrite
  // the independent display IDs, validation evidence, title or metadata in the main file.
  return {
    id: `history:${index}`,
    source: {
      reference: `desktop/session/${session.id}/history/${index}`,
      revision: hash(message)
    },
    message: structuredClone(message) as AgentHistoryEntry['message']
  }
}
function history(
  session: AgentSession,
  prior: readonly AgentHistoryEntry[] = []
): AgentHistoryEntry[] {
  return (session.history || []).map((message, index) =>
    prior[index] && same(prior[index].message, message)
      ? prior[index]
      : entry(session, message, index)
  )
}
function addUsage(prior: Readonly<Usage>, next: Readonly<Usage>, totalTokens: number): Usage {
  return {
    inputTokens: prior.inputTokens + next.inputTokens,
    outputTokens: prior.outputTokens + next.outputTokens,
    totalTokens,
    ...(prior.cachedInputTokens !== undefined && next.cachedInputTokens !== undefined
      ? { cachedInputTokens: prior.cachedInputTokens + next.cachedInputTokens }
      : {}),
    ...(prior.cacheWriteInputTokens !== undefined && next.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: prior.cacheWriteInputTokens + next.cacheWriteInputTokens }
      : {})
  }
}

/** Map only exact validated host ledger records. Generic tool strings supply no effect fact. */
export function agentConversationOutcomes(
  session: AgentSession,
  records: readonly AgentMcpOutcomeRecord[],
  prior: readonly AgentOutcomeEvidence[] = []
): AgentOutcomeEvidence[] {
  const output = [...prior]
  const calls = (session.history || []).flatMap((message) =>
    message.kind === 'assistant' ? message.toolCalls : []
  )
  for (const record of records.filter((item) => item.sessionId === session.id)) {
    const call = calls.find((item) => item.id === record.call.id)
    if (
      !call ||
      call.name !== record.call.name ||
      agentArgumentsDigest(call.arguments) !== agentArgumentsDigest(record.call.arguments)
    )
      throw new Error('Conversation evidence differs from exact historical MCP call')
    const before = output.find((item) => item.callId === call.id)
    const candidate: AgentOutcomeEvidence = {
      callId: call.id,
      runId: record.runId,
      name: call.name,
      argumentsDigest: agentArgumentsDigest(record.call.arguments),
      status:
        record.outcome === 'confirmed'
          ? record.result?.isError
            ? 'failed'
            : 'succeeded'
          : record.outcome === 'not-sent'
            ? 'failed'
            : 'unknown',
      effect:
        record.outcome === 'not-sent'
          ? 'not_attempted'
          : record.outcome === 'confirmed'
            ? 'confirmed'
            : 'unknown',
      source: { reference: `desktop/mcp/${record.operationDigest}`, revision: hash(record) }
    }
    // Existing receipts stay immutable. Refinement is a later explicitly reviewed slice.
    if (before) {
      if (!same(before, candidate))
        throw new Error('Conversation MCP evidence needs reconciliation')
    } else output.push(candidate)
  }
  return output
}

/** Serialized host-owned shadow writes. Nothing here acknowledges an MCP sidecar. */
export function createAgentConversationRecords(options: Options) {
  const owners = new Map<string, Owner>()
  const deleted = new Set<string>()
  let writes: Promise<unknown> = Promise.resolve()
  const notice = () => {
    const message =
      'Conversation shadow is unavailable; original agent history and MCP recovery remain authoritative.'
    if (options.notice) options.notice(message)
    else reportAgentPersistenceNotice({ level: 'warning', message })
  }
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writes.catch(() => undefined).then(work)
    writes = next
    return next
  }
  const screened = (value: unknown): void => {
    // Match the existing persisted JSON envelope: undefined optionals are absent data.
    const plain: unknown = JSON.parse(JSON.stringify(value))
    // Separate structural/headroom failures from privacy exclusion. A size failure must
    // preserve the prior chain, rather than erase it as if it contained a credential.
    assertMcpJson(plain, AGENT_CONVERSATION_BYTES, { nodes: 40_000, depth: 60 })
    try {
      const returned = options.assertAllowed(plain) as unknown
      if (returned !== undefined) {
        if (returned instanceof Promise) void returned.catch(() => undefined)
        throw new Error('Conversation privacy assertion must be synchronous')
      }
    } catch {
      throw new ConversationPrivacyError('Conversation privacy excludes this envelope')
    }
  }
  const checkpoint = async (sessionId: string, owner: Owner, next: AgentConversationJournal) => {
    const raw = JSON.stringify(next)
    decodeAgentConversationJournal(raw, sessionId)
    try {
      screened(next)
    } catch (error) {
      if (!(error instanceof ConversationPrivacyError)) throw error
      await quarantinePrivacy(sessionId, owner)
      throw new Error('Conversation privacy changed')
    }
    // One serialized owner, plus a disk lease checked after every wait. Another writer or
    // a newer privacy/reconciliation body invalidates this observation, never a fresh anchor.
    if ((await read(options.path(sessionId))) !== owner.raw)
      throw new Error('Conversation shadow disk lease changed')
    try {
      await atomicWrite(options.path(sessionId), raw, {
        validate: (value) => {
          decodeAgentConversationJournal(value, sessionId)
        }
      })
    } catch (error) {
      // This is checkpoint acknowledgement only, never a provider/tool retry. An exact
      // committed body is the sole permitted recovery from an ambiguous write rejection.
      if ((await read(options.path(sessionId))) !== raw) throw error
    }
    // Rejected/ambiguous appends never move the committed cursor without exact readback.
    if ((await read(options.path(sessionId))) !== raw)
      throw new Error('Conversation checkpoint readback differs')
    try {
      screened(next)
    } catch (error) {
      if (!(error instanceof ConversationPrivacyError)) throw error
      await quarantinePrivacy(sessionId, owner)
      throw new Error('Conversation privacy changed')
    }
    owner.raw = raw
    owner.journal = next
    owner.projection = projectAgentRecords(sessionId, next.sessionRecords)
  }
  const quarantinePrivacy = async (sessionId: string, owner: Owner) => {
    owner.disabled = true
    owner.journal = undefined
    owner.projection = undefined
    owner.active = undefined
    const tombstone: Quarantine = {
      version: 1,
      sessionDigest: hash(sessionId),
      state: 'quarantined',
      reason: 'privacy'
    }
    // Do not retain newly screened-out payloads in either journal or backup. A tombstone
    // prevents a later missing-prefix fallback from importing this session as a fresh anchor.
    const raw = JSON.stringify(tombstone)
    await atomicWrite(options.path(sessionId), raw, {
      backupTransform: () => raw
    })
    await fs.rm(`${options.path(sessionId)}.bak`, { force: true })
    owner.raw = raw
  }
  const attempt = (session: AgentSession, operation: (owner: Owner) => Promise<void>) =>
    queue(async () => {
      if (deleted.has(session.id)) return
      let owner = owners.get(session.id)
      if (!owner) {
        owner = { raw: null, disabled: false }
        owners.set(session.id, owner)
      }
      if (owner.disabled) return
      try {
        // Screen the complete original envelope, including IDs, display evidence and sources.
        try {
          screened(session)
          if (owner.journal) screened(owner.journal)
        } catch (error) {
          if (!(error instanceof ConversationPrivacyError)) throw error
          await quarantinePrivacy(session.id, owner)
          notice()
          return
        }
        await operation(owner)
      } catch {
        owner.disabled = true
        owner.active = undefined
        // Do not overwrite corruption, gaps, changed historical bodies or failed writes.
        notice()
      }
    })
  const restore = (session: AgentSession) =>
    attempt(session, async (owner) => {
      if (owner.journal) return
      const raw = await read(options.path(session.id))
      const backup = await read(`${options.path(session.id)}.bak`)
      owner.raw = raw
      try {
        if (raw !== null) screened(JSON.parse(raw))
        if (backup !== null) screened(JSON.parse(backup))
      } catch (error) {
        if (!(error instanceof ConversationPrivacyError)) throw error
        await quarantinePrivacy(session.id, owner)
        notice()
        return
      }
      // A missing primary with an existing backup is evidence, not permission to re-anchor.
      if (raw === null && backup !== null) throw new Error('Conversation primary is missing')
      if (raw !== null) {
        const value = decodeAgentConversationJournal(raw, session.id)
        if (value.state === 'quarantined') {
          owner.disabled = true
          return
        }
        const projected = projectAgentRecords(session.id, value.sessionRecords)
        const lastRun = value.runs.at(-1)
        const run =
          lastRun &&
          projectAgentRunRecords(
            projectAgentRecords(session.id, value.sessionRecords.slice(0, lastRun.baseSequence)),
            lastRun.runId,
            lastRun.records
          )
        const interrupted = run?.state === 'running' && lastRun?.baseSequence === projected.sequence
        const observed = interrupted ? run.history : projected.history
        if (
          !same(
            observed.map((item) => item.message),
            (session.history || []).slice(0, observed.length)
          ) ||
          (!interrupted && observed.length !== (session.history || []).length) ||
          (!interrupted && projected.usage.totalTokens !== session.tokenCount)
        )
          throw new Error('Conversation shadow differs from authoritative history')
        owner.journal = value
        owner.projection = projected
        if (interrupted) {
          // Recovery is data-only: preserve the incomplete run and import the exact recovered
          // canonical closure as a reconciliation snapshot, without inventing a terminal/approval.
          const record = decodeAgentRecord({
            version: 1,
            sessionId: session.id,
            eventId: `recovery:${projected.sequence + 1}`,
            sequence: projected.sequence + 1,
            previousEventId: projected.eventId,
            source: { reference: `desktop/session/${session.id}`, revision: hash(session.history) },
            type: 'session_snapshot',
            reason: 'reconciliation',
            snapshot: {
              history: history(session, observed),
              outcomes: agentConversationOutcomes(
                session,
                options.outcomes?.() || [],
                projected.outcomes
              ),
              usage: addUsage(projected.usage, run.runUsage, session.tokenCount)
            }
          })
          await checkpoint(session.id, owner, {
            ...value,
            sessionRecords: [...value.sessionRecords, record]
          })
        }
        return
      }
      const anchor = decodeAgentRecord({
        version: 1,
        sessionId: session.id,
        eventId: 'legacy:1',
        sequence: 1,
        previousEventId: null,
        source: { reference: `desktop/session/${session.id}`, revision: hash(session.history) },
        type: 'session_snapshot',
        reason: 'legacy_import',
        snapshot: {
          history: history(session),
          outcomes: agentConversationOutcomes(session, options.outcomes?.() || []),
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: session.tokenCount }
        }
      })
      await checkpoint(session.id, owner, {
        version: 1,
        sessionId: session.id,
        state: 'shadow',
        usageBasis: { legacyTotalTokens: session.tokenCount, inputOutput: 'since_anchor' },
        sessionRecords: [anchor],
        runs: []
      })
    })
  const header = (sessionId: string, run: AgentRunProjection) => ({
    version: 1 as const,
    scope: 'run' as const,
    sessionId,
    runId: run.runId,
    eventId: `${run.runId}:${run.sequence + 1}`,
    sequence: run.sequence + 1,
    previousEventId: run.eventId,
    source: { reference: `desktop/run/${run.runId}` }
  })
  return {
    restore,
    // Called after the existing authoritative user-message checkpoint, before provider entry.
    start: (session: AgentSession, runId: string) =>
      attempt(session, async (owner) => {
        if (
          !owner.journal ||
          !owner.projection ||
          owner.active ||
          owner.journal.runs.length >= MAX_RUNS
        )
          throw new Error('Conversation shadow cannot start this run')
        const run = createAgentRunProjection(owner.projection, runId)
        const entries = history(session, owner.projection.history)
        if (!same(entries.slice(0, owner.projection.history.length), owner.projection.history))
          throw new Error('Conversation input changed historical body')
        const record = createAgentRunStart(
          header(session.id, run),
          owner.projection,
          entries.slice(owner.projection.history.length)
        )
        const projected = applyAgentRunRecord(run, record)
        if (Buffer.byteLength(JSON.stringify(projected.history)) > ACTIVE_HISTORY_BYTES)
          throw new Error('Conversation terminal headroom is unavailable')
        await checkpoint(session.id, owner, {
          ...owner.journal,
          runs: [
            ...owner.journal.runs,
            { runId, baseSequence: owner.projection.sequence, records: [record] }
          ]
        })
        owner.active = projected
      }),
    accepted: (session: AgentSession, runId: string, update: AgentAcceptedUpdate) =>
      attempt(session, async (owner) => {
        const run = owner.active
        if (!run || run.runId !== runId || !owner.journal || !owner.projection)
          throw new Error('Conversation acceptance has no current owner')
        assertAgentRunCurrent(run, owner.projection)
        const item = entry(session, update.message, run.history.length)
        const record = createAgentAcceptedRecord({
          envelope: header(session.id, run),
          update,
          historyId: item.id,
          source: item.source
        })
        const projected = applyAgentRunRecord(run, record)
        const next = {
          ...owner.journal,
          runs: owner.journal.runs.map((item) =>
            item.runId === runId ? { ...item, records: [...item.records, record] } : item
          )
        }
        if (
          Buffer.byteLength(JSON.stringify(projected.history)) > ACTIVE_HISTORY_BYTES ||
          Buffer.byteLength(JSON.stringify(next)) >
            AGENT_CONVERSATION_BYTES - TERMINAL_RESERVATION ||
          projected.receipts.length >= AGENT_RUN_RECORD_LIMITS.records - 1 ||
          owner.projection.sequence >= AGENT_RECORD_LIMITS.records
        )
          throw new Error('Conversation terminal headroom is unavailable')
        await checkpoint(session.id, owner, next)
        owner.active = projected
      }),
    settle: (
      session: AgentSession,
      runId: string,
      result: AgentResult,
      inputHistoryLength: number
    ) =>
      attempt(session, async (owner) => {
        const run = owner.active
        if (!run || run.runId !== runId || !owner.journal || !owner.projection)
          throw new Error('Conversation terminal has no current owner')
        assertAgentRunCurrent(run, owner.projection)
        const terminal = createRunSettlement({
          envelope: {
            version: 1,
            sessionId: session.id,
            eventId: `session:${owner.projection.sequence + 1}`,
            sequence: owner.projection.sequence + 1,
            previousEventId: owner.projection.eventId,
            source: { reference: `desktop/run/${runId}`, revision: hash(session.history) }
          },
          runId,
          inputHistoryLength,
          result: { ...result, history: session.history || [] },
          history: history(session, run.history),
          outcomes: agentConversationOutcomes(
            session,
            options.outcomes?.() || [],
            owner.projection.outcomes
          ),
          sessionUsage: addUsage(owner.projection.usage, result.usage, session.tokenCount)
        })
        const record = createAgentRunTerminal(header(session.id, run), terminal)
        const projected = applyAgentRunRecord(run, record)
        await checkpoint(session.id, owner, {
          ...owner.journal,
          sessionRecords: [...owner.journal.sessionRecords, terminal],
          runs: owner.journal.runs.map((item) =>
            item.runId === runId ? { ...item, records: [...item.records, record] } : item
          )
        })
        owner.active = undefined
        if (!same(projected.session, owner.projection))
          throw new Error('Conversation replay mismatch')
      }),
    forget: (sessionId: string) => {
      deleted.add(sessionId)
      return queue(async () => {
        const owner = owners.get(sessionId)
        if (owner) owner.disabled = true
        // Delete only the bounded shadow files after the authoritative session deletion commits.
        await fs.rm(options.path(sessionId), { force: true })
        await fs.rm(`${options.path(sessionId)}.bak`, { force: true })
        owners.delete(sessionId)
      })
    },
    drain: async () => {
      await writes
    }
  }
}
