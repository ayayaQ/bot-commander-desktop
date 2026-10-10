import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentAcceptedUpdate,
  AgentResult,
  AssistantMessage,
  HistoryMessage
} from '@ayayaq/vivi'
import { applyAgentRecord, createAgentProjection, projectAgentRecords } from '@ayayaq/vivi/events'
import {
  applyAgentRunRecord,
  createAgentRunProjection,
  projectAgentRunRecords
} from '@ayayaq/vivi/events/stream'
import type { AgentSession } from '../../shared/agentTypes'
import {
  createAgentConversationRecords,
  decodeAgentConversationJournal,
  type AgentConversationJournal
} from './agentConversationRecords'
import { closeAndDrainAtomicWrites, reopenAtomicWrites } from './atomicPersistence'

const GENERIC_NOTICE =
  'Conversation shadow is unavailable; original agent history and MCP recovery remain authoritative.'
const CREDENTIAL = 'ordinary-synthetic-credential-marker'
const RUN_USAGE = { inputTokens: 5, outputTokens: 3, totalTokens: 8 }
const DATE = '2026-10-10T00:00:00.000Z'

let directory: string
let recognizeCredential: boolean
let notices: ReturnType<typeof vi.fn<(message: string) => void>>
let stores: ReturnType<typeof createAgentConversationRecords>[]

function path(sessionId = 'session-1'): string {
  return join(directory, `${sessionId}.conversation.json`)
}

function assertAllowed(value: unknown): void {
  if (recognizeCredential && JSON.stringify(value).includes(CREDENTIAL))
    throw new Error(`Synthetic private diagnostic body: ${CREDENTIAL}`)
}

function store() {
  const records = createAgentConversationRecords({ path, assertAllowed, notice: notices })
  stores.push(records)
  return records
}

function session(id = 'session-1'): AgentSession {
  return {
    id,
    title: 'Ordinary recovery fixture',
    mode: 'manual',
    model: 'offline-fixture-model',
    reasoningEffort: 'medium',
    status: 'idle',
    messages: [
      { id: 'display-1', role: 'user', content: 'Earlier prompt', timestamp: DATE },
      { id: 'display-2', role: 'assistant', content: 'Earlier answer', timestamp: DATE }
    ],
    history: [
      { kind: 'message', role: 'user', content: 'Earlier prompt' },
      { kind: 'assistant', content: 'Earlier answer', toolCalls: [] }
    ],
    createdAt: DATE,
    updatedAt: DATE,
    planReady: false,
    tokenCount: 17
  }
}

function input(prior: AgentSession, content = 'New prompt'): AgentSession {
  const next = structuredClone(prior)
  next.status = 'running'
  next.activeRunId = 'run-1'
  next.history!.push({ kind: 'message', role: 'user', content })
  next.messages.push({ id: 'display-3', role: 'user', content, timestamp: DATE })
  return next
}

function update(message: AssistantMessage = answer()): AgentAcceptedUpdate {
  return {
    type: 'assistant_accepted',
    message,
    round: 1,
    usage: RUN_USAGE,
    aggregateUsage: RUN_USAGE
  }
}

function answer(content = 'New answer'): AssistantMessage {
  return { kind: 'assistant', content, toolCalls: [] }
}

function accepted(prior: AgentSession, message: HistoryMessage = answer()): AgentSession {
  const next = structuredClone(prior)
  next.history!.push(structuredClone(message))
  next.tokenCount = 25
  return next
}

function result(value: AgentSession, content = 'New answer'): AgentResult {
  return {
    status: 'completed',
    history: structuredClone(value.history!),
    content,
    rounds: 1,
    usage: RUN_USAGE
  }
}

async function journal(sessionId = 'session-1'): Promise<AgentConversationJournal> {
  const value = decodeAgentConversationJournal(
    await fs.readFile(path(sessionId), 'utf8'),
    sessionId
  )
  if (value.state !== 'shadow') throw new Error('Expected the plain fixture journal')
  return value
}

function expectQuarantine(raw: string, sessionId = 'session-1'): void {
  expect(decodeAgentConversationJournal(raw, sessionId)).toEqual({
    version: 1,
    sessionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    state: 'quarantined',
    reason: 'privacy'
  })
  expect(() => decodeAgentConversationJournal(raw, 'another-session')).toThrow()
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function completedFixture() {
  const records = store()
  const original = session()
  await records.restore(original)
  const started = input(original)
  await records.start(started, 'run-1')
  const completed = accepted(started)
  completed.status = 'completed'
  await records.accepted(completed, 'run-1', update())
  await records.settle(completed, 'run-1', result(completed), started.history!.length)
  return { records, completed, saved: await journal() }
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'desktop-conversation-records-'))
  recognizeCredential = false
  notices = vi.fn()
  stores = []
  reopenAtomicWrites()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(async () => {
  await Promise.all(stores.map((records) => records.drain()))
  vi.restoreAllMocks()
  await closeAndDrainAtomicWrites()
  reopenAtomicWrites()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('conversation shadow replay and ordinary recovery', () => {
  it('produces identical full and incremental replay without duplicating history or usage', async () => {
    const { completed, saved } = await completedFixture()
    const full = projectAgentRecords(completed.id, saved.sessionRecords)
    let incremental = createAgentProjection(completed.id)
    for (const record of saved.sessionRecords) incremental = applyAgentRecord(incremental, record)
    expect(incremental).toEqual(full)
    expect(applyAgentRecord(incremental, saved.sessionRecords[0])).toBe(incremental)
    expect(full.history.map((entry) => entry.message)).toEqual(completed.history)
    expect(full.usage).toEqual({ ...RUN_USAGE, totalTokens: 25 })
    expect(saved.usageBasis).toEqual({ legacyTotalTokens: 17, inputOutput: 'since_anchor' })
    expect(full.usage).not.toHaveProperty('cachedInputTokens')

    const retained = saved.runs[0]
    const base = projectAgentRecords(
      completed.id,
      saved.sessionRecords.slice(0, retained.baseSequence)
    )
    const fullRun = projectAgentRunRecords(base, retained.runId, retained.records)
    let incrementalRun = createAgentRunProjection(base, retained.runId)
    for (const record of retained.records)
      incrementalRun = applyAgentRunRecord(incrementalRun, record)
    expect(incrementalRun).toEqual(fullRun)
    expect(applyAgentRunRecord(incrementalRun, retained.records[0])).toBe(incrementalRun)
    expect(fullRun.state).toBe('settled')
    expect(fullRun.session).toEqual(full)
    expect(fullRun.runUsage).toEqual(RUN_USAGE)
    expect(notices).not.toHaveBeenCalled()
  })

  it('keeps the old committed file and cursor after a failed write while host history continues', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    const committed = await fs.readFile(path(), 'utf8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path())
        throw Object.assign(new Error(`Synthetic write diagnostic: ${CREDENTIAL}`), { code: 'EIO' })
      await rename(from, to)
    })

    const host = accepted(started)
    const authoritative = structuredClone(host)
    await records.accepted(host, 'run-1', update())
    await records.settle(host, 'run-1', result(host), started.history!.length)
    expect(host).toEqual(authoritative)
    expect(await fs.readFile(path(), 'utf8')).toBe(committed)
    const saved = await journal()
    expect(saved.sessionRecords).toHaveLength(1)
    expect(saved.runs[0].records.map((record) => record.type)).toEqual(['run_started'])
    const replay = projectAgentRecords(host.id, saved.sessionRecords)
    expect(replay.sequence).toBe(1)
    expect(replay.usage.totalTokens).toBe(17)
    expect(host.history).toHaveLength(4)
    expect(host.tokenCount).toBe(25)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toBe(committed)
  })

  it('acknowledges an ambiguously rejected write only after exact committed readback', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const rename = fs.rename.bind(fs)
    let ambiguous = true
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === path() && ambiguous) {
        ambiguous = false
        throw Object.assign(new Error('Synthetic acknowledgement was lost'), { code: 'EIO' })
      }
    })
    const started = input(original)
    await records.start(started, 'run-1')
    const completed = accepted(started)
    await records.accepted(completed, 'run-1', update())
    await records.settle(completed, 'run-1', result(completed), started.history!.length)
    expect((await journal()).runs[0].records.map((record) => record.type)).toEqual([
      'run_started',
      'assistant_accepted',
      'run_settled'
    ])
    expect(notices).not.toHaveBeenCalled()
  })

  it('withholds a rejected checkpoint when readback is the older committed body', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    const committed = await fs.readFile(path(), 'utf8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (to === path()) {
        await fs.writeFile(path(), committed)
        throw Object.assign(new Error('Synthetic replacement acknowledgement failure'), {
          code: 'EIO'
        })
      }
    })
    const host = accepted(started)
    await records.accepted(host, 'run-1', update())
    await records.settle(host, 'run-1', result(host), started.history!.length)
    expect(await fs.readFile(path(), 'utf8')).toBe(committed)
    expect((await journal()).runs[0].records.map((record) => record.type)).toEqual(['run_started'])
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('does not fresh-anchor a missing primary when a retained backup exists', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const backup = await fs.readFile(path(), 'utf8')
    await fs.rename(path(), `${path()}.bak`)
    const restored = store()
    await restored.restore(original)
    await restored.start(input(original), 'run-1')
    await expect(fs.readFile(path(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toBe(backup)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it.each(['primary', 'backup'])(
    'preserves both files after an ordinary %s read failure',
    async (which) => {
      const { completed } = await completedFixture()
      const primary = await fs.readFile(path(), 'utf8')
      const backup = await fs.readFile(`${path()}.bak`, 'utf8')
      const readFile = fs.readFile.bind(fs)
      const spy = vi.spyOn(fs, 'readFile')
      if (which === 'backup') spy.mockImplementationOnce(readFile)
      spy.mockRejectedValueOnce(
        Object.assign(new Error(`Synthetic read diagnostic: ${CREDENTIAL}`), { code: 'EIO' })
      )
      const restored = store()
      await restored.restore(completed)
      await restored.start(input(completed), 'run-2')
      expect(await fs.readFile(path(), 'utf8')).toBe(primary)
      expect(await fs.readFile(`${path()}.bak`, 'utf8')).toBe(backup)
      expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
    }
  )

  it.each([
    'corrupt JSON',
    'unsupported envelope',
    'session mismatch',
    'missing session prefix',
    'session sequence gap',
    'missing run prefix',
    'run sequence gap',
    'different independent terminal'
  ])('preserves and withholds an ordinary %s chain', async (kind) => {
    const { completed, saved } = await completedFixture()
    const broken = structuredClone(saved)
    let raw: string
    switch (kind) {
      case 'corrupt JSON':
        raw = '{"version":1,"sessionId":"session-1","state":'
        break
      case 'unsupported envelope':
        raw = JSON.stringify({ ...broken, version: 2 })
        break
      case 'session mismatch':
        raw = JSON.stringify({ ...broken, sessionId: 'another-session' })
        break
      case 'missing session prefix':
        broken.sessionRecords.shift()
        raw = JSON.stringify(broken)
        break
      case 'session sequence gap':
        broken.sessionRecords[1] = { ...broken.sessionRecords[1], sequence: 3 }
        raw = JSON.stringify(broken)
        break
      case 'missing run prefix':
        broken.runs[0].records.shift()
        raw = JSON.stringify(broken)
        break
      case 'run sequence gap':
        broken.runs[0].records[1] = { ...broken.runs[0].records[1], sequence: 4 }
        raw = JSON.stringify(broken)
        break
      default: {
        const terminal = broken.runs[0].records.at(-1)!
        if (terminal.type !== 'run_settled' || terminal.terminal.type !== 'run_settled')
          throw new Error('Expected the terminal fixture')
        broken.runs[0].records[broken.runs[0].records.length - 1] = {
          ...terminal,
          terminal: {
            ...terminal.terminal,
            source: { reference: 'desktop/run/different-source' }
          }
        }
        raw = JSON.stringify(broken)
      }
    }
    const backup = await fs.readFile(`${path()}.bak`, 'utf8')
    await fs.writeFile(path(), raw)
    expect(() => decodeAgentConversationJournal(raw, completed.id)).toThrow()
    const restored = store()
    await restored.restore(completed)
    await restored.start(input(completed), 'run-2')
    expect(await fs.readFile(path(), 'utf8')).toBe(raw)
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toBe(backup)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('preserves a valid journal when authoritative historical content has changed', async () => {
    const { completed } = await completedFixture()
    const primary = await fs.readFile(path(), 'utf8')
    const backup = await fs.readFile(`${path()}.bak`, 'utf8')
    const changed = structuredClone(completed)
    changed.history![0] = { kind: 'message', role: 'user', content: 'Edited earlier prompt' }
    const restored = store()
    await restored.restore(changed)
    await restored.restore(completed)
    await restored.start(input(changed), 'run-2')
    expect(await fs.readFile(path(), 'utf8')).toBe(primary)
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toBe(backup)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('preserves a malformed backup without treating parse failure as a privacy finding', async () => {
    const { completed } = await completedFixture()
    const primary = await fs.readFile(path(), 'utf8')
    const malformed = '{"version":1,"sessionId":"session-1","sessionRecords":['
    await fs.writeFile(`${path()}.bak`, malformed)
    const restored = store()
    await restored.restore(completed)
    await restored.start(input(completed), 'run-2')
    expect(await fs.readFile(path(), 'utf8')).toBe(primary)
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toBe(malformed)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('rejects an obsolete disk lease after waiting behind another serialized writer', async () => {
    const records = store()
    const first = session('session-first')
    const target = session('session-target')
    await records.restore(first)
    await records.restore(target)
    const targetJournal = await journal(target.id)
    const entered = deferred()
    const release = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path(first.id)) {
        entered.resolve()
        await release.promise
      }
      await rename(from, to)
    })
    const firstWrite = records.start(input(first), 'run-1')
    await entered.promise
    const waitingWrite = records.start(input(target), 'run-1')
    const newer = structuredClone(targetJournal)
    newer.sessionRecords.push({
      ...newer.sessionRecords[0],
      eventId: 'external-reconciliation:2',
      sequence: 2,
      previousEventId: newer.sessionRecords[0].eventId,
      type: 'session_snapshot',
      reason: 'reconciliation',
      snapshot: targetJournal.sessionRecords[0].snapshot
    })
    const newerRaw = JSON.stringify(newer)
    decodeAgentConversationJournal(newerRaw, target.id)
    await fs.writeFile(path(target.id), newerRaw)
    release.resolve()
    await Promise.all([firstWrite, waitingWrite])
    expect(await fs.readFile(path(target.id), 'utf8')).toBe(newerRaw)
    expect((await journal(target.id)).runs).toEqual([])
    expect((await journal(first.id)).runs).toHaveLength(1)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('fails closed on input headroom without truncating the committed anchor or host input', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const committed = await fs.readFile(path(), 'utf8')
    const largeInput = 'ordinary input '.repeat(30_000)
    const host = input(original, largeInput)
    await records.start(host, 'run-1')
    expect(await fs.readFile(path(), 'utf8')).toBe(committed)
    expect((await journal()).runs).toEqual([])
    expect(host.history!.at(-1)).toEqual({ kind: 'message', role: 'user', content: largeInput })
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('fails closed on accepted-output headroom without dropping or truncating host output', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    const committed = await fs.readFile(path(), 'utf8')
    const largeAnswer = answer('ordinary answer '.repeat(30_000))
    const host = accepted(started, largeAnswer)
    await records.accepted(host, 'run-1', update(largeAnswer))
    expect(await fs.readFile(path(), 'utf8')).toBe(committed)
    expect((await journal()).runs[0].records).toHaveLength(1)
    expect(host.history!.at(-1)).toEqual(largeAnswer)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('withholds an oversized final closure while preserving the accepted incomplete chain', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    const assistant: AssistantMessage = {
      kind: 'assistant',
      content: 'Lookup started',
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'ordinary fixture' } }]
    }
    const host = accepted(started, assistant)
    await records.accepted(host, 'run-1', update(assistant))
    const committed = await fs.readFile(path(), 'utf8')
    const closure: HistoryMessage = {
      kind: 'tool_result',
      callId: 'call-1',
      name: 'lookup',
      content: 'ordinary final closure '.repeat(55_000),
      isError: true
    }
    host.history!.push(closure)
    host.status = 'cancelled'
    const terminal = { ...result(host, assistant.content), status: 'cancelled' as const }
    const authoritative = structuredClone(host)
    await records.settle(host, 'run-1', terminal, started.history!.length)
    expect(host).toEqual(authoritative)
    expect(await fs.readFile(path(), 'utf8')).toBe(committed)
    expect((await journal()).sessionRecords).toHaveLength(1)
    expect((await journal()).runs[0].records.map((record) => record.type)).toEqual([
      'run_started',
      'assistant_accepted'
    ])
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('recovers an interrupted accepted chain as data without inventing terminal or approval', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    const assistant: AssistantMessage = {
      kind: 'assistant',
      content: 'Lookup started',
      toolCalls: [{ id: 'call-1', name: 'lookup', arguments: { query: 'ordinary fixture' } }]
    }
    const host = accepted(started, assistant)
    await records.accepted(host, 'run-1', update(assistant))
    const before = await journal()
    host.status = 'interrupted'
    host.history!.push({
      kind: 'tool_result',
      callId: 'call-1',
      name: 'lookup',
      content: 'Execution interrupted; exact outcome remains unreported',
      isError: true
    })
    const authoritative = structuredClone(host)
    await store().restore(host)
    expect(host).toEqual(authoritative)
    const recovered = await journal()
    expect(recovered.runs).toEqual(before.runs)
    expect(recovered.sessionRecords).toHaveLength(2)
    expect(recovered.sessionRecords[1]).toMatchObject({
      type: 'session_snapshot',
      reason: 'reconciliation'
    })
    const projection = projectAgentRecords(host.id, recovered.sessionRecords)
    expect(projection.history.map((entry) => entry.message)).toEqual(host.history)
    expect(projection.outcomes).toEqual([])
    expect(projection.runs).toEqual([])
    expect(projection.usage).toEqual({ ...RUN_USAGE, totalTokens: 25 })
    const base = projectAgentRecords(host.id, recovered.sessionRecords.slice(0, 1))
    const incomplete = projectAgentRunRecords(base, 'run-1', recovered.runs[0].records)
    expect(incomplete.state).toBe('running')
    expect(incomplete.runUsage).toEqual(RUN_USAGE)
    expect(JSON.stringify(recovered)).not.toContain('approval')
    const committed = await fs.readFile(path(), 'utf8')
    await store().restore(host)
    expect(await fs.readFile(path(), 'utf8')).toBe(committed)
    expect(projectAgentRecords(host.id, (await journal()).sessionRecords)).toEqual(projection)
    expect(notices).not.toHaveBeenCalled()
  })

  it('scrubs a newly recognized credential from journal and backup and withholds restoration', async () => {
    const records = store()
    const original = session()
    original.history![0] = { kind: 'message', role: 'user', content: CREDENTIAL }
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    expect(await fs.readFile(path(), 'utf8')).toContain(CREDENTIAL)
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toContain(CREDENTIAL)

    recognizeCredential = true
    const sanitized = structuredClone(started)
    sanitized.history![0] = { kind: 'message', role: 'user', content: '[withheld]' }
    const restored = store()
    await restored.restore(sanitized)
    const raw = await fs.readFile(path(), 'utf8')
    expectQuarantine(raw, original.id)
    expect(raw).not.toContain(CREDENTIAL)
    await expect(fs.readFile(`${path()}.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await restored.start(sanitized, 'run-2')
    await store().restore(sanitized)
    expect(await fs.readFile(path(), 'utf8')).toBe(raw)
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('keeps forgotten shadow files deleted when queued and late run work arrives', async () => {
    const records = store()
    const original = session()
    await records.restore(original)
    const started = input(original)
    await records.start(started, 'run-1')
    const host = accepted(started)
    await records.accepted(host, 'run-1', update())
    expect(await fs.readFile(path(), 'utf8')).toContain('assistant_accepted')
    expect(await fs.readFile(`${path()}.bak`, 'utf8')).toContain('run_started')

    const deletion = records.forget(host.id)
    const queuedRestore = records.restore(host)
    const queuedTerminal = records.settle(host, 'run-1', result(host), started.history!.length)
    await deletion
    await Promise.all([queuedRestore, queuedTerminal])
    await records.restore(host)
    await records.start(input(host), 'run-2')
    await records.accepted(host, 'run-1', update())
    await records.settle(host, 'run-1', result(host), started.history!.length)
    await records.drain()
    await expect(fs.readFile(path(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.readFile(`${path()}.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(directory)).toEqual([])
    expect(notices).not.toHaveBeenCalled()
  })

  it('scrubs a recognized credential when the backup is the only retained journal', async () => {
    const records = store()
    const original = session()
    original.history![0] = { kind: 'message', role: 'user', content: CREDENTIAL }
    await records.restore(original)
    await fs.rename(path(), `${path()}.bak`)
    recognizeCredential = true
    const sanitized = session()
    await store().restore(sanitized)
    expectQuarantine(await fs.readFile(path(), 'utf8'), original.id)
    await expect(fs.readFile(`${path()}.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })

  it('quarantines both files when current privacy changes during an admitted write', async () => {
    const records = store()
    const original = session()
    original.history![0] = { kind: 'message', role: 'user', content: CREDENTIAL }
    await records.restore(original)
    const entered = deferred()
    const release = deferred()
    const rename = fs.rename.bind(fs)
    let wait = true
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path() && wait) {
        wait = false
        entered.resolve()
        await release.promise
      }
      await rename(from, to)
    })
    const pending = records.start(input(original), 'run-1')
    await entered.promise
    recognizeCredential = true
    release.resolve()
    await pending
    const raw = await fs.readFile(path(), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({ state: 'quarantined', reason: 'privacy' })
    expect(raw).not.toContain(CREDENTIAL)
    await expect(fs.readFile(`${path()}.bak`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(notices.mock.calls).toEqual([[GENERIC_NOTICE]])
  })
})
