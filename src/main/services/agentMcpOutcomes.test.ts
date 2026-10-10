import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgent, type ToolCall } from '@ayayaq/vivi'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import { AgentMcpService } from './agentMcpService'
import { McpConfigStore } from './agentMcpConfig'
import {
  collectMcpCategory,
  emptyMcpCategory,
  mcpFailure,
  prepareMcpOperation,
  projectMcpResult,
  type McpCatalogSnapshot,
  type McpPreparedOperation,
  type McpSchemaValidator
} from '@ayayaq/vivi/extensions/mcp'
import type { AgentSession } from '../../shared/agentTypes'
import {
  createAgentMcpOutcomeLedger,
  MAX_AGENT_MCP_OUTCOME_RECORDS,
  MAX_AGENT_MCP_OUTCOME_BYTES,
  reconcileAgentMcpOutcomes,
  type AgentMcpOutcome,
  type AgentMcpOutcomeRecord
} from './agentMcpOutcomes'
import { closeAndDrainAtomicWrites, reopenAtomicWrites } from './atomicPersistence'
import {
  pauseAgentPersistence,
  resumeAgentPersistence,
  withAgentPersistenceOperation
} from './agentPersistenceLifecycle'

vi.mock('electron', () => ({ app: { getPath: () => '/unused-offline-mcp-ledger-state' } }))

let directory: string
let path: string
const scope = { sessionId: 'session-1', runId: 'run-1' }
const assertAllowed = (value: unknown): void => {
  if (JSON.stringify(value).includes('offline-credential-marker'))
    throw new Error('Private content withheld')
}
const validateSchema: McpSchemaValidator = () => () => undefined
function ledger() {
  return createAgentMcpOutcomeLedger({ path, assertAllowed })
}
async function operation(
  id = 'call-1',
  kind: 'tools' | 'resources' = 'tools',
  arguments_ = { query: 'hello' }
): Promise<McpPreparedOperation> {
  const tools = await collectMcpCategory(
    'docs',
    'tools',
    async () => ({
      tools: [
        {
          name: 'lookup/name',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            additionalProperties: false
          }
        }
      ]
    }),
    new AbortController().signal,
    validateSchema
  )
  const resources = await collectMcpCategory(
    'docs',
    'resources',
    async () => ({ resources: [{ uri: 'docs://exact', name: 'Exact' }] }),
    new AbortController().signal,
    validateSchema
  )
  const snapshot: McpCatalogSnapshot = {
    serverId: 'docs',
    configRevision: 'config-1',
    connectionGeneration: 'connection-1',
    protocolVersion: '2026-07-28',
    catalogGeneration: 1,
    categories: { tools, resources, resourceTemplates: emptyMcpCategory() }
  }
  const entry = snapshot.categories[kind].entries[0]
  const call: ToolCall = {
    id,
    name: kind === 'tools' ? entry.alias : 'read_mcp_resource',
    arguments: kind === 'tools' ? arguments_ : { serverId: 'docs', uri: 'docs://exact' }
  }
  return prepareMcpOperation(snapshot, entry, kind, call, 'launch-1', validateSchema)
}
function confirmed(op: McpPreparedOperation, text = 'Synthetic result'): AgentMcpOutcome {
  const result = projectMcpResult(
    op.serverId,
    op.catalogKind === 'tools' ? 'tools/call' : 'resources/read',
    op.remoteKey,
    op.catalogKind === 'tools'
      ? { content: [{ type: 'text', text }] }
      : { contents: [{ uri: op.remoteKey, text }] },
    assertAllowed
  )
  return {
    result,
    outcome: 'confirmed',
    requestSent: true,
    unknownOutcome: false,
    doNotRetry: false
  }
}
function confirmedError(op: McpPreparedOperation): AgentMcpOutcome {
  return {
    result: projectMcpResult(
      op.serverId,
      op.catalogKind === 'tools' ? 'tools/call' : 'resources/read',
      op.remoteKey,
      op.catalogKind === 'tools' ? { isError: true, content: [] } : { isError: true, contents: [] },
      assertAllowed
    ),
    outcome: 'confirmed',
    requestSent: true,
    unknownOutcome: false,
    doNotRetry: true
  }
}
function unknown(requestSent?: boolean): AgentMcpOutcome {
  return {
    result: mcpFailure('mcp_unknown_outcome', 'Synthetic response lost', true),
    outcome: 'unknown',
    ...(requestSent !== undefined ? { requestSent } : {}),
    unknownOutcome: true,
    doNotRetry: true
  }
}
function notSent(denied = false): AgentMcpOutcome {
  const result = mcpFailure(denied ? 'denied' : 'cancelled', 'Not attempted')
  if (denied) result.content = JSON.stringify({ ...JSON.parse(result.content), denied: true })
  return {
    result,
    outcome: 'not-sent',
    requestSent: false,
    unknownOutcome: false,
    doNotRetry: false
  }
}
function session(op: McpPreparedOperation): AgentSession {
  return {
    id: scope.sessionId,
    title: 'Fixture',
    mode: 'manual',
    model: 'gpt-6-luna',
    reasoningEffort: 'medium',
    status: 'interrupted',
    createdAt: '2026-10-09T00:00:00.000Z',
    updatedAt: '2026-10-09T00:00:00.000Z',
    tokenCount: 0,
    planReady: false,
    activeRunId: 'newer-run',
    messages: [
      {
        id: 'message-1',
        role: 'tool',
        content: op.call.name,
        timestamp: '2026-10-09T00:00:00.000Z',
        toolCalls: [
          {
            ...structuredClone(op.call),
            status: 'running',
            createdAt: '2026-10-09T00:00:00.000Z',
            mcp: {
              runId: scope.runId,
              operationDigest: op.binding.operationDigest as string,
              serverId: op.serverId,
              catalogKind: op.catalogKind,
              remoteKey: op.remoteKey,
              outcome: 'pending'
            }
          }
        ]
      }
    ],
    history: [
      { kind: 'assistant', content: '', toolCalls: [structuredClone(op.call)] },
      {
        kind: 'tool_result',
        callId: op.call.id,
        name: op.call.name,
        content: JSON.stringify({ success: false, error: 'Agent execution cancelled' }),
        isError: true
      }
    ]
  }
}
function body(record: AgentMcpOutcomeRecord): Record<string, unknown> {
  return JSON.parse(record.result!.content)
}
function failPrimaryRename() {
  const rename = fs.rename.bind(fs)
  return vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (to === path) throw Object.assign(new Error('Synthetic checkpoint failure'), { code: 'EIO' })
    await rename(from, to)
  })
}

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'desktop-mcp-outcomes-'))
  path = join(directory, 'agent-mcp', 'outcomes.json')
  reopenAtomicWrites()
  resumeAgentPersistence()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  resumeAgentPersistence()
  await closeAndDrainAtomicWrites()
  reopenAtomicWrites()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('durable MCP outcomes', () => {
  it('requires load, private storage, and an awaited durable intent before send', async () => {
    const store = ledger()
    expect(() => store.records()).toThrow('loading')
    expect(() => store.assertWritable()).toThrow('loading')
    await store.load()
    const op = await operation()
    await store.intent(scope, op)
    const file = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(file.records[0]).toMatchObject({ ...scope, outcome: 'pending', call: op.call })
    expect(file.records[0].requestSent).toBeUndefined()
    expect(file.records[0].binding).toBeUndefined()
    expect(file.records[0].approval).toBeUndefined()
    if (process.platform !== 'win32') {
      expect((await fs.stat(join(directory, 'agent-mcp'))).mode & 0o777).toBe(0o700)
      expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(() => store.assertWritable()).toThrow('unreconciled')
    await expect(store.intent(scope, op)).rejects.toThrow()
  })

  it.each([false, true])(
    'persists confirmed zero-send cancellation/denial (denied=%s)',
    async (denied) => {
      const store = ledger(),
        op = await operation()
      const sends = 0
      await store.settle(scope, op, notSent(denied))
      expect(sends).toBe(0)
      expect(body(store.records()[0])).toMatchObject({
        requestSent: false,
        unknownOutcome: false,
        doNotRetry: false,
        untrusted: true
      })
      const restored = ledger()
      await restored.load()
      const repaired = reconcileAgentMcpOutcomes(session(op), restored.records())
      expect(repaired.messages[0].toolCalls![0].status).toBe(denied ? 'rejected' : 'error')
      expect(repaired.messages[0].toolCalls![0].mcp).toMatchObject({
        outcome: 'not-sent',
        requestSent: false
      })
      expect(JSON.parse(repaired.history![1].content)).toMatchObject({
        requestSent: false,
        unknownOutcome: false
      })
      expect(() => restored.assertWritable()).not.toThrow()
    }
  )

  it.each(['not-sent', 'unknown', 'confirmed'] as const)(
    'repairs raw runner cancellation loss with exact %s host evidence',
    async (outcome) => {
      const store = ledger(),
        op = await operation(),
        controller = new AbortController()
      let sends = 0
      const raw = await runAgent({
        provider: {
          async generate() {
            return { content: '', toolCalls: [op.call] }
          }
        },
        messages: [],
        tools: [{ name: op.call.name, description: 'Fixture', parameters: { type: 'object' } }],
        signal: controller.signal,
        executeTool: async () => {
          if (outcome !== 'not-sent') {
            await store.intent(scope, op)
            sends++
          }
          const output =
            outcome === 'confirmed'
              ? confirmed(op)
              : outcome === 'unknown'
                ? unknown(true)
                : notSent()
          await store.settle(scope, op, output)
          controller.abort()
          return output.result
        }
      })
      expect(raw.status).toBe('cancelled')
      const rawOutput = raw.history.find((item) => item.kind === 'tool_result')!
      expect(JSON.parse(rawOutput.content).unknownOutcome).toBeUndefined()
      const original = session(op)
      original.history = raw.history
      const repaired = reconcileAgentMcpOutcomes(original, store.records())
      const canonical = repaired.history!.find((item) => item.kind === 'tool_result')!
      expect(JSON.parse(canonical.content)).toMatchObject({
        unknownOutcome: outcome === 'unknown',
        doNotRetry: outcome === 'unknown',
        requestSent: outcome !== 'not-sent'
      })
      expect(repaired.messages[0].content).toBe(canonical.content)
      expect(repaired.messages[0].toolCalls![0].mcp!.outcome).toBe(outcome)
      expect(repaired.messages[0].toolCalls![0].status).toBe(
        outcome === 'confirmed' ? 'completed' : 'error'
      )
      expect(original.history).toEqual(raw.history)
      expect(sends).toBe(outcome === 'not-sent' ? 0 : 1)
      expect(repaired.status).toBe('interrupted')
      expect(repaired.activeRunId).toBe('newer-run')
      expect(reconcileAgentMcpOutcomes(repaired, store.records())).toEqual(repaired)
    }
  )

  it('converts an unsettled restart intent to potentially-sent uncertainty without delivery claims', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    const restored = ledger()
    await restored.load()
    const record = restored.records()[0]
    expect(record).toMatchObject({ outcome: 'unknown', unknownOutcome: true, doNotRetry: true })
    expect(Object.hasOwn(record, 'requestSent')).toBe(false)
    expect(Object.hasOwn(body(record), 'requestSent')).toBe(false)
    const original = session(op)
    original.history!.pop()
    original.messages[0].toolCalls![0].mcp!.requestSent = false
    const repaired = reconcileAgentMcpOutcomes(original, restored.records())
    expect(repaired.history).toHaveLength(2)
    expect(JSON.parse(repaired.history![1].content)).toMatchObject({
      unknownOutcome: true,
      doNotRetry: true
    })
    expect(Object.hasOwn(repaired.messages[0].toolCalls![0].mcp!, 'requestSent')).toBe(false)
    expect(() => restored.assertWritable()).toThrow('unreconciled')
  })

  it('retains known confirmed output in memory after failed settlement and recovers disk intent as unknown', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    const intent = await fs.readFile(path, 'utf8'),
      fault = failPrimaryRename()
    await expect(store.settle(scope, op, confirmed(op))).rejects.toThrow('checkpoint failed')
    expect(await fs.readFile(path, 'utf8')).toBe(intent)
    expect(store.records()[0]).toMatchObject({ outcome: 'confirmed', checkpointUnconfirmed: true })
    expect(body(store.records()[0])).toMatchObject({ success: true, checkpointUnconfirmed: true })
    expect(
      reconcileAgentMcpOutcomes(session(op), store.records()).messages[0].toolCalls![0].status
    ).toBe('completed')
    expect(() => store.assertWritable()).toThrow('persistence recovery')
    fault.mockRestore()
    const restored = ledger()
    await restored.load()
    expect(restored.records()[0].outcome).toBe('unknown')
    expect(body(restored.records()[0]).requestSent).toBeUndefined()
  })

  it('preserves a durable confirmed outcome after failed terminal history checkpoint', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.settle(scope, op, confirmed(op))
    await fs.writeFile(join(directory, 'session.json'), JSON.stringify(session(op)))
    const restored = ledger()
    await restored.load()
    const stale = JSON.parse(
      await fs.readFile(join(directory, 'session.json'), 'utf8')
    ) as AgentSession
    const repaired = reconcileAgentMcpOutcomes(stale, restored.records())
    expect(JSON.parse(repaired.history![1].content)).toMatchObject({
      success: true,
      requestSent: true,
      unknownOutcome: false
    })
    expect(repaired.messages[0].toolCalls![0].status).toBe('completed')
  })

  it('retains restart uncertainty in memory when its recovery checkpoint fails', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    const fault = failPrimaryRename(),
      restored = ledger()
    await restored.load()
    expect(restored.records()[0]).toMatchObject({ outcome: 'unknown', checkpointUnconfirmed: true })
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records[0].outcome).toBe('pending')
    expect(() => restored.assertWritable()).toThrow('persistence recovery')
    fault.mockRestore()
    await restored.checkpoint()
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records[0].outcome).toBe('unknown')
  })

  it('does not send after intent write failure, and settles a known not-attempted outcome', async () => {
    const store = ledger(),
      op = await operation()
    await store.load()
    let sends = 0
    const fault = failPrimaryRename()
    await expect(
      store.intent(scope, op).then(() => {
        sends++
      })
    ).rejects.toThrow('no transport send')
    expect(sends).toBe(0)
    expect(store.records()).toEqual([])
    fault.mockRestore()
    await store.settle(scope, op, notSent())
    expect(body(store.records()[0]).requestSent).toBe(false)
  })

  it('blocks further admission on post-rename directory-sync uncertainty while preserving the committed intent', async () => {
    const store = ledger(),
      op = await operation()
    await store.load()
    const open = fs.open.bind(fs)
    const fault = vi.spyOn(fs, 'open').mockImplementation(async (file, ...args) => {
      const handle = await open(file, ...args)
      if (file === join(directory, 'agent-mcp'))
        handle.sync = async () => {
          throw Object.assign(new Error('Synthetic directory sync failure'), { code: 'EIO' })
        }
      return handle
    })
    await expect(store.intent(scope, op)).rejects.toThrow('no transport send')
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records[0].outcome).toBe('pending')
    expect(store.records()[0].outcome).toBe('pending')
    expect(() => store.assertWritable()).toThrow('persistence recovery')
    fault.mockRestore()
    await closeAndDrainAtomicWrites()
    reopenAtomicWrites()
    await store.settle(scope, op, notSent())
    expect(body(store.records()[0]).requestSent).toBe(false)
  })

  it('settles cancellation/shutdown within an admitted run, and drains accepted queued work', async () => {
    const store = ledger(),
      op = await operation()
    await withAgentPersistenceOperation(async () => {
      await store.intent(scope, op)
      pauseAgentPersistence()
      await store.settle(scope, op, confirmed(op))
      await store.drain()
    })
    expect(store.records()[0].outcome).toBe('confirmed')
    await expect(ledger().load()).rejects.toThrow('shutting down')
  })

  it.each(['run', 'alias', 'arguments', 'digest', 'server', 'kind', 'key', 'session'] as const)(
    'refuses unrelated %s identity when reconciling',
    async (mismatch) => {
      const store = ledger(),
        op = await operation()
      await store.intent(scope, op)
      await store.settle(scope, op, confirmed(op))
      const original = session(op),
        call = original.messages[0].toolCalls![0]
      if (mismatch === 'run') call.mcp!.runId = 'other-run'
      if (mismatch === 'alias') call.name = 'other_alias'
      if (mismatch === 'arguments') call.arguments.query = 'other'
      if (mismatch === 'digest') call.mcp!.operationDigest = '0'.repeat(64)
      if (mismatch === 'server') call.mcp!.serverId = 'other'
      if (mismatch === 'kind') call.mcp!.catalogKind = 'resources'
      if (mismatch === 'key') call.mcp!.remoteKey = 'other'
      if (mismatch === 'session') original.id = 'other-session'
      expect(reconcileAgentMcpOutcomes(original, store.records())).toEqual(original)
    }
  )

  it('refuses ambiguous display/canonical IDs and never infers matching from result.source', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.settle(scope, op, confirmed(op))
    const duplicate = session(op)
    duplicate.messages.push({ ...structuredClone(duplicate.messages[0]), id: 'duplicate-message' })
    expect(reconcileAgentMcpOutcomes(duplicate, store.records())).toEqual(duplicate)
    const unbound = session(op)
    delete unbound.messages[0].toolCalls![0].mcp
    unbound.history![1].content = JSON.stringify({
      source: 'mcp',
      serverId: 'docs',
      operationDigest: op.binding.operationDigest
    })
    expect(reconcileAgentMcpOutcomes(unbound, store.records())).toEqual(unbound)
    expect(
      reconcileAgentMcpOutcomes(session(op), [store.records()[0], store.records()[0]])
    ).toEqual(session(op))
    const duplicateHistory = session(op)
    duplicateHistory.history!.push(...structuredClone(duplicateHistory.history!))
    expect(() => reconcileAgentMcpOutcomes(duplicateHistory, store.records())).toThrow()
  })

  it('preserves safety and identity fields in long valid JSON without app-specific clipping', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.settle(scope, op, confirmed(op, 'x'.repeat(63 * 1024)))
    const repaired = reconcileAgentMcpOutcomes(session(op), store.records())
    const projection = JSON.parse(repaired.history![1].content)
    expect(projection).toMatchObject({
      source: 'mcp',
      untrusted: true,
      serverId: 'docs',
      remoteKey: 'lookup/name',
      requestSent: true,
      unknownOutcome: false,
      doNotRetry: false
    })
    expect(projection.content[0].text).toHaveLength(63 * 1024)
    expect(Buffer.byteLength(repaired.history![1].content)).toBeLessThanOrEqual(64 * 1024)
  })

  it.each(['oversized', 'non-json', 'foreign-identity', 'private', 'false-unknown'] as const)(
    'retains intent after rejecting %s settlement',
    async (invalid) => {
      const store = ledger(),
        op = await operation()
      await store.intent(scope, op)
      const outcome = confirmed(op)
      if (invalid === 'oversized')
        outcome.result.content = JSON.stringify({
          success: true,
          source: 'mcp',
          untrusted: true,
          content: 'x'.repeat(64 * 1024)
        })
      if (invalid === 'non-json') outcome.result.content = 'invalid'
      if (invalid === 'foreign-identity')
        outcome.result.content = JSON.stringify({
          ...JSON.parse(outcome.result.content),
          serverId: 'other'
        })
      if (invalid === 'private')
        outcome.result.content = JSON.stringify({
          ...JSON.parse(outcome.result.content),
          structuredContent: 'offline-credential-marker'
        })
      if (invalid === 'false-unknown') outcome.unknownOutcome = true
      await expect(store.settle(scope, op, outcome)).rejects.toThrow()
      expect(store.records()[0].outcome).toBe('pending')
      expect(JSON.parse(await fs.readFile(path, 'utf8')).records[0].outcome).toBe('pending')
      expect(() => store.assertWritable()).toThrow('unreconciled')
    }
  )

  it('keeps corrupt/unreadable originals and refuses an empty fallback without repair writes', async () => {
    await fs.mkdir(join(directory, 'agent-mcp'), { mode: 0o700 })
    await fs.writeFile(path, '{invalid', { mode: 0o600 })
    const store = ledger()
    await expect(store.load()).rejects.toThrow('safe file recovery')
    expect(() => store.records()).toThrow('loading')
    await expect(store.intent(scope, await operation())).rejects.toThrow('safe file recovery')
    expect(await fs.readFile(path, 'utf8')).toBe('{invalid')
    expect(await fs.readdir(join(directory, 'agent-mcp'))).toEqual(['outcomes.json'])
    await fs.rm(path)
    await fs.mkdir(path)
    const unreadable = ledger()
    await expect(unreadable.load()).rejects.toThrow('safe file recovery')
    expect(() => unreadable.records()).toThrow('loading')
    await expect(unreadable.intent(scope, await operation())).rejects.toThrow('safe file recovery')
    expect((await fs.stat(path)).isDirectory()).toBe(true)
  })

  it('does not silently recover an older backup when latest primary evidence is damaged', async () => {
    const store = ledger(),
      op = await operation()
    await store.settle(scope, op, notSent())
    await fs.copyFile(path, `${path}.bak`)
    const backup = await fs.readFile(`${path}.bak`, 'utf8')
    await fs.writeFile(path, '{damaged-latest-primary')
    const restored = ledger()
    await expect(restored.load()).rejects.toThrow('safe file recovery')
    expect(await fs.readFile(path, 'utf8')).toBe('{damaged-latest-primary')
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe(backup)
  })

  it.each(['corrupt', 'missing'] as const)(
    'refuses ambiguous older-backup recovery across two restarts (%s primary)',
    async (damage) => {
      const store = ledger(),
        terminal = await operation('older-terminal-call')
      await store.settle(scope, terminal, notSent())
      await store.intent(scope, await operation('newer-possibly-sent-call'))
      const backup = await fs.readFile(`${path}.bak`, 'utf8')
      expect(
        JSON.parse(backup).records.map((record: AgentMcpOutcomeRecord) => record.outcome)
      ).toEqual(['not-sent'])
      if (damage === 'corrupt') await fs.writeFile(path, '{damaged-newer-intent')
      else await fs.unlink(path)
      let sends = 0
      for (let restart = 0; restart < 2; restart++) {
        const restored = ledger()
        await expect(restored.load()).rejects.toThrow('safe file recovery')
        await expect(
          restored.intent(scope, await operation(`retry-${restart}`)).then(() => {
            sends++
          })
        ).rejects.toThrow('safe file recovery')
        expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe(backup)
        if (damage === 'corrupt')
          expect(await fs.readFile(path, 'utf8')).toBe('{damaged-newer-intent')
        else await expect(fs.readFile(path, 'utf8')).rejects.toHaveProperty('code', 'ENOENT')
      }
      expect(sends).toBe(0)
    }
  )

  it('refuses capacity rather than discarding unreconciled evidence', async () => {
    const store = ledger()
    for (let index = 0; index < MAX_AGENT_MCP_OUTCOME_RECORDS; index++)
      await store.settle(scope, await operation(`call-${index}`), notSent())
    expect(() => store.assertWritable()).toThrow('capacity')
    await expect(store.intent(scope, await operation('call-overflow'))).rejects.toThrow('capacity')
    expect(store.records()).toHaveLength(MAX_AGENT_MCP_OUTCOME_RECORDS)
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records).toHaveLength(
      MAX_AGENT_MCP_OUTCOME_RECORDS
    )
  })

  it('acknowledges only exactly reconciled terminal history, leaving unmatched and pending evidence', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.acknowledge(scope, session(op))
    expect(store.records()).toHaveLength(1)
    await store.settle(scope, op, unknown())
    await store.acknowledge(scope, session(op))
    expect(store.records()).toHaveLength(1)
    const repaired = reconcileAgentMcpOutcomes(session(op), store.records())
    await store.acknowledge({ ...scope, runId: 'newer-run' }, repaired)
    expect(store.records()).toHaveLength(1)
    await store.acknowledge(scope, repaired)
    expect(store.records()).toEqual([])
    expect(() => store.assertWritable()).not.toThrow()
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records).toEqual([])
  })

  it('does not remove evidence on an acknowledgement checkpoint failure', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.settle(scope, op, confirmed(op))
    const repaired = reconcileAgentMcpOutcomes(session(op), store.records()),
      fault = failPrimaryRename()
    await expect(store.acknowledge(scope, repaired)).rejects.toThrow(
      'acknowledgement checkpoint failed'
    )
    expect(store.records()).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records).toHaveLength(1)
    fault.mockRestore()
    await store.acknowledge(scope, repaired)
    expect(store.records()).toEqual([])
  })

  it('rejects conflicting identities/results, stale digests, unsafe paths, and private arguments', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await expect(
      store.settle(scope, await operation('call-1', 'tools', { query: 'other' }), confirmed(op))
    ).rejects.toThrow('identity mismatch')
    await store.settle(scope, op, confirmed(op))
    await expect(store.settle(scope, op, confirmed(op, 'different'))).rejects.toThrow('conflicting')
    const fake = structuredClone(op)
    fake.binding.operationDigest = '0'.repeat(64)
    await expect(store.intent(scope, fake)).rejects.toThrow('stale')
    await expect(
      createAgentMcpOutcomeLedger({ path: join(directory, 'outcomes.json'), assertAllowed }).load()
    ).rejects.toThrow('safe file recovery')
    await expect(
      ledger().intent(
        scope,
        await operation('private', 'tools', { query: 'offline-credential-marker' })
      )
    ).rejects.toThrow('Private')
  })

  it('handles exact resource URI outcomes with the same durable/reconciliation guarantee', async () => {
    const store = ledger(),
      op = await operation('resource-1', 'resources')
    await store.intent(scope, op)
    await store.settle(scope, op, confirmed(op, 'Resource text'))
    expect(
      JSON.parse(reconcileAgentMcpOutcomes(session(op), store.records()).history![1].content)
    ).toMatchObject({
      method: 'resources/read',
      remoteKey: 'docs://exact',
      content: [{ uri: 'docs://exact', text: 'Resource text' }]
    })
  })

  it('drains work admitted before the queue callback starts and freezes caller snapshots', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    const output = confirmed(op),
      capturedScope = { ...scope }
    const settlement = store.settle(capturedScope, op, output),
      drained = store.drain()
    output.result.content = 'changed after admission'
    capturedScope.runId = 'changed-after-admission'
    await drained
    await settlement
    expect(store.records()[0]).toMatchObject({ runId: scope.runId, outcome: 'confirmed' })
    expect(body(store.records()[0]).success).toBe(true)
  })

  it('rejects oversized persisted files before reading or replacing their evidence', async () => {
    await fs.mkdir(join(directory, 'agent-mcp'), { mode: 0o700 })
    await fs.writeFile(path, 'x'.repeat(MAX_AGENT_MCP_OUTCOME_BYTES + 1), { mode: 0o600 })
    const read = vi.spyOn(fs, 'readFile')
    await expect(ledger().load()).rejects.toThrow('safe file recovery')
    expect(read).not.toHaveBeenCalled()
    expect((await fs.stat(path)).size).toBe(MAX_AGENT_MCP_OUTCOME_BYTES + 1)
  })

  it.each(['unknownOutcome', 'doNotRetry', 'requestSent', 'content'] as const)(
    'never normalizes away contradictory or invalid confirmed result %s',
    async (field) => {
      const store = ledger(),
        op = await operation()
      await store.intent(scope, op)
      const output = confirmed(op),
        projection = JSON.parse(output.result.content)
      projection[field] = field === 'requestSent' ? false : true
      output.result.content = JSON.stringify(projection)
      await expect(store.settle(scope, op, output)).rejects.toThrow()
      expect(store.records()[0].outcome).toBe('pending')
    }
  )

  it('refuses non-private existing paths and POSIX ownership mismatches without altering evidence', async () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') return
    await fs.mkdir(join(directory, 'agent-mcp'), { mode: 0o755 })
    await expect(ledger().load()).rejects.toThrow('safe file recovery')
    expect((await fs.stat(join(directory, 'agent-mcp'))).mode & 0o777).toBe(0o755)
    await fs.chmod(join(directory, 'agent-mcp'), 0o700)
    await fs.writeFile(path, '{private-shape-invalid', { mode: 0o644 })
    await expect(ledger().load()).rejects.toThrow('safe file recovery')
    expect((await fs.stat(path)).mode & 0o777).toBe(0o644)
    await fs.chmod(path, 0o600)
    const lstat = fs.lstat.bind(fs)
    const fault = vi.spyOn(fs, 'lstat').mockImplementation(async (file, ...args) => {
      const stat = await lstat(file, ...args)
      if (file === path) Object.defineProperty(stat, 'uid', { value: process.getuid!() + 1 })
      return stat
    })
    await expect(ledger().load()).rejects.toThrow('safe file recovery')
    fault.mockRestore()
    expect(await fs.readFile(path, 'utf8')).toBe('{private-shape-invalid')
  })

  it('refuses symbolic links before reads or recovery writes', async () => {
    if (process.platform === 'win32') return
    await fs.mkdir(join(directory, 'agent-mcp'), { mode: 0o700 })
    const target = join(directory, 'target.json')
    await fs.writeFile(target, '{untouched', { mode: 0o600 })
    await fs.symlink(target, path)
    await expect(ledger().load()).rejects.toThrow('safe file recovery')
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(target, 'utf8')).toBe('{untouched')
  })

  it.each(['confirmed', 'confirmed-error', 'not-sent'] as const)(
    'preserves exact durable %s history when older intent survives settlement/acknowledgement failures',
    async (outcome) => {
      const store = ledger(),
        op = await operation()
      await store.intent(scope, op)
      const fault = failPrimaryRename()
      await expect(
        store.settle(
          scope,
          op,
          outcome === 'confirmed'
            ? confirmed(op)
            : outcome === 'confirmed-error'
              ? confirmedError(op)
              : notSent()
        )
      ).rejects.toThrow('checkpoint failed')
      const checkpointed = reconcileAgentMcpOutcomes(session(op), store.records())
      await fs.writeFile(join(directory, 'session.json'), JSON.stringify(checkpointed))
      await expect(store.acknowledge(scope, checkpointed)).rejects.toThrow(
        'acknowledgement checkpoint failed'
      )
      fault.mockRestore()
      const restored = ledger()
      await restored.load()
      expect(restored.records()[0].outcome).toBe('unknown')
      const saved = JSON.parse(
        await fs.readFile(join(directory, 'session.json'), 'utf8')
      ) as AgentSession
      const repaired = reconcileAgentMcpOutcomes(saved, restored.records())
      expect(JSON.parse(repaired.history![1].content)).toMatchObject({
        requestSent: outcome !== 'not-sent',
        unknownOutcome: false,
        doNotRetry: outcome === 'confirmed-error'
      })
      expect(repaired.messages[0].toolCalls![0].mcp!.outcome).toBe(
        outcome === 'confirmed-error' ? 'confirmed' : outcome
      )
      expect(repaired.messages[0].toolCalls![0].status).toBe(
        outcome === 'confirmed' ? 'completed' : 'error'
      )
      await restored.acknowledge(scope, repaired)
      expect(restored.records()).toEqual([])
    }
  )

  it('does not promote recovery from untrusted canonical output without exactly matching saved UI evidence', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    const restored = ledger()
    await restored.load()
    const forged = session(op),
      output = confirmed(op)
    const projection = {
      ...JSON.parse(output.result.content),
      requestSent: true,
      unknownOutcome: false,
      doNotRetry: false
    }
    forged.history![1].content = JSON.stringify(projection)
    Object.assign(forged.history![1], { isError: false })
    const call = forged.messages[0].toolCalls![0]
    call.mcp!.outcome = 'confirmed'
    call.mcp!.requestSent = true
    call.status = 'completed'
    const repaired = reconcileAgentMcpOutcomes(forged, restored.records())
    expect(JSON.parse(repaired.history![1].content)).toMatchObject({
      unknownOutcome: true,
      doNotRetry: true
    })
    expect(repaired.messages[0].toolCalls![0].mcp!.outcome).toBe('unknown')
  })

  it('accepts exact confirmed errors with no-retry but rejects no-retry successes/not-sent', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.settle(scope, op, confirmedError(op))
    const repaired = reconcileAgentMcpOutcomes(session(op), store.records())
    expect(JSON.parse(repaired.history![1].content)).toMatchObject({
      success: false,
      requestSent: true,
      unknownOutcome: false,
      doNotRetry: true
    })
    expect(repaired.messages[0].toolCalls![0]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('Do not retry'),
      mcp: { outcome: 'confirmed' }
    })
    const restored = ledger()
    await restored.load()
    expect(body(restored.records()[0]).doNotRetry).toBe(true)
    await store.acknowledge(scope, repaired)
    const op2 = await operation('call-2')
    await store.intent(scope, op2)
    await expect(store.settle(scope, op2, { ...confirmed(op2), doNotRetry: true })).rejects.toThrow(
      'safety fields'
    )
    await expect(store.settle(scope, op2, { ...notSent(), doNotRetry: true })).rejects.toThrow(
      'safety fields'
    )
  })

  it.each(['corrupt', 'missing', 'replaced', 'unreadable'] as const)(
    'never overwrites %s evidence changed after load',
    async (changed) => {
      const store = ledger(),
        op = await operation()
      await store.intent(scope, op)
      const prior = await fs.readFile(path, 'utf8')
      if (changed === 'corrupt') await fs.writeFile(path, '{changed-corrupt-primary')
      if (changed === 'missing') await fs.unlink(path)
      if (changed === 'replaced')
        await fs.writeFile(path, JSON.stringify({ version: 1, records: [] }))
      const readFile = fs.readFile.bind(fs)
      const fault =
        changed === 'unreadable'
          ? vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...args) => {
              if (file === path)
                throw Object.assign(new Error('Synthetic unreadable evidence'), { code: 'EIO' })
              return readFile(file, ...args)
            })
          : undefined
      await expect(store.settle(scope, op, confirmed(op))).rejects.toThrow('checkpoint failed')
      expect(store.records()[0]).toMatchObject({
        outcome: 'confirmed',
        checkpointUnconfirmed: true
      })
      expect(() => store.assertWritable()).toThrow('persistence recovery')
      fault?.mockRestore()
      if (changed === 'missing')
        await expect(fs.readFile(path, 'utf8')).rejects.toHaveProperty('code', 'ENOENT')
      else
        expect(await fs.readFile(path, 'utf8')).toBe(
          changed === 'corrupt'
            ? '{changed-corrupt-primary'
            : changed === 'replaced'
              ? JSON.stringify({ version: 1, records: [] })
              : prior
        )
      // Repair restores the same committed snapshot; no automatic retry/replay happens.
      await fs.writeFile(path, prior, { mode: 0o600 })
      await store.checkpoint()
      expect(JSON.parse(await fs.readFile(path, 'utf8')).records[0].outcome).toBe('confirmed')
    }
  )

  it.each(['before-load', 'after-load'] as const)(
    'keeps a damaged backup untouched even with a valid primary (%s)',
    async (phase) => {
      const store = ledger(),
        op = await operation()
      await store.settle(scope, op, notSent())
      const primary = await fs.readFile(path, 'utf8')
      await fs.writeFile(`${path}.bak`, '{damaged-backup-evidence', { mode: 0o600 })
      if (phase === 'before-load')
        await expect(ledger().load()).rejects.toThrow('safe file recovery')
      else
        await expect(store.intent(scope, await operation('call-2'))).rejects.toThrow(
          'checkpoint failed'
        )
      expect(await fs.readFile(path, 'utf8')).toBe(primary)
      expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('{damaged-backup-evidence')
    }
  )

  it('retains evidence for deleted or quarantined session checkpoints', async () => {
    const store = ledger(),
      op = await operation()
    await store.intent(scope, op)
    await store.settle(scope, op, unknown(true))
    const quarantined = session(op)
    quarantined.messages = []
    quarantined.history = []
    await store.acknowledge(scope, quarantined)
    expect(store.records()).toHaveLength(1)
    await expect(
      store.acknowledge(scope, { ...quarantined, id: 'another-session' })
    ).rejects.toThrow('session mismatch')
    expect(store.records()).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path, 'utf8')).records).toHaveLength(1)
  })

  it.each([
    ['tools', 'protocol-error'],
    ['resources', 'protocol-error'],
    ['tools', 'oversized-complete'],
    ['tools', 'admissible-checkpoint-failure']
  ] as const)(
    'joint actual service/ledger: %s %s preserves bounded exact outcome evidence',
    async (kind, phase) => {
      let operationSends = 0
      let settlementFault: ReturnType<typeof failPrimaryRename> | undefined
      const transport: Transport = {
        async start() {},
        async close() {
          transport.onclose?.()
        },
        async send(message: JSONRPCMessage) {
          if (!('method' in message) || !('id' in message)) return
          if (message.method === 'tools/call' || message.method === 'resources/read') {
            operationSends++
            queueMicrotask(() =>
              transport.onmessage?.({
                jsonrpc: '2.0',
                id: message.id,
                ...(phase === 'protocol-error'
                  ? { error: { code: -32602, message: 'RAW_SERVER_DIAGNOSTICS_MUST_NOT_PERSIST' } }
                  : {
                      result: {
                        resultType: 'complete',
                        content: [
                          {
                            type: 'text',
                            text: 'x'.repeat(phase === 'oversized-complete' ? 65355 : 65200)
                          }
                        ],
                        ttlMs: 0,
                        cacheScope: 'private'
                      }
                    })
              })
            )
            return
          }
          const result =
            message.method === 'initialize'
              ? {
                  protocolVersion: '2025-11-25',
                  capabilities: { tools: {}, resources: {} },
                  serverInfo: { name: 'Inert ledger fixture', version: '1' }
                }
              : message.method === 'server/discover'
                ? {
                    resultType: 'complete',
                    supportedVersions: ['2026-07-28'],
                    capabilities: { tools: {}, resources: {} },
                    _meta: {
                      'io.modelcontextprotocol/serverInfo': {
                        name: 'Inert ledger fixture',
                        version: '1'
                      }
                    }
                  }
                : message.method === 'tools/list'
                  ? {
                      resultType: 'complete',
                      tools: [
                        {
                          name: 'lookup/name',
                          inputSchema: {
                            type: 'object',
                            properties: { query: { type: 'string' } },
                            required: ['query'],
                            additionalProperties: false
                          }
                        }
                      ]
                    }
                  : message.method === 'resources/list'
                    ? {
                        resultType: 'complete',
                        resources: [{ uri: 'docs://exact', name: 'Exact' }]
                      }
                    : { resultType: 'complete', resourceTemplates: [] }
          queueMicrotask(() =>
            transport.onmessage?.({
              jsonrpc: '2.0',
              id: message.id,
              result: { ...result, ttlMs: 0, cacheScope: 'private' }
            })
          )
        }
      }
      const executable = join(
        directory,
        process.platform === 'win32' ? 'fixture.exe' : 'fixture-server'
      )
      await fs.copyFile(process.platform === 'win32' ? process.execPath : '/bin/true', executable)
      await fs.chmod(executable, 0o700)
      const service = new AgentMcpService({
        store: new McpConfigStore(join(directory, 'private-config')),
        env: {},
        transportFactory: () => transport,
        assertAllowed
      })
      const store = ledger()
      try {
        await service.configure({
          id: 'docs',
          label: 'Inert offline fixture',
          executable,
          args: [],
          cwd: directory,
          protocol: 'legacy',
          environment: []
        })
        const launch = await service.prepareLaunch('docs')
        expect((await service.start(launch.token)).started).toBe(true)
        if (kind === 'resources') await service.refresh('docs', ['resources'])
        const [snapshot] = await service.captureCatalogs(new AbortController().signal)
        const entry = snapshot.categories[kind].entries[0]
        const call: ToolCall = {
          id: 'joint-error-call',
          name: kind === 'tools' ? entry.alias : 'read_mcp_resource',
          arguments:
            kind === 'tools' ? { query: 'hello' } : { serverId: 'docs', uri: 'docs://exact' }
        }
        const op = service.prepareOperation(snapshot, entry, kind, call)
        const output = await service.invoke(op, new AbortController().signal, () => undefined, {
          beforeSend: async () => {
            await store.intent(scope, op)
            if (phase === 'admissible-checkpoint-failure') settlementFault = failPrimaryRename()
          },
          settle: (outcome) => store.settle(scope, op, outcome)
        })
        if (phase !== 'protocol-error') {
          const overflow = phase === 'oversized-complete'
          expect(output).toMatchObject({
            outcome: overflow ? 'unknown' : 'confirmed',
            requestSent: true,
            unknownOutcome: overflow,
            doNotRetry: overflow
          })
          expect(output.checkpointUnconfirmed).toBe(overflow ? undefined : true)
          const repaired = reconcileAgentMcpOutcomes(session(op), store.records()),
            projection = JSON.parse(repaired.history![1].content)
          expect(projection).toMatchObject({
            success: !overflow,
            requestSent: true,
            unknownOutcome: overflow,
            doNotRetry: overflow
          })
          expect(Buffer.byteLength(repaired.history![1].content)).toBeLessThanOrEqual(64 * 1024)
          if (!overflow) {
            expect(projection.content[0].text).toHaveLength(65200)
            expect(projection.checkpointUnconfirmed).toBe(true)
            expect(JSON.parse(await fs.readFile(path, 'utf8')).records[0].outcome).toBe('pending')
            await fs.writeFile(join(directory, 'session.json'), JSON.stringify(repaired))
          }
          settlementFault?.mockRestore()
          const restored = ledger()
          await restored.load()
          const recovered = reconcileAgentMcpOutcomes(repaired, restored.records())
          expect(JSON.parse(recovered.history![1].content)).toMatchObject({
            success: !overflow,
            requestSent: true,
            unknownOutcome: overflow,
            doNotRetry: overflow
          })
          if (!overflow)
            expect(JSON.parse(recovered.history![1].content).content[0].text).toHaveLength(65200)
          expect(operationSends).toBe(1)
          return
        }
        expect(output).toMatchObject({
          outcome: 'confirmed',
          requestSent: true,
          unknownOutcome: false,
          doNotRetry: true,
          result: { isError: true }
        })
        expect(store.records()[0]).toMatchObject({
          outcome: 'confirmed',
          requestSent: true,
          unknownOutcome: false,
          doNotRetry: true
        })
        const repaired = reconcileAgentMcpOutcomes(session(op), store.records())
        expect(JSON.parse(repaired.history![1].content)).toMatchObject({
          success: false,
          source: 'mcp',
          untrusted: true,
          serverId: 'docs',
          method: kind === 'tools' ? 'tools/call' : 'resources/read',
          remoteKey: op.remoteKey,
          requestSent: true,
          unknownOutcome: false,
          doNotRetry: true
        })
        expect(repaired.messages[0].toolCalls![0]).toMatchObject({
          status: 'error',
          mcp: { outcome: 'confirmed', requestSent: true }
        })
        expect(JSON.stringify(repaired)).not.toContain('RAW_SERVER_DIAGNOSTICS_MUST_NOT_PERSIST')
        expect(await fs.readFile(path, 'utf8')).not.toContain(
          'RAW_SERVER_DIAGNOSTICS_MUST_NOT_PERSIST'
        )
        const restored = ledger()
        await restored.load()
        expect(body(restored.records()[0])).toMatchObject({
          unknownOutcome: false,
          doNotRetry: true
        })
        expect(reconcileAgentMcpOutcomes(repaired, restored.records())).toEqual(repaired)
        await restored.acknowledge(scope, repaired)
        expect(restored.records()).toEqual([])
        expect(operationSends).toBe(1)
      } finally {
        settlementFault?.mockRestore()
        await service.close()
      }
    }
  )
})
