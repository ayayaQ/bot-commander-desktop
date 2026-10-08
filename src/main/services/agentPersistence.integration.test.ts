import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSession } from '../../shared/agentTypes'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'

const mocks = vi.hoisted(() => ({ directory: '', runAgent: vi.fn(), commitMutation: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }))
vi.mock('@ayayaq/vivi', async (original) => ({
  ...(await original<typeof import('@ayayaq/vivi')>()),
  runAgent: mocks.runAgent
}))
vi.mock('./agentProviderAdapter', async (original) => ({
  ...(await original<typeof import('./agentProviderAdapter')>()),
  createAgentProvider: vi.fn()
}))
vi.mock('./agentTools', () => ({
  agentToolTargetLabel: vi.fn(),
  agentToolDefinitions: [],
  mutationToolNames: new Set(),
  prepareMutation: vi.fn(),
  commitMutation: mocks.commitMutation,
  executeReadTool: vi.fn()
}))

const settings = { aiProvider: 'openai' as const, openaiApiKey: 'fixture' }
const timestamp = '2026-01-01T00:00:00.000Z'
function session(id = 'existing'): AgentSession {
  return {
    id,
    title: 'Saved session',
    mode: 'manual',
    model: 'fixture-model',
    reasoningEffort: 'none',
    status: 'idle',
    messages: [],
    history: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    planReady: false,
    tokenCount: 0
  }
}
function sessions(...records: AgentSession[]): string {
  return JSON.stringify({ sessions: records, activeSessionId: records[0]?.id ?? null })
}
function memory(content = 'Saved preference') {
  return {
    id: 'saved-memory',
    content,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: 'user' as const,
    updatedBy: 'user' as const
  }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => (resolve = yes))
  return { promise, resolve }
}

beforeEach(async () => {
  vi.resetModules()
  mocks.runAgent.mockReset()
  mocks.commitMutation.mockReset()
  mocks.directory = await fs.mkdtemp(join(tmpdir(), 'agent-recovery-integration-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  const lifecycle = await import('./agentPersistenceLifecycle')
  lifecycle.pauseAgentPersistence()
  await lifecycle.drainAgentPersistence().catch(() => undefined)
  const atomic = await import('./atomicPersistence')
  await atomic.closeAndDrainAtomicWrites().catch(() => undefined)
  atomic.reopenAtomicWrites()
  lifecycle.resumeAgentPersistence()
  await fs.rm(mocks.directory, { recursive: true, force: true })
})

describe('recoverable agent service wiring', () => {
  it('retains loaded memories after an initial checkpoint failure and retries on a later edit', async () => {
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    const original = JSON.stringify({ memories: [memory()] })
    await fs.writeFile(memoryPath, original)
    const persistence = await import('./agentPersistence')
    const notice = vi.fn()
    persistence.setAgentPersistenceNoticeHandler(notice)
    const rename = fs.rename.bind(fs)
    let fail = true
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === memoryPath && fail) throw new Error('Initial checkpoint failure')
      return rename(from, to)
    })
    const memories = await import('./agentMemoryService')
    const event = vi.fn()
    memories.setAgentMemoryEventSink(event)
    const loaded = await memories.loadAgentMemories()
    expect(loaded.memories[0]).toMatchObject(memory())
    expect(await fs.readFile(memoryPath, 'utf8')).toBe(original)
    expect(event).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledExactlyOnceWith({
      level: 'error',
      message: expect.stringContaining('Could not checkpoint agent memory recovery')
    })
    fail = false
    const result = await memories.commitMemoryMutation(
      await memories.prepareUpdateMemory(
        loaded.memories[0].id,
        loaded.memories[0].revision,
        'Successfully retried preference',
        'user'
      )
    )
    expect(JSON.parse(await fs.readFile(memoryPath, 'utf8')).memories[0]).toMatchObject({
      content: 'Successfully retried preference'
    })
    expect(event).toHaveBeenCalledExactlyOnceWith(result)
  })

  it('rejects a cancelled queued memory before saving while retaining the earlier commit', async () => {
    const memories = await import('./agentMemoryService')
    await memories.loadAgentMemories()
    const firstMutation = await memories.prepareCreateMemory('First accepted save', 'user')
    const secondMutation = await memories.prepareCreateMemory('Cancelled queued save', 'agent')
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    const entered = deferred()
    const gate = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      entered.resolve()
      await gate.promise
      return rename(from, to)
    })
    const event = vi.fn()
    memories.setAgentMemoryEventSink(event)
    const first = memories.commitMemoryMutation(firstMutation)
    await entered.promise
    const controller = new AbortController()
    const second = memories.commitMemoryMutation(secondMutation, { signal: controller.signal })
    const cancelled = expect(second).rejects.toThrow('abort')
    controller.abort()
    gate.resolve()
    await Promise.all([first, cancelled])
    expect((await memories.loadAgentMemories()).memories.map((item) => item.content)).toEqual([
      'First accepted save'
    ])
    expect(JSON.parse(await fs.readFile(memoryPath, 'utf8')).memories).toHaveLength(1)
    expect(event).toHaveBeenCalledTimes(1)
    expect((await fs.readdir(mocks.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('drains and publishes an already-started memory save after cancellation', async () => {
    const memories = await import('./agentMemoryService')
    await memories.loadAgentMemories()
    const mutation = await memories.prepareCreateMemory('Started save still commits', 'user')
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    const entered = deferred()
    const gate = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      entered.resolve()
      await gate.promise
      return rename(from, to)
    })
    const event = vi.fn()
    memories.setAgentMemoryEventSink(event)
    const controller = new AbortController()
    const saving = memories.commitMemoryMutation(mutation, { signal: controller.signal })
    await entered.promise
    controller.abort()
    const lifecycle = await import('./agentPersistenceLifecycle')
    lifecycle.pauseAgentPersistence()
    let drained = false
    const drain = lifecycle.drainAgentPersistence().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    gate.resolve()
    const [result] = await Promise.all([saving, drain])
    expect(result.memories[0].content).toBe('Started save still commits')
    expect(event).toHaveBeenCalledExactlyOnceWith(result)
    expect(JSON.parse(await fs.readFile(memoryPath, 'utf8')).memories[0].content).toBe(
      'Started save still commits'
    )
    expect(drained).toBe(true)
  })

  it('continues queued memory commits from unchanged live data after a pre-commit failure', async () => {
    const memories = await import('./agentMemoryService')
    await memories.loadAgentMemories()
    const first = await memories.prepareCreateMemory('Failed proposal', 'user')
    const second = await memories.prepareCreateMemory('Successful queued proposal', 'agent')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename')
      .mockImplementationOnce(async () => {
        throw new Error('First save failed before rename')
      })
      .mockImplementation(rename)
    const event = vi.fn()
    memories.setAgentMemoryEventSink(event)
    const rejected = expect(memories.commitMemoryMutation(first)).rejects.toThrow('before rename')
    const result = memories.commitMemoryMutation(second)
    await rejected
    expect((await result).memories.map((item) => item.content)).toEqual([
      'Successful queued proposal'
    ])
    expect(event).toHaveBeenCalledTimes(1)
  })

  it('quarantines duplicate display keys and preserves the damaged records on healthy edits', async () => {
    const call = {
      id: 'duplicate-call',
      name: 'edit_command',
      arguments: {},
      status: 'completed',
      createdAt: timestamp
    }
    const message = {
      id: 'duplicate-message',
      role: 'tool',
      content: 'Result',
      timestamp,
      toolCalls: [call]
    }
    const repeatedMessages = [message, message]
    const repeatedCalls = [{ ...message, toolCalls: [call, call] }]
    await fs.writeFile(
      join(mocks.directory, 'agent-sessions.json'),
      sessions(
        { ...session('duplicate-messages'), messages: repeatedMessages } as unknown as AgentSession,
        { ...session('duplicate-calls'), messages: repeatedCalls } as unknown as AgentSession,
        session('healthy')
      )
    )
    const agents = await import('./agentService')
    const loaded = await agents.loadAgentSessions()
    expect(loaded.sessions.slice(0, 2).map((item) => item.messages)).toEqual([[], []])
    await agents.updateAgentSession('healthy', { title: 'Renderer remains usable' }, 'openai')
    const stored = JSON.parse(
      await fs.readFile(join(mocks.directory, 'agent-sessions.json'), 'utf8')
    )
    expect(stored.sessions[0].messages).toEqual(repeatedMessages)
    expect(stored.sessions[1].messages).toEqual(repeatedCalls)
    expect(stored.sessions[2].title).toBe('Renderer remains usable')
  })

  it('recovers array-valued session mode metadata from backup instead of admitting an auto run', async () => {
    const path = join(mocks.directory, 'agent-sessions.json')
    await fs.writeFile(
      path,
      sessions({ ...session(), mode: ['planning'] } as unknown as AgentSession)
    )
    await fs.writeFile(`${path}.bak`, sessions(session('recovered')))
    const agents = await import('./agentService')
    expect((await agents.loadAgentSessions()).sessions[0]).toMatchObject({
      id: 'recovered',
      mode: 'manual'
    })
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    expect((await fs.readdir(mocks.directory)).some((name) => name.endsWith('.corrupt'))).toBe(true)
  })

  it.each([null, [null], { keep: 'damaged legacy display' }])(
    'quarantines malformed display history %j without disabling healthy sessions',
    async (messages) => {
      const broken = { ...session('broken-display'), messages } as unknown as AgentSession
      await fs.writeFile(
        join(mocks.directory, 'agent-sessions.json'),
        sessions(broken, session('healthy'))
      )
      const agents = await import('./agentService')
      const loaded = await agents.loadAgentSessions()
      expect(loaded.sessions[0]).toMatchObject({ status: 'error', messages: [] })
      await expect(
        agents.runAgentSession('broken-display', 'Must stay quarantined', settings)
      ).rejects.toThrow('display history is malformed')
      await agents.updateAgentSession('healthy', { title: 'Still editable' }, 'openai')
      await agents.updateAgentSession('broken-display', { title: 'Metadata only' }, 'openai')
      const stored = JSON.parse(
        await fs.readFile(join(mocks.directory, 'agent-sessions.json'), 'utf8')
      )
      expect(stored.sessions[0].messages).toEqual(messages)
      expect(stored.sessions[1].title).toBe('Still editable')
      expect(mocks.runAgent).not.toHaveBeenCalled()
      vi.resetModules()
      const restarted = await import('./agentService')
      expect((await restarted.loadAgentSessions()).sessions[0]).toMatchObject({
        status: 'error',
        messages: []
      })
      await expect(
        restarted.runAgentSession('broken-display', 'No replay after restart', settings)
      ).rejects.toThrow('display history is malformed')
    }
  )

  it('creates absent stores and migrates legacy envelopes/history without losing metadata', async () => {
    const old = { ...session(), history: undefined, extraMetadata: { kept: true } }
    old.messages = [{ id: 'message', role: 'user', timestamp, content: 'Legacy request' }]
    await fs.writeFile(join(mocks.directory, 'agent-sessions.json'), sessions(old))
    const agents = await import('./agentService')
    const memories = await import('./agentMemoryService')
    const [left, right] = await Promise.all([
      agents.loadAgentSessions(),
      agents.loadAgentSessions()
    ])
    expect(left).toEqual(right)
    expect(left.sessions[0].history).toEqual([
      { kind: 'message', role: 'user', content: 'Legacy request' }
    ])
    const stored = JSON.parse(
      await fs.readFile(join(mocks.directory, 'agent-sessions.json'), 'utf8')
    )
    expect(stored.sessions[0].extraMetadata).toEqual({ kept: true })
    expect(stored.modelDefaultsByProvider).toEqual({})
    expect((await memories.loadAgentMemories()).memories).toEqual([])
    expect(
      JSON.parse(await fs.readFile(join(mocks.directory, 'agent-memories.json'), 'utf8'))
    ).toEqual({ version: 1, memories: [] })
  })

  it('recovers both stores from backups and preserves corrupt primary bytes with a notice', async () => {
    const notice = vi.fn()
    const persistence = await import('./agentPersistence')
    persistence.setAgentPersistenceNoticeHandler(notice)
    const agentPath = join(mocks.directory, 'agent-sessions.json')
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    await fs.writeFile(agentPath, '{truncated session')
    await fs.writeFile(`${agentPath}.bak`, sessions(session()))
    await fs.writeFile(memoryPath, JSON.stringify({ version: 1, memories: [{ bad: true }] }))
    await fs.writeFile(`${memoryPath}.bak`, JSON.stringify({ memories: [memory()] }))
    const agents = await import('./agentService')
    const memories = await import('./agentMemoryService')
    expect((await agents.loadAgentSessions()).sessions[0].id).toBe('existing')
    expect((await memories.loadAgentMemories()).memories[0].content).toBe('Saved preference')
    const copies = (await fs.readdir(mocks.directory)).filter((name) => name.endsWith('.corrupt'))
    expect(copies).toHaveLength(2)
    expect(
      await fs.readFile(
        join(
          mocks.directory,
          copies.find((name) => name.startsWith('agent-sessions'))!
        ),
        'utf8'
      )
    ).toBe('{truncated session')
    expect(notice).toHaveBeenCalledWith({
      level: 'warning',
      message: expect.stringContaining('Agent sessions was recovered from its backup')
    })
    expect(notice).toHaveBeenCalledWith({
      level: 'warning',
      message: expect.stringContaining('Agent memories was recovered from its backup')
    })
  })

  it('keeps unrecoverable files unchanged and exposes read-only shell data', async () => {
    for (const name of ['agent-sessions.json', 'agent-memories.json']) {
      await fs.writeFile(join(mocks.directory, name), 'null')
      await fs.writeFile(join(mocks.directory, `${name}.bak`), '{broken backup')
    }
    const agents = await import('./agentService')
    const memories = await import('./agentMemoryService')
    expect((await agents.loadAgentSessions()).sessions).toEqual([])
    expect((await memories.loadAgentMemories()).memories).toEqual([])
    const rename = vi.spyOn(fs, 'rename')
    await expect(agents.createAgentSession(settings)).rejects.toThrow('read-only')
    await expect(agents.setActiveAgentSession(null)).rejects.toThrow('read-only')
    await expect(
      memories.prepareCreateMemory('Must not overwrite evidence', 'user')
    ).rejects.toThrow('read-only')
    await expect(
      memories.commitMemoryMutation({ kind: 'create', before: null, after: memory() })
    ).rejects.toThrow('read-only')
    expect(rename).not.toHaveBeenCalled()
    for (const name of ['agent-sessions.json', 'agent-memories.json']) {
      expect(await fs.readFile(join(mocks.directory, name), 'utf8')).toBe('null')
      expect(await fs.readFile(join(mocks.directory, `${name}.bak`), 'utf8')).toBe('{broken backup')
    }
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.commitMutation).not.toHaveBeenCalled()
  })

  it('keeps malformed canonical history quarantined while closing unknown interrupted calls', async () => {
    const damaged = { ...session('damaged'), history: [null] } as unknown as AgentSession
    const pending = session('pending')
    pending.status = 'waiting_approval'
    pending.activeRunId = 'old-run'
    pending.history = [
      {
        kind: 'assistant',
        content: '',
        toolCalls: [{ id: 'unknown-call', name: 'edit_command', arguments: {} }]
      }
    ]
    pending.messages = [
      {
        id: 'display',
        role: 'tool',
        timestamp,
        content: 'edit_command',
        toolCalls: [
          {
            id: 'unknown-call',
            name: 'edit_command',
            arguments: {},
            status: 'approved',
            createdAt: timestamp
          }
        ]
      }
    ]
    await fs.writeFile(
      join(mocks.directory, 'agent-sessions.json'),
      sessions(damaged, pending, session('healthy'))
    )
    const agents = await import('./agentService')
    const loaded = await agents.loadAgentSessions()
    expect(loaded.sessions[0]).toMatchObject({ status: 'error', history: [null] })
    await expect(agents.runAgentSession('damaged', 'Do not replay', settings)).rejects.toThrow(
      'history recovery failed'
    )
    expect(loaded.sessions[1]).toMatchObject({ status: 'interrupted', activeRunId: undefined })
    expect(loaded.sessions[1].history?.at(-1)).toMatchObject({ kind: 'tool_result', isError: true })
    expect(loaded.sessions[1].messages[0].toolCalls?.[0].result).toMatchObject({
      interrupted: true,
      outcome: 'unknown'
    })
    expect(await agents.resolveAgentApproval('pending', 'unknown-call', true)).toBe(false)
    await agents.updateAgentSession('healthy', { title: 'Healthy remains editable' }, 'openai')
    const stored = JSON.parse(
      await fs.readFile(join(mocks.directory, 'agent-sessions.json'), 'utf8')
    )
    expect(stored.sessions[0].history).toEqual([null])
    expect(stored.sessions[2].title).toBe('Healthy remains editable')
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(mocks.commitMutation).not.toHaveBeenCalled()
  })

  it('preserves durable and live state on pre-commit session and memory failures', async () => {
    const agents = await import('./agentService')
    const memories = await import('./agentMemoryService')
    const existing = await agents.createAgentSession(settings, 'Original title')
    const savedMemory = (
      await memories.commitMemoryMutation(
        await memories.prepareCreateMemory('Original preference', 'user')
      )
    ).memories[0]
    const agentPath = join(mocks.directory, 'agent-sessions.json')
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    const oldAgents = await fs.readFile(agentPath, 'utf8')
    const oldMemories = await fs.readFile(memoryPath, 'utf8')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === agentPath || to === memoryPath)
        throw new Error('Injected pre-commit rename failure')
      return rename(from, to)
    })
    await expect(
      agents.updateAgentSession(existing.id, { title: 'Unsaved title' }, 'openai')
    ).rejects.toThrow('pre-commit')
    await expect(agents.createAgentSession(settings)).rejects.toThrow('pre-commit')
    await expect(agents.deleteAgentSession(existing.id)).rejects.toThrow('pre-commit')
    expect((await agents.loadAgentSessions()).sessions).toEqual([existing])
    expect(await fs.readFile(agentPath, 'utf8')).toBe(oldAgents)
    const update = await memories.prepareUpdateMemory(
      savedMemory.id,
      savedMemory.revision,
      'Unsaved preference',
      'user'
    )
    await expect(memories.commitMemoryMutation(update)).rejects.toThrow('pre-commit')
    expect((await memories.loadAgentMemories()).memories).toEqual([savedMemory])
    expect(await fs.readFile(memoryPath, 'utf8')).toBe(oldMemories)
    expect((await fs.readdir(mocks.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('publishes post-commit uncertain state and waits for a directory-sync retry on quit', async () => {
    const agents = await import('./agentService')
    const memories = await import('./agentMemoryService')
    await agents.loadAgentSessions()
    await memories.loadAgentMemories()
    const atomic = await import('./atomicPersistence')
    const notice = vi.fn()
    atomic.setAtomicWriteNoticeHandler(notice)
    const agentPath = join(mocks.directory, 'agent-sessions.json')
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    const rename = fs.rename.bind(fs)
    let primaryCommitted = false
    let fail = true
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      primaryCommitted = to === agentPath || to === memoryPath
    })
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === mocks.directory && primaryCommitted && fail)
        vi.spyOn(handle, 'sync').mockRejectedValue(
          Object.assign(new Error('Injected directory failure'), { code: 'EIO' })
        )
      return handle
    })
    const created = await agents.createAgentSession(settings, 'Committed title')
    const createdMemory = (
      await memories.commitMemoryMutation(
        await memories.prepareCreateMemory('Committed preference', 'user')
      )
    ).memories[0]
    expect((await agents.loadAgentSessions()).sessions[0]).toEqual(created)
    expect((await memories.loadAgentMemories()).memories[0]).toEqual(createdMemory)
    expect(JSON.parse(await fs.readFile(agentPath, 'utf8')).sessions[0].title).toBe(
      'Committed title'
    )
    expect(JSON.parse(await fs.readFile(memoryPath, 'utf8')).memories[0].content).toBe(
      'Committed preference'
    )
    expect(notice).toHaveBeenCalledWith({
      level: 'error',
      message: expect.stringContaining('has not been rolled back')
    })
    await expect(atomic.closeAndDrainAtomicWrites()).rejects.toThrow('Pending persistence failed')
    const beforeRetry = vi.mocked(fs.rename).mock.calls.length
    fail = false
    atomic.reopenAtomicWrites()
    await expect(atomic.closeAndDrainAtomicWrites()).resolves.toBeUndefined()
    expect(vi.mocked(fs.rename).mock.calls).toHaveLength(beforeRetry)
    atomic.reopenAtomicWrites()
    const later = await memories.commitMemoryMutation(
      await memories.prepareCreateMemory('Later confirmed preference', 'user')
    )
    expect(later.memories.map((item) => item.content)).toEqual([
      'Committed preference',
      'Later confirmed preference'
    ])
    expect(JSON.parse(await fs.readFile(memoryPath, 'utf8')).memories).toHaveLength(2)
  })

  it('drains every accepted queued memory save before closing writes and rejects new edits', async () => {
    const memories = await import('./agentMemoryService')
    await memories.loadAgentMemories()
    const firstMutation = await memories.prepareCreateMemory('First accepted save', 'user')
    const secondMutation = await memories.prepareCreateMemory('Second accepted save', 'user')
    const entered = deferred()
    const gate = deferred()
    const memoryPath = join(mocks.directory, 'agent-memories.json')
    const rename = fs.rename.bind(fs)
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === memoryPath && !gated) {
        gated = true
        entered.resolve()
        await gate.promise
      }
      return rename(from, to)
    })
    const first = memories.commitMemoryMutation(firstMutation)
    const second = memories.commitMemoryMutation(secondMutation)
    await entered.promise
    const lifecycle = await import('./agentPersistenceLifecycle')
    lifecycle.pauseAgentPersistence()
    let drained = false
    const drain = lifecycle.drainAgentPersistence().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)
    await expect(
      memories.commitMemoryMutation({ kind: 'create', before: null, after: memory() })
    ).rejects.toThrow('shutting down')
    gate.resolve()
    await Promise.all([first, second, drain])
    const atomic = await import('./atomicPersistence')
    await atomic.closeAndDrainAtomicWrites()
    expect(
      JSON.parse(await fs.readFile(memoryPath, 'utf8')).memories.map((item) => item.content)
    ).toEqual(['First accepted save', 'Second accepted save'])
    expect(drained).toBe(true)
  })

  it('stops active runs and drains their admitted final checkpoints', async () => {
    const entered = deferred()
    mocks.runAgent.mockImplementation(async ({ signal, messages }) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true })
      )
      return {
        status: 'cancelled',
        history: messages,
        rounds: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    })
    const agents = await import('./agentService')
    const existing = await agents.createAgentSession(settings)
    await agents.runAgentSession(existing.id, 'Accepted request', settings)
    await entered.promise
    const lifecycle = await import('./agentPersistenceLifecycle')
    lifecycle.pauseAgentPersistence()
    agents.stopAgentRuns()
    await lifecycle.drainAgentPersistence()
    const stored = JSON.parse(
      await fs.readFile(join(mocks.directory, 'agent-sessions.json'), 'utf8')
    )
    expect(stored.sessions[0]).toMatchObject({ status: 'cancelled' })
    expect(stored.sessions[0].activeRunId).toBeUndefined()
    expect(stored.sessions[0].history).toEqual([
      { kind: 'message', role: 'user', content: 'Accepted request' }
    ])
    await expect(agents.createAgentSession(settings)).rejects.toThrow('shutting down')
  })

  it('rejects a run still loading when shutdown sweeps controllers without entering a provider', async () => {
    const path = join(mocks.directory, 'agent-sessions.json')
    await fs.writeFile(path, sessions(session()))
    const entered = deferred()
    const gate = deferred()
    const readFile = fs.readFile.bind(fs)
    let gated = false
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === path && !gated) {
        gated = true
        entered.resolve()
        await gate.promise
      }
      return readFile(...args)
    })
    const agents = await import('./agentService')
    const run = agents.runAgentSession('existing', 'Admitted before loading', settings)
    const rejected = expect(run).rejects.toThrow('shutting down')
    await entered.promise
    const lifecycle = await import('./agentPersistenceLifecycle')
    lifecycle.pauseAgentPersistence()
    agents.stopAgentRuns()
    const drain = expect(lifecycle.drainAgentPersistence()).rejects.toThrow(
      'Pending agent persistence failed'
    )
    gate.resolve()
    await Promise.all([rejected, drain])
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect((await agents.loadAgentSessions()).sessions[0]).toMatchObject({
      status: 'idle',
      messages: [],
      history: []
    })
    lifecycle.resumeAgentPersistence()
    await agents.updateAgentSession('existing', { title: 'Usable after failed quit' }, 'openai')
  })

  it('does not let a concurrent run checkpoint undo a newly committed session', async () => {
    const started = deferred()
    const continueRun = deferred()
    const completed = deferred()
    mocks.runAgent.mockImplementation(async ({ messages, onEvent }) => {
      started.resolve()
      await continueRun.promise
      const answer = { kind: 'assistant' as const, content: 'Finished', toolCalls: [] }
      await onEvent({ type: 'assistant', message: answer })
      return {
        status: 'completed',
        content: 'Finished',
        history: [...messages, answer],
        rounds: 1,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      }
    })
    const agents = await import('./agentService')
    const existing = await agents.createAgentSession(settings)
    agents.setAgentEventSink((event) => {
      if (event.type === 'done') completed.resolve()
    })
    await agents.runAgentSession(existing.id, 'Concurrent request', settings)
    await started.promise
    const gate = deferred()
    const entered = deferred()
    const path = join(mocks.directory, 'agent-sessions.json')
    const rename = fs.rename.bind(fs)
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path && !gated) {
        gated = true
        entered.resolve()
        await gate.promise
      }
      return rename(from, to)
    })
    const creating = agents.createAgentSession(settings, 'Concurrent new session')
    await entered.promise
    continueRun.resolve()
    await Promise.resolve()
    gate.resolve()
    const created = await creating
    await completed.promise
    const stored = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(stored.sessions.map((item) => item.id)).toEqual([created.id, existing.id])
    expect(stored.sessions[1]).toMatchObject({ status: 'completed' })
    expect(stored.sessions[1].history.at(-1).content).toBe('Finished')
  })

  it('rechecks queued plan decisions after the first decision commits', async () => {
    const planned = session('planned')
    planned.mode = 'planning'
    planned.status = 'completed'
    planned.planReady = true
    planned.messages = [
      {
        id: 'completed-plan-fixture',
        role: 'assistant',
        content: 'Investigate the fixture.',
        timestamp
      }
    ]
    planned.history = [{ kind: 'assistant', content: 'Investigate the fixture.', toolCalls: [] }]
    const path = join(mocks.directory, 'agent-sessions.json')
    await fs.writeFile(path, sessions(planned))
    const agents = await import('./agentService')
    await agents.loadAgentSessions()
    const configuration = await import('./settingsService')
    await agents.enrollAgentAutoReview('planned', {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai',
      accountRevision: configuration.getSettings().agentDecisionAccountRevision!,
      activate: false
    })
    const entered = deferred()
    const gate = deferred()
    const rename = fs.rename.bind(fs)
    let gated = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path && !gated) {
        gated = true
        entered.resolve()
        await gate.promise
      }
      return rename(from, to)
    })
    const first = agents.resolveAgentPlan('planned', 'continue', settings)
    await entered.promise
    const duplicate = agents.resolveAgentPlan('planned', 'auto', settings, 'completed-plan-fixture')
    const refused = expect(duplicate).rejects.toThrow('completed plan')
    gate.resolve()
    await Promise.all([first, refused])
    expect((await agents.loadAgentSessions()).sessions[0]).toMatchObject({
      mode: 'planning',
      planReady: false
    })
    expect(mocks.runAgent).not.toHaveBeenCalled()
  })
})

it('retries a failed run checkpoint on quit without losing live error history', async () => {
  const agents = await import('./agentService')
  const existing = await agents.createAgentSession(settings)
  const path = join(mocks.directory, 'agent-sessions.json')
  let fail = false
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === path && fail) throw new Error('Injected checkpoint failure')
    return rename(from, to)
  })
  const terminal = deferred()
  agents.setAgentEventSink((event) => {
    if (event.type === 'error') terminal.resolve()
  })
  mocks.runAgent.mockImplementation(async ({ messages }) => {
    fail = true
    return {
      status: 'completed',
      content: 'Completed response',
      history: [...messages, { kind: 'assistant', content: 'Completed response', toolCalls: [] }],
      rounds: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    }
  })
  await agents.runAgentSession(existing.id, 'Accepted request', settings)
  await terminal.promise
  const lifecycle = await import('./agentPersistenceLifecycle')
  lifecycle.pauseAgentPersistence()
  agents.stopAgentRuns()
  await lifecycle.drainAgentPersistence()
  expect(JSON.parse(await fs.readFile(path, 'utf8')).sessions[0].status).toBe('running')
  await expect(agents.checkpointAgentSessionsBeforeQuit()).rejects.toThrow(
    'Injected checkpoint failure'
  )
  fail = false
  await agents.checkpointAgentSessionsBeforeQuit()
  const saved = JSON.parse(await fs.readFile(path, 'utf8')).sessions[0]
  expect(saved.status).toBe('error')
  expect(saved.error).toContain('Failed to save agent session')
  expect(saved.history.at(-1).content).toBe('Completed response')
  expect(saved.activeRunId).toBeUndefined()
  expect(mocks.runAgent).toHaveBeenCalledTimes(1)
})

it('cancellation while loading memories never enters the provider', async () => {
  const agents = await import('./agentService')
  const existing = await agents.createAgentSession(settings)
  const memoryPath = join(mocks.directory, 'agent-memories.json')
  const entered = deferred()
  const gate = deferred()
  const readFile = fs.readFile.bind(fs)
  let gated = false
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === memoryPath && !gated) {
      gated = true
      entered.resolve()
      await gate.promise
    }
    return readFile(...args)
  })
  await agents.runAgentSession(existing.id, 'Cancel before provider', settings)
  await entered.promise
  const lifecycle = await import('./agentPersistenceLifecycle')
  lifecycle.pauseAgentPersistence()
  agents.stopAgentRuns()
  const drain = lifecycle.drainAgentPersistence()
  gate.resolve()
  await drain
  expect(mocks.runAgent).not.toHaveBeenCalled()
  expect(mocks.commitMutation).not.toHaveBeenCalled()
  const saved = JSON.parse(await fs.readFile(join(mocks.directory, 'agent-sessions.json'), 'utf8'))
    .sessions[0]
  expect(saved.status).toBe('cancelled')
  expect(saved.activeRunId).toBeUndefined()
  expect(saved.history).toEqual([
    { kind: 'message', role: 'user', content: 'Cancel before provider' }
  ])
})
