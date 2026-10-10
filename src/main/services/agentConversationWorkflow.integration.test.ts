import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentAcceptedUpdate, AgentEvent, AgentResult } from '@ayayaq/vivi'
import {
  applyAgentRecord,
  createAgentProjection,
  projectAgentRecords,
  agentArgumentsDigest,
  type DurableAgentRecord
} from '@ayayaq/vivi/events'
import {
  applyAgentRunRecord,
  createAgentRunProjection,
  projectAgentRunRecords,
  type AgentRunRecord
} from '@ayayaq/vivi/events/stream'
import {
  emptyMcpCategory,
  mcpAlias,
  mcpDigest,
  type McpCatalogSnapshot,
  type McpPreparedOperation
} from '@ayayaq/vivi/extensions/mcp'
import type { AgentSession, AgentStreamEvent } from '../../shared/agentTypes'

const mocks = vi.hoisted(() => ({
  home: '',
  responses: vi.fn(),
  executeReadTool: vi.fn(),
  prepareMutation: vi.fn(),
  commitMutation: vi.fn(),
  captures: 0,
  invokes: 0,
  sends: 0,
  catalog: undefined as McpCatalogSnapshot | undefined,
  afterSend: undefined as (() => void) | undefined,
  operations: [] as McpPreparedOperation[],
  requests: [] as Array<Record<string, unknown>>,
  accepted: [] as AgentAcceptedUpdate[],
  events: [] as AgentEvent[],
  results: [] as AgentResult[]
}))

// Observe the real runner's acceptance boundary without replacing its execution or replay.
vi.mock('@ayayaq/vivi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ayayaq/vivi')>()
  return {
    ...actual,
    async runAgent(options: Parameters<typeof actual.runAgent>[0]) {
      const result = await actual.runAgent({
        ...options,
        async onAccepted(update) {
          mocks.accepted.push(structuredClone(update))
          await options.onAccepted?.(update)
        },
        async onEvent(event) {
          mocks.events.push(structuredClone(event))
          await options.onEvent?.(event)
        }
      })
      mocks.results.push(structuredClone(result))
      return result
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => mocks.home },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

// Resource effects are explicit offline fakes; session/journal/MCP persistence is real.
vi.mock('./agentTools', () => ({
  agentToolDefinitions: ['read_bot_state', 'edit_bot_state', 'edit_developer_prompt'].map(
    (name) => ({
      type: 'function',
      function: { name, description: name, parameters: { type: 'object', properties: {} } }
    })
  ),
  mutationToolNames: new Set(['edit_bot_state', 'edit_developer_prompt']),
  executeReadTool: mocks.executeReadTool,
  prepareMutation: mocks.prepareMutation,
  commitMutation: mocks.commitMutation,
  agentToolTargetLabel: () => 'Offline bot state',
  initializeMutationReviewResource: vi.fn(async () => undefined),
  currentMutationReviewRevision: () => 'offline-state-revision',
  currentMutationRuntimeReviewRevision: () => 0,
  readDecisionAuditResourceMetadata: vi.fn(),
  lintPreparedMutation: vi.fn(async () => [])
}))

vi.mock('./agentMemoryService', () => ({
  loadAgentMemories: vi.fn(async () => ({ memories: [] }))
}))

vi.mock('./agentMcpService', async () => {
  const core = await import('@ayayaq/vivi/extensions/mcp')
  const { assertAgentMcpPrivacy } = await import('./agentDecisionPrivacy')
  const validateSchema = () => (args: Record<string, unknown>) => {
    if (Object.keys(args).join(',') !== 'query' || args.query !== 'exact offline request')
      throw new Error('Unexpected synthetic MCP arguments')
  }
  return {
    agentMcpService: {
      validateSchema,
      assertAllowed(value: unknown) {
        core.assertMcpJson(value, 8 * 1024 * 1024, { nodes: 8 * 1024 * 1024, depth: 64 })
        assertAgentMcpPrivacy(value)
      },
      async captureCatalogs(signal: AbortSignal) {
        signal.throwIfAborted()
        mocks.captures++
        return mocks.catalog ? [mocks.catalog] : []
      },
      prepareOperation(snapshot, entry, kind, call) {
        return core.prepareMcpOperation(
          snapshot,
          entry,
          kind,
          call,
          'offline-record-launch',
          validateSchema
        )
      },
      operationDisclosure(operation: McpPreparedOperation) {
        return `${operation.serverId}/${operation.remoteKey}: ${JSON.stringify(operation.call.arguments)}`
      },
      async invoke(operation, signal, assertCurrent, hooks) {
        mocks.invokes++
        assertCurrent()
        await hooks.beforeSend()
        signal.throwIfAborted()
        assertCurrent()
        mocks.sends++
        mocks.operations.push(structuredClone(operation))
        mocks.afterSend?.()
        const failure = core.mcpFailure(
          'mcp_unknown_outcome',
          'Synthetic response unavailable after one recorded send',
          true
        )
        const result = {
          ...failure,
          content: JSON.stringify({
            ...JSON.parse(failure.content),
            requestSent: true,
            unknownOutcome: true,
            doNotRetry: true
          })
        }
        const outcome = {
          result,
          outcome: 'unknown',
          requestSent: true,
          unknownOutcome: true,
          doNotRetry: true
        }
        await hooks.settle(outcome)
        return outcome
      }
    }
  }
})

interface Journal {
  version: 1
  sessionId: string
  state: 'shadow'
  usageBasis: { legacyTotalTokens: number; inputOutput: 'since_anchor' }
  sessionRecords: DurableAgentRecord[]
  runs: Array<{ runId: string; baseSequence: number; records: AgentRunRecord[] }>
}

const settings = {
  aiProvider: 'openai' as const,
  openaiApiKey: 'offline-record-fixture-key',
  selectedAiModel: 'gpt-5.4-nano'
}
const remoteKey = 'offline/exact-state'
const remoteAlias = mcpAlias('fixture', 'tools', remoteKey)

function catalog(): McpCatalogSnapshot {
  const entries = [
    {
      remoteKey,
      alias: remoteAlias,
      descriptor: {
        name: remoteKey,
        description: 'Synthetic external state fixture',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
          additionalProperties: false
        }
      },
      state: 'available' as const
    }
  ]
  return {
    serverId: 'fixture',
    configRevision: 'offline-record-config',
    connectionGeneration: 'offline-record-connection',
    protocolVersion: '2025-11-25',
    catalogGeneration: 0,
    categories: {
      tools: { state: 'ready', entries, digest: mcpDigest(entries) },
      resources: emptyMcpCategory(),
      resourceTemplates: emptyMcpCategory()
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((done) => (resolve = done)), resolve }
}

function response(
  content: string,
  calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  usage: { input: number; output: number; total: number; cached?: number }
) {
  return {
    output_text: content,
    output: calls.map((call) => ({
      type: 'function_call',
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.arguments)
    })),
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.total,
      ...(usage.cached === undefined
        ? {}
        : { input_tokens_details: { cached_tokens: usage.cached } })
    }
  }
}

describe('desktop authoritative conversation records paired workflow', () => {
  let agent: typeof import('./agentService')

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.home = await fs.mkdtemp(join(tmpdir(), 'desktop-conversation-workflow-'))
    Object.assign(mocks, {
      captures: 0,
      invokes: 0,
      sends: 0,
      catalog: undefined,
      afterSend: undefined,
      operations: [],
      requests: [],
      accepted: [],
      events: [],
      results: []
    })
    mocks.responses.mockReset().mockRejectedValue(new Error('Unexpected offline provider round'))
    mocks.executeReadTool.mockReset().mockResolvedValue({ count: 2 })
    mocks.prepareMutation.mockReset().mockImplementation(async (name, arguments_) => ({
      name,
      arguments: arguments_,
      before: { count: 2 },
      after: { count: 3 },
      target: { type: 'bot_state' }
    }))
    mocks.commitMutation.mockReset().mockResolvedValue({ success: true, saved: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses')
          throw new Error('Only the explicit offline provider route is allowed')
        const request = JSON.parse(init.body)
        mocks.requests.push(request)
        const completed = { status: 'completed', ...(await mocks.responses(request)) }
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: completed })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      })
    )
    const appSettings = await import('./settingsService')
    appSettings.setSettings({ ...appSettings.getSettings(), ...settings })
    agent = await import('./agentService')
    const boundary = (await import('./agentMcpService')).agentMcpService
    expect(() => boundary.assertAllowed({ invalidOptional: undefined })).toThrow()
    expect(() => boundary.assertAllowed({ value: settings.openaiApiKey })).toThrow(
      'MCP data contains a known credential'
    )
  })

  afterEach(async () => {
    agent.stopAgentRuns()
    await agent.drainAgentRuns()
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent.setAgentEventSink(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    await fs.rm(mocks.home, { recursive: true, force: true })
  })

  async function start(
    sessionId: string,
    text: string,
    observe?: (event: AgentStreamEvent) => void
  ) {
    const approval = deferred<AgentStreamEvent>()
    const terminal = deferred<AgentStreamEvent>()
    agent.setAgentEventSink((event) => {
      observe?.(event)
      if (event.type === 'approval') approval.resolve(event)
      if (event.type === 'done' || event.type === 'error') terminal.resolve(event)
    })
    const { runId } = await agent.runAgentSession(sessionId, text, settings)
    return { runId, approval: approval.promise, terminal: terminal.promise }
  }

  async function saved(sessionId: string) {
    await agent.drainAgentRuns()
    const session = (await agent.loadAgentSessions()).sessions.find(
      (item) => item.id === sessionId
    )!
    const disk = JSON.parse(await fs.readFile(join(mocks.home, 'agent-sessions.json'), 'utf8'))
    expect(disk.sessions.find((item: AgentSession) => item.id === sessionId)).toEqual(
      JSON.parse(JSON.stringify(session))
    )
    return session
  }

  async function journal(sessionId: string): Promise<Journal> {
    const name = createHash('sha256').update(sessionId).digest('hex')
    return JSON.parse(await fs.readFile(join(mocks.home, 'agent-records', `${name}.json`), 'utf8'))
  }

  async function paired(session: AgentSession, legacyTotalTokens = 0) {
    const stored = await journal(session.id)
    expect(stored).toMatchObject({
      version: 1,
      sessionId: session.id,
      state: 'shadow',
      usageBasis: { legacyTotalTokens, inputOutput: 'since_anchor' }
    })
    const full = projectAgentRecords(session.id, stored.sessionRecords)
    const incremental = stored.sessionRecords.reduce(
      applyAgentRecord,
      createAgentProjection(session.id)
    )
    expect(incremental).toEqual(full)
    expect(applyAgentRecord(full, stored.sessionRecords[0])).toBe(full)
    expect(full.history.map((entry) => entry.message)).toEqual(session.history)
    expect(full.usage.totalTokens).toBe(session.tokenCount)
    for (const run of stored.runs) {
      const base = projectAgentRecords(session.id, stored.sessionRecords.slice(0, run.baseSequence))
      const replayed = projectAgentRunRecords(base, run.runId, run.records)
      const folded = run.records.reduce(
        applyAgentRunRecord,
        createAgentRunProjection(base, run.runId)
      )
      expect(folded).toEqual(replayed)
      expect(applyAgentRunRecord(replayed, run.records[0])).toBe(replayed)
      expect(replayed.state).toBe('settled')
      const terminal = run.records.at(-1)!
      expect(terminal.type).toBe('run_settled')
      if (terminal.type !== 'run_settled') throw new Error('Missing actual host terminal')
      expect(terminal.terminal).toEqual(stored.sessionRecords[run.baseSequence])
      expect(replayed.history).toEqual(replayed.session.history)
    }
    if (stored.runs.length) {
      const last = stored.runs.at(-1)!
      const base = projectAgentRecords(
        session.id,
        stored.sessionRecords.slice(0, last.baseSequence)
      )
      expect(projectAgentRunRecords(base, last.runId, last.records).session).toEqual(full)
    }
    return { stored, projection: full }
  }

  async function restart(sessionId: string) {
    await agent.drainAgentRuns()
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent.setAgentEventSink(null)
    const counts = {
      provider: mocks.responses.mock.calls.length,
      reads: mocks.executeReadTool.mock.calls.length,
      prepare: mocks.prepareMutation.mock.calls.length,
      commit: mocks.commitMutation.mock.calls.length,
      captures: mocks.captures,
      invokes: mocks.invokes,
      sends: mocks.sends
    }
    vi.resetModules()
    agent = await import('./agentService')
    const restored = (await agent.loadAgentSessions()).sessions.find(
      (item) => item.id === sessionId
    )!
    expect({
      provider: mocks.responses.mock.calls.length,
      reads: mocks.executeReadTool.mock.calls.length,
      prepare: mocks.prepareMutation.mock.calls.length,
      commit: mocks.commitMutation.mock.calls.length,
      captures: mocks.captures,
      invokes: mocks.invokes,
      sends: mocks.sends
    }).toEqual(counts)
    return restored
  }

  it('pairs actual successful turns with ordered replay and independent reported usage', async () => {
    mocks.responses
      .mockResolvedValueOnce(
        response('', [{ id: 'record-read', name: 'read_bot_state', arguments: {} }], {
          input: 5,
          output: 2,
          total: 19,
          cached: 2
        })
      )
      .mockResolvedValueOnce(
        response('The offline count is 2.', [], { input: 7, output: 3, total: 23 })
      )
      .mockResolvedValueOnce(
        response('Acknowledged offline.', [], { input: 1, output: 1, total: 7 })
      )
    const session = await agent.createAgentSession(settings)
    const first = await start(session.id, 'Inspect offline state')
    expect((await first.terminal).type).toBe('done')
    const firstSaved = await saved(session.id)
    const firstPair = await paired(firstSaved)
    expect(firstSaved.status).toBe('completed')
    expect(firstSaved.tokenCount).toBe(42)
    expect(firstSaved.lastRunMetrics).toMatchObject({
      runId: first.runId,
      providerRounds: 2,
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 42
    })
    expect(firstPair.projection.usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 42
    })
    expect(firstPair.stored.runs[0].records.map((record) => record.type)).toEqual([
      'run_started',
      'assistant_accepted',
      'tool_result_accepted',
      'assistant_accepted',
      'run_settled'
    ])
    expect(firstSaved.history!.find((message) => message.kind === 'tool_result')).toMatchObject({
      callId: 'record-read',
      name: 'read_bot_state',
      content: '{"count":2}',
      isError: false
    })
    const firstIds = firstPair.projection.history.map((entry) => entry.id)
    const second = await start(session.id, 'Acknowledge the inspected count')
    expect((await second.terminal).type).toBe('done')
    const secondSaved = await saved(session.id)
    const secondPair = await paired(secondSaved)
    expect(secondSaved.tokenCount).toBe(49)
    expect(secondPair.projection.usage).toEqual({
      inputTokens: 13,
      outputTokens: 6,
      totalTokens: 49
    })
    expect(
      secondPair.projection.history.slice(0, firstIds.length).map((entry) => entry.id)
    ).toEqual(firstIds)
    expect(secondPair.projection.runs.map((run) => run.runId)).toEqual([first.runId, second.runId])
    expect(mocks.executeReadTool).toHaveBeenCalledTimes(1)
    expect(mocks.responses).toHaveBeenCalledTimes(3)
    const restored = await restart(session.id)
    expect(restored.history).toEqual(secondSaved.history)
    expect(restored.messages).toEqual(secondSaved.messages)
    expect(restored.title).toBe('Inspect offline state')
    expect((await paired(restored)).stored).toEqual(secondPair.stored)
  })

  it('pairs a manually denied offline mutation without dispatching its resource effect', async () => {
    mocks.responses
      .mockResolvedValueOnce(
        response('', [{ id: 'record-denied', name: 'edit_bot_state', arguments: { count: 3 } }], {
          input: 3,
          output: 2,
          total: 17
        })
      )
      .mockResolvedValueOnce(
        response('The requested change was declined.', [], { input: 2, output: 1, total: 9 })
      )
    const session = await agent.createAgentSession(settings)
    const run = await start(session.id, 'Propose the offline counter change')
    const approval = await run.approval
    expect(approval.toolCall).toMatchObject({ id: 'record-denied', status: 'waiting_approval' })
    const pending = await journal(session.id)
    const pendingRun = pending.runs[0]
    const pendingBase = projectAgentRecords(
      session.id,
      pending.sessionRecords.slice(0, pendingRun.baseSequence)
    )
    const pendingProjection = projectAgentRunRecords(pendingBase, run.runId, pendingRun.records)
    const pendingIncremental = pendingRun.records.reduce(
      applyAgentRunRecord,
      createAgentRunProjection(pendingBase, run.runId)
    )
    expect(pendingIncremental).toEqual(pendingProjection)
    expect(pendingProjection.state).toBe('running')
    expect(pendingProjection.history.at(-1)!.message.kind).toBe('assistant')
    expect(pendingProjection.runUsage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 17 })
    const pendingSession = (await agent.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    expect(pendingProjection.history.map((entry) => entry.message)).toEqual(pendingSession.history)
    // Accepted usage is a partial run observation. The original main-store accounting
    // still advances at its round-completed/final reconciliation checkpoint.
    expect(pendingSession.tokenCount).toBe(0)
    expect(
      await agent.resolveAgentApproval(
        session.id,
        'record-denied',
        false,
        approval.toolCall!.approvalId
      )
    ).toBe(true)
    expect((await run.terminal).type).toBe('done')
    const final = await saved(session.id)
    const replay = await paired(final)
    expect(final.status).toBe('completed')
    expect(final.tokenCount).toBe(26)
    expect(mocks.prepareMutation).toHaveBeenCalledTimes(1)
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    // This host-only denial remains in authoritative display/history. The record adapter
    // does not invent exact-ledger effect evidence for an ordinary local tool result.
    expect(replay.projection.outcomes).toEqual([])
    const denied = final.history!.find(
      (message) => message.kind === 'tool_result' && message.callId === 'record-denied'
    )!
    expect(JSON.parse(denied.content)).toMatchObject({ success: false, denied: true })
    expect(final.messages.flatMap((message) => message.toolCalls ?? [])).toContainEqual(
      expect.objectContaining({
        id: 'record-denied',
        status: 'rejected',
        result: { success: false, denied: true, message: 'The user rejected this mutation' }
      })
    )
  })

  it.each(['unchanged', 'revision changed', 'scope changed', 'cancelled', 'cold reload'] as const)(
    'pairs a seven-day approval pause and resumes with %s current host state',
    async (change) => {
      // Only Date advances. Filesystem work and cancellation keep their real scheduling.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-10T00:00:00.000Z'))
      const tools = await vi.importActual<typeof import('./agentTools')>('./agentTools')
      const appSettings = await import('./settingsService')
      const { saveSettings } = await import('./fileService')
      const resources = await import('./resourceChangeService')
      const changed = vi.fn()
      resources.setResourceChangeEventSink(changed)
      const initial = 'Ordinary original creator guidance'
      const proposed = 'Ordinary proposed creator guidance'
      appSettings.setSettings({ ...appSettings.getSettings(), developerPrompt: initial })
      await saveSettings()
      const beforeSettings = await fs.readFile(join(mocks.home, 'settings.json'), 'utf8')
      const arguments_ = { expectedRevision: tools.revision(initial), content: proposed }
      mocks.prepareMutation.mockImplementation(tools.prepareMutation)
      mocks.commitMutation.mockImplementation(tools.commitMutation)
      mocks.responses
        .mockResolvedValueOnce(
          response(
            '',
            [{ id: 'record-paused', name: 'edit_developer_prompt', arguments: arguments_ }],
            {
              input: 3,
              output: 2,
              total: 17
            }
          )
        )
        .mockResolvedValueOnce(
          response('The paused proposal has been resolved.', [], { input: 2, output: 1, total: 9 })
        )
      const session = await agent.createAgentSession(settings)
      const run = await start(session.id, 'Review the ordinary creator guidance change')
      const approval = await run.approval
      expect(approval.toolCall).toMatchObject({
        id: 'record-paused',
        arguments: arguments_,
        status: 'waiting_approval',
        before: initial,
        after: proposed
      })
      // The approval event precedes its admitted canonical save. Observe the real disk
      // checkpoint before advancing the clock, rather than mistaking a live event for one.
      await vi.waitFor(async () => {
        const disk = JSON.parse(await fs.readFile(join(mocks.home, 'agent-sessions.json'), 'utf8'))
        expect(disk.sessions.find((item: AgentSession) => item.id === session.id).status).toBe(
          'waiting_approval'
        )
      })
      const pending = await journal(session.id)
      const retained = pending.runs[0]
      const base = projectAgentRecords(
        session.id,
        pending.sessionRecords.slice(0, retained.baseSequence)
      )
      const paused = projectAgentRunRecords(base, run.runId, retained.records)
      expect(
        retained.records.reduce(applyAgentRunRecord, createAgentRunProjection(base, run.runId))
      ).toEqual(paused)
      expect(paused).toMatchObject({
        state: 'running',
        runId: run.runId,
        sequence: 2,
        eventId: `${run.runId}:2`,
        baseSequence: base.sequence,
        baseEventId: base.eventId,
        baseReceiptDigest: base.receipts.at(-1)!.digest,
        runUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 17 }
      })
      expect(paused.receipts.at(-1)).toMatchObject({ eventId: paused.eventId, sequence: 2 })
      expect(paused.history.at(-1)!.message).toMatchObject({
        kind: 'assistant',
        toolCalls: [{ id: 'record-paused', name: 'edit_developer_prompt', arguments: arguments_ }]
      })
      expect(paused.history.some((entry) => entry.message.kind === 'tool_result')).toBe(false)
      for (const [index, entry] of paused.history.entries()) {
        expect(entry.id).toBe(`history:${index}`)
        expect(entry.source).toEqual({
          reference: `desktop/session/${session.id}/history/${index}`,
          revision: createHash('sha256').update(JSON.stringify(entry.message)).digest('hex')
        })
      }
      const raw = JSON.stringify(pending)
      expect(raw).not.toContain(approval.toolCall!.approvalId!)
      vi.setSystemTime(new Date('2026-10-17T00:00:00.000Z'))
      const afterWait = await journal(session.id)
      expect(afterWait).toEqual(pending)
      const fresh = JSON.parse(JSON.stringify(afterWait)) as Journal
      const freshBase = projectAgentRecords(
        session.id,
        fresh.sessionRecords.slice(0, retained.baseSequence)
      )
      expect(projectAgentRunRecords(freshBase, run.runId, fresh.runs[0].records)).toEqual(paused)
      expect(mocks.responses).toHaveBeenCalledTimes(1)
      expect(mocks.commitMutation).not.toHaveBeenCalled()
      expect(changed).not.toHaveBeenCalled()
      expect(appSettings.getSettings().developerPrompt).toBe(initial)
      expect(await fs.readFile(join(mocks.home, 'settings.json'), 'utf8')).toBe(beforeSettings)
      expect(
        await agent.resolveAgentApproval(session.id, 'record-paused', true, 'other-approval')
      ).toBe(false)

      if (change === 'cold reload') {
        // Keep the exact acknowledged waiting checkpoint, then stop the old owner before
        // reconstructing an ordinary interrupted-process image in this private test home.
        const sessionPath = join(mocks.home, 'agent-sessions.json')
        const shadowPath = join(
          mocks.home,
          'agent-records',
          `${createHash('sha256').update(session.id).digest('hex')}.json`
        )
        const sessionRaw = await fs.readFile(sessionPath, 'utf8')
        const shadowRaw = await fs.readFile(shadowPath, 'utf8')
        expect(agent.cancelAgentRun(session.id)).toBe(true)
        await run.terminal
        await saved(session.id)
        await fs.writeFile(sessionPath, sessionRaw)
        await fs.writeFile(shadowPath, shadowRaw)
        await fs.rm(`${sessionPath}.bak`, { force: true })
        await fs.rm(`${shadowPath}.bak`, { force: true })
        const reloaded = await restart(session.id)
        expect(reloaded.status).toBe('interrupted')
        expect(reloaded.activeRunId).toBeUndefined()
        expect(reloaded.tokenCount).toBe(0)
        expect(mocks.commitMutation).not.toHaveBeenCalled()
        expect(mocks.responses).toHaveBeenCalledTimes(1)
        expect(
          await agent.resolveAgentApproval(
            session.id,
            'record-paused',
            true,
            approval.toolCall!.approvalId
          )
        ).toBe(false)
        const restored = await journal(session.id)
        expect(restored.runs).toEqual(pending.runs)
        expect(restored.sessionRecords.at(-1)).toMatchObject({
          type: 'session_snapshot',
          reason: 'reconciliation'
        })
        const restoredProjection = projectAgentRecords(session.id, restored.sessionRecords)
        expect(
          restored.sessionRecords.reduce(applyAgentRecord, createAgentProjection(session.id))
        ).toEqual(restoredProjection)
        expect(restoredProjection.history.slice(0, paused.history.length)).toEqual(paused.history)
        expect(restoredProjection.history.map((entry) => entry.message)).toEqual(reloaded.history)
        expect(restoredProjection.usage).toEqual({
          inputTokens: 3,
          outputTokens: 2,
          totalTokens: 0
        })
        expect(restoredProjection.outcomes).toEqual([])
        expect(restoredProjection.runs).toEqual([])
        expect(projectAgentRunRecords(base, run.runId, restored.runs[0].records)).toEqual(paused)
        const restoredRaw = JSON.stringify(restored)
        await agent.loadAgentSessions()
        expect(JSON.stringify(await journal(session.id))).toBe(restoredRaw)

        // A later explicit request is a new run, with current settings and a fresh human
        // approval. No approval or tool execution is recovered from the old data cursor.
        await (await import('./fileService')).loadSettings()
        const currentSettings = await import('./settingsService')
        expect(currentSettings.getSettings().developerPrompt).toBe(initial)
        const currentTools = await vi.importActual<typeof import('./agentTools')>('./agentTools')
        mocks.prepareMutation.mockImplementation(currentTools.prepareMutation)
        mocks.commitMutation.mockImplementation(currentTools.commitMutation)
        mocks.responses
          .mockReset()
          .mockResolvedValueOnce(
            response(
              '',
              [{ id: 'record-fresh', name: 'edit_developer_prompt', arguments: arguments_ }],
              { input: 4, output: 1, total: 23 }
            )
          )
          .mockResolvedValueOnce(
            response('Freshly approved guidance saved.', [], { input: 2, output: 1, total: 9 })
          )
        const freshRun = await start(session.id, 'Review the guidance again after cold recovery')
        const freshApproval = await freshRun.approval
        expect(freshRun.runId).not.toBe(run.runId)
        expect(freshApproval.toolCall!.approvalId).not.toBe(approval.toolCall!.approvalId)
        expect(mocks.commitMutation).not.toHaveBeenCalled()
        expect(
          await agent.resolveAgentApproval(
            session.id,
            'record-paused',
            true,
            approval.toolCall!.approvalId
          )
        ).toBe(false)
        expect(
          await agent.resolveAgentApproval(
            session.id,
            'record-fresh',
            true,
            freshApproval.toolCall!.approvalId
          )
        ).toBe(true)
        await freshRun.terminal
        const freshFinal = await saved(session.id)
        const freshJournal = await journal(session.id)
        const freshProjection = projectAgentRecords(session.id, freshJournal.sessionRecords)
        expect(
          freshJournal.sessionRecords.reduce(applyAgentRecord, createAgentProjection(session.id))
        ).toEqual(freshProjection)
        expect(freshProjection.history.map((entry) => entry.message)).toEqual(freshFinal.history)
        expect(freshProjection.history.slice(0, paused.history.length)).toEqual(paused.history)
        const freshRetained = freshJournal.runs.at(-1)!
        const freshRunBase = projectAgentRecords(
          session.id,
          freshJournal.sessionRecords.slice(0, freshRetained.baseSequence)
        )
        const freshReplayed = projectAgentRunRecords(
          freshRunBase,
          freshRun.runId,
          freshRetained.records
        )
        expect(
          freshRetained.records.reduce(
            applyAgentRunRecord,
            createAgentRunProjection(freshRunBase, freshRun.runId)
          )
        ).toEqual(freshReplayed)
        expect(freshReplayed.state).toBe('settled')
        expect(freshReplayed.session).toEqual(freshProjection)
        expect(freshFinal.tokenCount).toBe(32)
        expect(freshProjection.usage.totalTokens).toBe(32)
        expect(mocks.commitMutation).toHaveBeenCalledOnce()
        expect(currentSettings.getSettings().developerPrompt).toBe(proposed)
        const freshRestored = await restart(session.id)
        expect(freshRestored.history).toEqual(freshFinal.history)
        expect(await journal(session.id)).toEqual(freshJournal)
        resources.setResourceChangeEventSink(null)
        return
      }

      if (change === 'revision changed') {
        appSettings.setSettings({
          ...appSettings.getSettings(),
          developerPrompt: 'Ordinary newer creator guidance'
        })
        await saveSettings()
      } else if (change === 'scope changed') {
        await agent.updateAgentSession(session.id, { mode: 'planning' }, 'openai')
      } else if (change === 'cancelled') {
        expect(agent.cancelAgentRun(session.id)).toBe(true)
      }
      expect(
        await agent.resolveAgentApproval(
          session.id,
          'record-paused',
          true,
          approval.toolCall!.approvalId
        )
      ).toBe(change === 'unchanged' || change === 'revision changed')
      expect((await run.terminal).type).toBe('done')
      const final = await saved(session.id)
      const replay = await paired(final)
      expect(replay.projection.history.slice(0, paused.history.length)).toEqual(paused.history)
      expect(replay.projection.outcomes).toEqual([])
      if (change === 'unchanged') {
        expect(mocks.commitMutation).toHaveBeenCalledOnce()
        expect(changed).toHaveBeenCalledOnce()
        expect(appSettings.getSettings().developerPrompt).toBe(proposed)
        expect(
          JSON.parse(await fs.readFile(join(mocks.home, 'settings.json'), 'utf8')).developerPrompt
        ).toBe(proposed)
        expect(final.status).toBe('completed')
        expect(final.tokenCount).toBe(26)
      } else if (change === 'revision changed') {
        // This is the real host revision lock/commit path, not a pre-scripted mock error.
        expect(mocks.commitMutation).toHaveBeenCalledOnce()
        expect(changed).not.toHaveBeenCalled()
        expect(appSettings.getSettings().developerPrompt).toBe('Ordinary newer creator guidance')
        expect(final.messages.flatMap((message) => message.toolCalls ?? [])).toContainEqual(
          expect.objectContaining({
            id: 'record-paused',
            status: 'error',
            error: expect.stringContaining('Stale resource revision')
          })
        )
        expect(final.tokenCount).toBe(26)
      } else {
        expect(mocks.commitMutation).not.toHaveBeenCalled()
        expect(changed).not.toHaveBeenCalled()
        expect(appSettings.getSettings().developerPrompt).toBe(initial)
        expect(final.status).toBe('cancelled')
        expect(final.tokenCount).toBe(17)
        expect(mocks.responses).toHaveBeenCalledTimes(1)
      }
      const reloaded = await restart(session.id)
      expect(reloaded.history).toEqual(final.history)
      expect(reloaded.messages).toEqual(final.messages)
      expect((await paired(reloaded)).stored).toEqual(replay.stored)
      expect(
        await agent.resolveAgentApproval(
          session.id,
          'record-paused',
          true,
          approval.toolCall!.approvalId
        )
      ).toBe(false)
      resources.setResourceChangeEventSink(null)
    }
  )

  it('pairs cancellation cleanup results absent from the canonical acceptance callbacks', async () => {
    mocks.responses.mockResolvedValueOnce(
      response(
        '',
        [
          { id: 'record-cancel-first', name: 'read_bot_state', arguments: {} },
          { id: 'record-cancel-later', name: 'read_bot_state', arguments: {} }
        ],
        { input: 4, output: 3, total: 31 }
      )
    )
    const session = await agent.createAgentSession(settings)
    const run = await start(session.id, 'Inspect two offline state views', (event) => {
      if (event.type === 'tool' && event.toolCall?.status === 'running')
        expect(agent.cancelAgentRun(session.id)).toBe(true)
    })
    expect((await run.terminal).type).toBe('done')
    const final = await saved(session.id)
    const replay = await paired(final)
    expect(final.status).toBe('cancelled')
    expect(final.tokenCount).toBe(31)
    expect(mocks.responses).toHaveBeenCalledTimes(1)
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    expect(mocks.accepted.map((update) => update.type)).toEqual(['assistant_accepted'])
    expect(mocks.events.filter((event) => event.type === 'tool_completed')).toEqual([])
    const closures = final.history!.filter((message) => message.kind === 'tool_result')
    expect(closures.map((message) => message.callId)).toEqual([
      'record-cancel-first',
      'record-cancel-later'
    ])
    expect(closures.every((message) => message.isError)).toBe(true)
    expect(replay.stored.runs[0].records.map((record) => record.type)).toEqual([
      'run_started',
      'assistant_accepted',
      'run_settled'
    ])
    expect(replay.projection.runs[0]).toMatchObject({
      runId: run.runId,
      status: 'cancelled',
      rounds: 1,
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 31 }
    })
    const restored = await restart(session.id)
    expect(restored.history).toEqual(final.history)
    expect((await paired(restored)).stored).toEqual(replay.stored)
  })

  it('imports legacy totals and display identities then restores records as data without dispatch', async () => {
    const legacy: AgentSession = {
      id: 'legacy-record-session',
      title: 'Preserved offline title',
      mode: 'manual',
      model: settings.selectedAiModel,
      reasoningEffort: 'none',
      status: 'completed',
      messages: [
        {
          id: 'legacy-user-display',
          role: 'user',
          content: 'Earlier offline question',
          timestamp: '2026-01-01T00:00:00.000Z'
        },
        {
          id: 'legacy-assistant-display',
          role: 'assistant',
          content: 'Earlier offline answer',
          timestamp: '2026-01-01T00:00:01.000Z'
        }
      ],
      history: [
        { kind: 'message', role: 'user', content: 'Earlier offline question' },
        { kind: 'assistant', content: 'Earlier offline answer', toolCalls: [] }
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
      planReady: false,
      tokenCount: 97
    }
    await fs.writeFile(
      join(mocks.home, 'agent-sessions.json'),
      JSON.stringify({
        sessions: [legacy],
        activeSessionId: legacy.id,
        modelDefaultsByProvider: {}
      })
    )
    const restoredLegacy = (await agent.loadAgentSessions()).sessions[0]
    expect(restoredLegacy.messages).toEqual(legacy.messages)
    expect(restoredLegacy.title).toBe(legacy.title)
    const anchor = await paired(restoredLegacy, 97)
    expect(anchor.stored.runs).toEqual([])
    expect(anchor.projection.runs).toEqual([])
    expect(anchor.projection.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 97 })
    expect(mocks.responses).not.toHaveBeenCalled()
    expect(mocks.captures).toBe(0)
    mocks.responses.mockResolvedValueOnce(
      response('New offline answer.', [], { input: 3, output: 2, total: 11 })
    )
    const run = await start(legacy.id, 'New offline question')
    expect((await run.terminal).type).toBe('done')
    const final = await saved(legacy.id)
    const replay = await paired(final, 97)
    expect(final.tokenCount).toBe(108)
    expect(replay.projection.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 108 })
    expect(final.title).toBe(legacy.title)
    expect(final.messages.slice(0, 2)).toEqual(legacy.messages)
    expect(replay.projection.history.slice(0, 2)).toEqual(anchor.projection.history)
    const reloaded = await restart(legacy.id)
    expect(reloaded.history).toEqual(final.history)
    expect(reloaded.messages).toEqual(final.messages)
    expect(reloaded.title).toBe(legacy.title)
    expect((await paired(reloaded, 97)).stored).toEqual(replay.stored)
  })

  it('pairs exact human-denied MCP evidence and reloads its denial without dispatch', async () => {
    mocks.catalog = catalog()
    const continued = deferred<void>()
    const finish = deferred<void>()
    mocks.responses
      .mockResolvedValueOnce(
        response(
          '',
          [
            {
              id: 'record-mcp-denied',
              name: remoteAlias,
              arguments: { query: 'exact offline request' }
            }
          ],
          { input: 5, output: 2, total: 21 }
        )
      )
      .mockImplementationOnce(async () => {
        continued.resolve()
        await finish.promise
        return response('The exact external request was declined.', [], {
          input: 2,
          output: 1,
          total: 13
        })
      })
    const session = await agent.createAgentSession(settings)
    const run = await start(session.id, 'Propose the exact synthetic external state request')
    const observed = await (async () => {
      try {
        const approval = await run.approval
        expect(approval.toolCall?.mcp).toMatchObject({
          runId: run.runId,
          serverId: 'fixture',
          remoteKey,
          outcome: 'pending'
        })
        expect(
          await agent.resolveAgentApproval(
            session.id,
            'record-mcp-denied',
            false,
            approval.toolCall!.approvalId
          )
        ).toBe(true)
        // Hold only the fake final provider reply so the committed exact ledger can be
        // independently loaded before the existing terminal checkpoint acknowledges it.
        await continued.promise
        const boundary = (await import('./agentMcpService')).agentMcpService
        const { createAgentMcpOutcomeLedger } = await import('./agentMcpOutcomes')
        const ledger = createAgentMcpOutcomeLedger({
          path: join(mocks.home, 'agent-mcp', 'outcomes.json'),
          assertAllowed: (value) => boundary.assertAllowed(value)
        })
        await ledger.load()
        const exact = ledger.records()
        expect(exact).toHaveLength(1)
        expect(exact[0]).toMatchObject({
          sessionId: session.id,
          runId: run.runId,
          call: {
            id: 'record-mcp-denied',
            name: remoteAlias,
            arguments: { query: 'exact offline request' }
          },
          serverId: 'fixture',
          remoteKey,
          outcome: 'not-sent',
          requestSent: false,
          unknownOutcome: false,
          doNotRetry: false
        })
        const body = JSON.parse(exact[0].result!.content)
        expect(body).toMatchObject({
          denied: true,
          requestSent: false,
          unknownOutcome: false,
          doNotRetry: false,
          untrusted: true
        })
        expect(mocks.invokes).toBe(0)
        expect(mocks.sends).toBe(0)
        const pendingSession = (await agent.loadAgentSessions()).sessions.find(
          (item) => item.id === session.id
        )!
        const pending = await journal(session.id)
        const pendingRun = pending.runs[0]
        const base = projectAgentRecords(
          session.id,
          pending.sessionRecords.slice(0, pendingRun.baseSequence)
        )
        const accepted = projectAgentRunRecords(base, run.runId, pendingRun.records)
        expect(accepted.history.map((entry) => entry.message)).toEqual(pendingSession.history)
        return {
          exact: exact[0],
          pendingSession,
          historyIds: accepted.history.map((entry) => entry.id)
        }
      } finally {
        finish.resolve()
      }
    })()
    expect((await run.terminal).type).toBe('done')
    const final = await saved(session.id)
    const replay = await paired(final)
    expect(final.status).toBe('completed')
    expect(final.tokenCount).toBe(34)
    expect(mocks.invokes).toBe(0)
    expect(mocks.sends).toBe(0)
    expect(mocks.operations).toEqual([])
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    expect(mocks.responses).toHaveBeenCalledTimes(2)
    expect(replay.projection.outcomes).toContainEqual(
      expect.objectContaining({
        callId: 'record-mcp-denied',
        runId: run.runId,
        name: remoteAlias,
        argumentsDigest: agentArgumentsDigest({ query: 'exact offline request' }),
        status: 'denied',
        effect: 'not_attempted'
      })
    )
    const denial = final.history!.find(
      (message) => message.kind === 'tool_result' && message.callId === 'record-mcp-denied'
    )!
    expect(denial).toMatchObject({
      callId: 'record-mcp-denied',
      name: remoteAlias,
      content: observed.exact.result!.content,
      isError: true
    })
    const display = final.messages.find((message) =>
      message.toolCalls?.some((call) => call.id === 'record-mcp-denied')
    )!
    expect(display.content).toBe(observed.exact.result!.content)
    expect(display.toolCalls![0]).toMatchObject({
      id: 'record-mcp-denied',
      status: 'rejected',
      mcp: { outcome: 'not-sent', requestSent: false }
    })
    expect(
      final.messages.slice(0, observed.pendingSession.messages.length).map((message) => message.id)
    ).toEqual(observed.pendingSession.messages.map((message) => message.id))
    expect(
      replay.projection.history.slice(0, observed.historyIds.length).map((entry) => entry.id)
    ).toEqual(observed.historyIds)
    const reloaded = await restart(session.id)
    expect(reloaded.history).toEqual(final.history)
    expect(reloaded.messages).toEqual(final.messages)
    expect((await paired(reloaded)).stored).toEqual(replay.stored)
    expect(mocks.invokes).toBe(0)
    expect(mocks.sends).toBe(0)
  })

  it('keeps actual successful history and usage authoritative when the shadow file is corrupt', async () => {
    mocks.responses.mockResolvedValueOnce(
      response('Ordinary offline conversation completed.', [], { input: 2, output: 1, total: 37 })
    )
    const session = await agent.createAgentSession(settings)
    const name = createHash('sha256').update(session.id).digest('hex')
    const path = join(mocks.home, 'agent-records', `${name}.json`)
    const corrupted = '{ordinary incomplete json'
    await fs.mkdir(join(mocks.home, 'agent-records'), { recursive: true })
    await fs.writeFile(path, corrupted)
    const run = await start(session.id, 'Discuss the ordinary offline fixture')
    expect((await run.terminal).type).toBe('done')
    const final = await saved(session.id)
    expect(final.status).toBe('completed')
    expect(final.tokenCount).toBe(37)
    expect(final.lastRunMetrics).toMatchObject({
      runId: run.runId,
      providerRounds: 1,
      inputTokens: 2,
      outputTokens: 1,
      totalTokens: 37
    })
    expect(final.history).toEqual([
      { kind: 'message', role: 'user', content: 'Discuss the ordinary offline fixture' },
      {
        kind: 'assistant',
        content: 'Ordinary offline conversation completed.',
        toolCalls: [],
        providerState: { provider: `openai:${settings.selectedAiModel}`, items: [] }
      }
    ])
    expect(
      final.messages.map((message) => ({ role: message.role, content: message.content }))
    ).toEqual([
      { role: 'user', content: 'Discuss the ordinary offline fixture' },
      { role: 'assistant', content: 'Ordinary offline conversation completed.' }
    ])
    expect(await fs.readFile(path, 'utf8')).toBe(corrupted)
    const restored = await restart(session.id)
    expect(restored.history).toEqual(final.history)
    expect(restored.messages).toEqual(final.messages)
    expect(restored.tokenCount).toBe(37)
    expect(await fs.readFile(path, 'utf8')).toBe(corrupted)
    expect(mocks.responses).toHaveBeenCalledTimes(1)
    expect(mocks.executeReadTool).not.toHaveBeenCalled()
    expect(mocks.prepareMutation).not.toHaveBeenCalled()
    expect(mocks.commitMutation).not.toHaveBeenCalled()
    expect(mocks.invokes).toBe(0)
    expect(mocks.sends).toBe(0)
  })

  it('pairs exact unknown MCP evidence after one synthetic send and reloads without retry', async () => {
    mocks.catalog = catalog()
    mocks.responses.mockResolvedValueOnce(
      response(
        '',
        [
          {
            id: 'record-mcp-exact',
            name: remoteAlias,
            arguments: { query: 'exact offline request' }
          }
        ],
        { input: 6, output: 2, total: 29 }
      )
    )
    const session = await agent.createAgentSession(settings)
    const run = await start(session.id, 'Use the exact synthetic external state request')
    const approval = await run.approval
    expect(approval.toolCall?.mcp).toMatchObject({
      serverId: 'fixture',
      remoteKey,
      outcome: 'pending'
    })
    expect(mocks.sends).toBe(0)
    mocks.afterSend = () => agent.cancelAgentRun(session.id)
    expect(
      await agent.resolveAgentApproval(
        session.id,
        'record-mcp-exact',
        true,
        approval.toolCall!.approvalId
      )
    ).toBe(true)
    expect((await run.terminal).type).toBe('done')
    const final = await saved(session.id)
    const replay = await paired(final)
    expect(final.status).toBe('cancelled')
    expect(final.tokenCount).toBe(29)
    expect(mocks.sends).toBe(1)
    expect(mocks.responses).toHaveBeenCalledTimes(1)
    expect(mocks.operations[0]).toMatchObject({
      serverId: 'fixture',
      remoteKey,
      call: {
        id: 'record-mcp-exact',
        name: remoteAlias,
        arguments: { query: 'exact offline request' }
      }
    })
    const exactResult = final.history!.find(
      (message) => message.kind === 'tool_result' && message.callId === 'record-mcp-exact'
    )!
    expect(exactResult.kind).toBe('tool_result')
    expect(JSON.parse(exactResult.content)).toMatchObject({
      requestSent: true,
      unknownOutcome: true,
      doNotRetry: true,
      untrusted: true
    })
    expect(replay.projection.outcomes).toContainEqual(
      expect.objectContaining({
        callId: 'record-mcp-exact',
        runId: run.runId,
        name: remoteAlias,
        argumentsDigest: agentArgumentsDigest({ query: 'exact offline request' }),
        status: 'unknown',
        effect: 'unknown'
      })
    )
    expect(mocks.accepted.map((update) => update.type)).toEqual(['assistant_accepted'])
    const reloaded = await restart(session.id)
    expect(reloaded.history).toEqual(final.history)
    expect(reloaded.messages).toEqual(final.messages)
    expect((await paired(reloaded)).stored).toEqual(replay.stored)
    expect(mocks.sends).toBe(1)
  })
})
