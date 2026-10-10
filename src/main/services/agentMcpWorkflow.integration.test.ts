import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession, AgentStreamEvent } from '../../shared/agentTypes'
import {
  emptyMcpCategory,
  mcpAlias,
  mcpDigest,
  MCP_GUIDANCE,
  type McpCatalogSnapshot
} from '@ayayaq/vivi/extensions/mcp'

const mocks = vi.hoisted(() => ({
  home: '',
  captures: 0,
  sends: 0,
  rounds: 0,
  catalog: undefined as McpCatalogSnapshot | undefined,
  phase: 'confirmed' as 'confirmed' | 'unknown',
  afterIntent: undefined as (() => void) | undefined,
  afterSend: undefined as (() => void) | undefined,
  reply: 'OFFLINE_RESPONSE',
  tool: '',
  requests: [] as Array<Record<string, unknown>>,
  executed: [] as Array<{ name: string; isError?: boolean }>
}))
vi.mock('@ayayaq/vivi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ayayaq/vivi')>()
  return {
    ...actual,
    runAgent: (options: Parameters<typeof actual.runAgent>[0]) =>
      actual.runAgent({
        ...options,
        executeTool: async (call, context) => {
          const result = await options.executeTool!(call, context)
          mocks.executed.push({ name: call.name, isError: result.isError })
          return result
        }
      })
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
vi.mock('./agentMcpService', async () => {
  const core = await import('@ayayaq/vivi/extensions/mcp')
  const validateSchema = () => (args: Record<string, unknown>) => {
    if (
      Object.keys(args).join(',') !== 'query' ||
      typeof args.query !== 'string' ||
      args.query.length > 100
    )
      throw new Error('Invalid offline arguments')
  }
  return {
    agentMcpService: {
      validateSchema,
      assertAllowed() {},
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
          'fixture-launch',
          validateSchema
        )
      },
      operationDisclosure(operation) {
        return `Exact offline external request: ${operation.serverId}/${operation.remoteKey}\n${JSON.stringify(operation.call.arguments)}`
      },
      async invoke(operation, signal, assertCurrent, hooks) {
        assertCurrent()
        await hooks.beforeSend()
        mocks.afterIntent?.()
        const requestSent = !signal.aborted
        if (requestSent) {
          assertCurrent()
          mocks.sends++
          mocks.afterSend?.()
        }
        const unknown = requestSent && mocks.phase === 'unknown'
        const projected = !requestSent
          ? core.mcpFailure('mcp_not_attempted', 'Cancelled before send')
          : unknown
            ? core.mcpFailure('mcp_unknown_outcome', 'Offline response lost after send', true)
            : core.projectMcpResult(
                operation.serverId,
                'tools/call',
                operation.remoteKey,
                { content: [{ type: 'text', text: mocks.reply }] },
                () => undefined
              )
        const result = {
          ...projected,
          content: JSON.stringify({
            ...JSON.parse(projected.content),
            requestSent,
            unknownOutcome: unknown,
            doNotRetry: unknown
          })
        }
        const outcome = {
          result,
          outcome: !requestSent ? 'not-sent' : unknown ? 'unknown' : 'confirmed',
          requestSent,
          unknownOutcome: unknown,
          doNotRetry: unknown
        }
        await hooks.settle(outcome)
        return outcome
      }
    }
  }
})
const settings = {
  aiProvider: 'openai' as const,
  openaiApiKey: 'offline-fixture-key',
  selectedAiModel: 'gpt-5.4-nano'
}
const remoteName = 'fixture/name'
const alias = mcpAlias('fixture', 'tools', remoteName)
const callId = 'offline-mcp-call'
function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((settle) => (resolve = settle)),
    resolve: (value: T) => resolve(value)
  }
}
function catalog(): McpCatalogSnapshot {
  const tools = [
    {
      remoteKey: remoteName,
      alias,
      descriptor: {
        name: remoteName,
        description: 'Untrusted offline descriptor',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string', maxLength: 100 } },
          required: ['query'],
          additionalProperties: false
        }
      },
      state: 'available' as const
    }
  ]
  const resources = [
    {
      remoteKey: 'fixture:///exact',
      alias: mcpAlias('fixture', 'resources', 'fixture:///exact'),
      descriptor: { name: 'Exact', uri: 'fixture:///exact' },
      state: 'available' as const
    }
  ]
  return {
    serverId: 'fixture',
    configRevision: 'fixture-config',
    connectionGeneration: 'fixture-connection',
    protocolVersion: '2025-11-25',
    catalogGeneration: 0,
    categories: {
      tools: { state: 'ready', entries: tools, digest: mcpDigest(tools) },
      resources: { state: 'ready', entries: resources, digest: mcpDigest(resources) },
      resourceTemplates: emptyMcpCategory()
    }
  }
}
describe('desktop MCP inside the existing Vivi agent loop', () => {
  let agent: typeof import('./agentService')
  let terminals: Promise<AgentStreamEvent>[]
  beforeEach(async () => {
    vi.resetModules()
    mocks.home = join(await fs.mkdtemp(join(tmpdir(), 'desktop-mcp-workflow-')), 'state')
    await fs.mkdir(mocks.home)
    Object.assign(mocks, {
      captures: 0,
      sends: 0,
      rounds: 0,
      catalog: catalog(),
      phase: 'confirmed',
      afterIntent: undefined,
      afterSend: undefined,
      reply: 'OFFLINE_RESPONSE',
      requests: [],
      executed: [],
      tool: alias
    })
    terminals = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses')
          throw new Error('Live transport is forbidden in this fixture')
        mocks.requests.push(JSON.parse(init.body))
        mocks.rounds++
        const reply =
          mocks.rounds === 1 && mocks.tool
            ? {
                output_text: '',
                output: [
                  {
                    type: 'function_call',
                    call_id: callId,
                    name: mocks.tool,
                    arguments: JSON.stringify(
                      mocks.tool === 'list_mcp_resources' ? {} : { query: 'offline query' }
                    )
                  }
                ]
              }
            : { output_text: 'Finished offline.', output: [] }
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', ...reply, usage: {} } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      })
    )
    agent = await import('./agentService')
  })
  afterEach(async () => {
    agent.stopAgentRuns()
    await Promise.all(terminals)
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent.setAgentEventSink(null)
    vi.unstubAllGlobals()
    await fs.rm(join(mocks.home, '..'), { recursive: true, force: true })
  })
  async function start(mode: AgentSession['mode'] = 'manual') {
    const session = await agent.createAgentSession(settings)
    if (mode === 'auto') {
      const appSettings = await import('./settingsService')
      appSettings.setSettings({ ...appSettings.getSettings(), ...settings })
      await agent.enrollAgentAutoReview(session.id, {
        policyRevision: (await import('../../shared/agentAutoReview')).AUTO_REVIEW_POLICY_REVISION,
        provider: 'openai',
        accountRevision: appSettings.getSettings().agentDecisionAccountRevision!
      })
    } else await agent.updateAgentSession(session.id, { mode }, 'openai')
    const approval = deferred<AgentStreamEvent>(),
      terminal = deferred<AgentStreamEvent>()
    terminals.push(terminal.promise)
    agent.setAgentEventSink((event) => {
      if (event.type === 'approval') approval.resolve(event)
      if (event.type === 'done' || event.type === 'error') {
        approval.resolve(event)
        terminal.resolve(event)
      }
    })
    await agent.runAgentSession(session.id, 'Use the offline MCP fixture.', settings)
    return { session, approval: approval.promise, terminal: terminal.promise }
  }
  async function saved(id: string) {
    return (await agent.loadAgentSessions()).sessions.find((session) => session.id === id)!
  }
  function result(session: AgentSession) {
    return session.history!.find(
      (message) => message.kind === 'tool_result' && message.callId === callId
    )!
  }
  async function decide(
    subject: Awaited<ReturnType<typeof start>>,
    approved: boolean,
    priorSends = 0
  ) {
    const event = await subject.approval
    expect(event.type).toBe('approval')
    expect(event.toolCall?.mcp).toMatchObject({
      serverId: 'fixture',
      remoteKey: remoteName,
      outcome: 'pending'
    })
    expect(mocks.sends).toBe(priorSends)
    expect(await agent.resolveAgentApproval(subject.session.id, callId, approved, 'stale-id')).toBe(
      false
    )
    expect(
      await agent.resolveAgentApproval(
        subject.session.id,
        callId,
        approved,
        event.toolCall!.approvalId
      )
    ).toBe(true)
    expect(
      await agent.resolveAgentApproval(
        subject.session.id,
        callId,
        approved,
        event.toolCall!.approvalId
      )
    ).toBe(false)
    return subject.terminal
  }
  for (const mode of ['manual', 'auto'] as const)
    for (const approved of [true, false])
      it(`${mode} requires exact human approval (${approved})`, async () => {
        const subject = await start(mode)
        await decide(subject, approved)
        const session = await saved(subject.session.id)
        expect(session.status).toBe('completed')
        expect(mocks.sends).toBe(approved ? 1 : 0)
        expect(mocks.captures).toBe(1)
        expect(JSON.stringify(mocks.requests[0])).toContain(MCP_GUIDANCE)
        expect(mocks.executed.find((entry) => entry.name === alias)?.isError).toBe(!approved)
        expect(JSON.parse(result(session).content)).toMatchObject({
          requestSent: approved,
          untrusted: true
        })
        expect(
          session.messages
            .flatMap((message) => message.toolCalls ?? [])
            .find((call) => call.id === callId)?.decision
        ).toBeUndefined()
        if (!approved) expect(JSON.parse(result(session).content).denied).toBe(true)
      })
  it('Planning exposes captured metadata only and withholds every remote operation', async () => {
    mocks.tool = 'list_mcp_resources'
    const subject = await start('planning')
    await subject.terminal
    expect(mocks.sends).toBe(0)
    const tools = mocks.requests[0].tools as Array<{ name: string }>
    expect(tools.some((tool) => tool.name === 'list_mcp_resources')).toBe(true)
    expect(tools.some((tool) => tool.name === alias || tool.name === 'read_mcp_resource')).toBe(
      false
    )
    expect(JSON.parse(result(await saved(subject.session.id)).content).localMetadataOnly).toBe(true)
  })
  it('no connected catalogs leaves ordinary chat available', async () => {
    mocks.catalog = undefined
    mocks.tool = ''
    const subject = await start()
    await subject.terminal
    expect((await saved(subject.session.id)).status).toBe('completed')
    expect(mocks.sends).toBe(0)
    expect(
      (mocks.requests[0].tools as Array<{ name: string }>).some((tool) => tool.name.includes('mcp'))
    ).toBe(false)
  })
  it('cancellation while human approval waits records not attempted', async () => {
    const subject = await start()
    await subject.approval
    agent.cancelAgentRun(subject.session.id)
    await subject.terminal
    expect(mocks.sends).toBe(0)
    expect(JSON.parse(result(await saved(subject.session.id)).content).requestSent).toBe(false)
  })
  it('cancellation after durable intent sends zero requests and retains not attempted', async () => {
    const subject = await start()
    mocks.afterIntent = () => agent.cancelAgentRun(subject.session.id)
    await decide(subject, true)
    expect(mocks.sends).toBe(0)
    expect(JSON.parse(result(await saved(subject.session.id)).content).requestSent).toBe(false)
  })
  it('one sent request with lost response retains unknown/do-not-retry across restart', async () => {
    mocks.phase = 'unknown'
    const subject = await start()
    mocks.afterSend = () => agent.cancelAgentRun(subject.session.id)
    await decide(subject, true)
    const session = await saved(subject.session.id)
    expect(mocks.sends).toBe(1)
    expect(session.status).toBe('cancelled')
    expect(JSON.parse(result(session).content)).toMatchObject({
      requestSent: true,
      unknownOutcome: true,
      doNotRetry: true,
      untrusted: true
    })
    vi.resetModules()
    agent = await import('./agentService')
    expect(JSON.parse(result(await saved(subject.session.id)).content).doNotRetry).toBe(true)
    expect(mocks.sends).toBe(1)
  })
  it('confirmed28000-character response survives cancellation and generic clipping', async () => {
    mocks.reply = 'Z'.repeat(28_000)
    const subject = await start()
    mocks.afterSend = () => agent.cancelAgentRun(subject.session.id)
    await decide(subject, true)
    const body = JSON.parse(result(await saved(subject.session.id)).content)
    expect(body).toMatchObject({ success: true, requestSent: true, untrusted: true })
    expect(body.content[0].text).toHaveLength(28_000)
    expect(body.truncated).toBeUndefined()
  })
  it('acknowledges old recovered scopes after checkpoint and admits a fresh approved run', async () => {
    mocks.phase = 'unknown'
    const first = await start()
    await decide(first, true)
    const interrupted = await saved(first.session.id)
    const call = interrupted.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.id === callId)!
    const core = await import('@ayayaq/vivi/extensions/mcp')
    const service = (await import('./agentMcpService')).agentMcpService
    expect(call.arguments).toEqual({ query: 'offline query' })
    const operation = core.prepareMcpOperation(
      mocks.catalog!,
      mocks.catalog!.categories.tools.entries[0],
      'tools',
      { id: callId, name: alias, arguments: { query: 'offline query' } },
      'fixture-launch',
      service.validateSchema
    )
    const path = join(mocks.home, 'agent-mcp', 'outcomes.json')
    const { createAgentMcpOutcomeLedger } = await import('./agentMcpOutcomes')
    const retained = createAgentMcpOutcomeLedger({ path, assertAllowed: () => undefined })
    await retained.load()
    const scope = { sessionId: first.session.id, runId: call.mcp!.runId }
    await retained.intent(scope, operation)
    await retained.settle(scope, operation, {
      result: core.mcpFailure('mcp_unknown_outcome', 'Offline response lost after send', true),
      outcome: 'unknown',
      requestSent: true,
      unknownOutcome: true,
      doNotRetry: true
    })
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records).toHaveLength(1)
    vi.resetModules()
    agent = await import('./agentService')
    expect(JSON.parse(result(await saved(first.session.id)).content).doNotRetry).toBe(true)
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records).toEqual([])
    const checkpoint = JSON.parse(
      await fs.readFile(join(mocks.home, 'agent-sessions.json'), 'utf8')
    )
    expect(
      JSON.parse(
        result(checkpoint.sessions.find((session) => session.id === first.session.id)).content
      ).doNotRetry
    ).toBe(true)
    mocks.phase = 'confirmed'
    mocks.rounds = 0
    const next = await start()
    await decide(next, true, 1)
    expect(mocks.sends).toBe(2)
    expect(JSON.parse(result(await saved(next.session.id)).content).success).toBe(true)
  })
})
