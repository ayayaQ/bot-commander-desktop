import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolCall } from '@ayayaq/vivi'
import { createToolRegistry, type ToolRegistry } from '@ayayaq/vivi/extensions'
import {
  createMcpExtension,
  mcpDisplayJson,
  mcpFailure,
  mcpOperationRequest,
  type McpPreparedOperation,
  type ReviewMcpOperation
} from '@ayayaq/vivi/extensions/mcp'
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/client'
import type { AgentSession } from '../../shared/agentTypes'
import { McpConfigStore, type McpServerConfig } from './agentMcpConfig'
import {
  AgentMcpService,
  type AgentMcpInvocationHooks,
  type AgentMcpInvocationOutcome
} from './agentMcpService'
import {
  createAgentMcpOutcomeLedger,
  reconcileAgentMcpOutcomes,
  type AgentMcpOutcomeRecord
} from './agentMcpOutcomes'
import { expandAgentMcpTemplate } from './agentMcpTemplates'
import { reopenAtomicWrites } from './atomicPersistence'
import { resumeAgentPersistence } from './agentPersistenceLifecycle'

vi.mock('electron', () => ({ app: { getPath: () => '/unused-template-fixture-state' } }))

const TEMPLATE = 'FiXtUrE://LoCaL:0080/%2f/literal/../{name}{?q}'
const VALUES = { name: '雪 /?%#', q: 'café&= +' }
const URI = 'FiXtUrE://LoCaL:0080/%2f/literal/../%E9%9B%AA%20%2F%3F%25%23?q=caf%C3%A9%26%3D%20%2B'
const SERVER = fileURLToPath(new URL('./fixtures/agentMcpTemplateServer.mjs', import.meta.url))
const SCOPE = { sessionId: 'template-session', runId: 'template-run' }
const subjects: Array<{ directory: string; service: AgentMcpService }> = []
const signal = () => new AbortController().signal

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfil) => {
    resolve = fulfil
  })
  return { promise, resolve }
}

interface RecordedMessage {
  fixture?: string
  environmentKeys?: string[]
  method?: string
  params?: Record<string, unknown>
}

async function fixture(
  mode: 'normal' | 'exit-on-read' | 'different-uri' = 'normal',
  protocol: McpServerConfig['protocol'] = 'legacy',
  start = true
) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-template-fixture-'))
  const recordingPath = join(directory, 'requests.jsonl')
  const service = new AgentMcpService({
    store: new McpConfigStore(join(directory, 'private')),
    env: {},
    privacyRevision: () => 1
  })
  subjects.push({ directory, service })
  await service.configure({
    id: 'fixture',
    label: 'Offline template fixture',
    executable: process.execPath,
    args: [SERVER, mode, recordingPath, TEMPLATE],
    cwd: directory,
    protocol,
    environment: []
  })
  const ledgerPath = join(directory, 'agent-mcp', 'outcomes.json')
  const ledger = createAgentMcpOutcomeLedger({
    path: ledgerPath,
    assertAllowed: service.assertAllowed
  })
  await ledger.load()

  async function messages(): Promise<RecordedMessage[]> {
    try {
      const contents = await readFile(recordingPath, 'utf8')
      return contents
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as RecordedMessage)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  async function requests(method: string) {
    return (await messages()).filter((message) => message.method === method)
  }
  async function startServer() {
    const launch = await service.prepareLaunch('fixture')
    expect(launch.disclosure).toContain('before any tool-call approval')
    expect((await service.start(launch.token)).started).toBe(true)
    await service.refresh('fixture', ['resources', 'resourceTemplates'])
  }
  async function registry(
    review: ReviewMcpOperation,
    operationsEnabled = true
  ): Promise<ToolRegistry> {
    const catalogs = await service.captureCatalogs(signal())
    return createToolRegistry([
      createMcpExtension(service, catalogs, review, {
        validateSchema: service.validateSchema,
        assertAllowed: service.assertAllowed,
        expandTemplate: service.expandTemplate,
        operationsEnabled
      })
    ])
  }
  async function reloadRecords(): Promise<readonly AgentMcpOutcomeRecord[]> {
    const restored = createAgentMcpOutcomeLedger({
      path: ledgerPath,
      assertAllowed: service.assertAllowed
    })
    await restored.load()
    return restored.records()
  }
  function hooks(
    operation: McpPreparedOperation,
    afterIntent?: () => Promise<void>
  ): AgentMcpInvocationHooks {
    return {
      beforeSend: vi.fn(async () => {
        expect(await requests('resources/read')).toHaveLength(0)
        await ledger.intent(SCOPE, operation)
        await afterIntent?.()
      }),
      settle: vi.fn(async (outcome: AgentMcpInvocationOutcome) => {
        await ledger.settle(SCOPE, operation, outcome)
      })
    }
  }
  if (start) await startServer()
  return {
    directory,
    service,
    ledger,
    messages,
    requests,
    startServer,
    registry,
    reloadRecords,
    hooks
  }
}

function call(id = 'template-call'): ToolCall {
  return {
    id,
    name: 'read_mcp_resource_template',
    arguments: { serverId: 'fixture', uriTemplate: TEMPLATE, variables: { ...VALUES } }
  }
}

function displaySession(operation: McpPreparedOperation): AgentSession {
  const timestamp = '2026-10-13T00:00:00.000Z'
  return {
    id: SCOPE.sessionId,
    title: 'Offline resource-template read',
    mode: 'manual',
    model: 'offline-fixture',
    reasoningEffort: 'medium',
    status: 'interrupted',
    createdAt: timestamp,
    updatedAt: timestamp,
    tokenCount: 0,
    planReady: false,
    messages: [
      {
        id: 'template-display',
        role: 'tool',
        content: 'Pending offline template read',
        timestamp,
        toolCalls: [
          {
            ...structuredClone(operation.call),
            status: 'running',
            createdAt: timestamp,
            mcp: {
              runId: SCOPE.runId,
              operationDigest: operation.binding.operationDigest as string,
              serverId: operation.serverId,
              catalogKind: operation.catalogKind,
              remoteKey: operation.remoteKey,
              resourceUri: operation.resourceUri,
              outcome: 'pending'
            }
          }
        ]
      }
    ],
    history: [
      { kind: 'assistant', content: '', toolCalls: [structuredClone(operation.call)] },
      {
        kind: 'tool_result',
        callId: operation.call.id,
        name: operation.call.name,
        content: 'Offline read was interrupted',
        isError: true
      }
    ]
  }
}

beforeEach(() => {
  resumeAgentPersistence()
  reopenAtomicWrites()
})
afterEach(async () => {
  for (const subject of subjects.splice(0)) {
    await subject.service.close()
    await rm(subject.directory, { recursive: true, force: true })
  }
})

describe('desktop scalar RFC 6570 adapter controls', () => {
  it.each([
    ['fixture:/root{v}', 'fixture:/root%C3%A9%20%2F%3F'],
    ['fixture:/root{+v}', 'fixture:/root%C3%A9%20/?'],
    ['fixture:/root{#v}', 'fixture:/root#%C3%A9%20/?'],
    ['fixture:/root{.v}', 'fixture:/root.%C3%A9%20%2F%3F'],
    ['fixture:/root{/v}', 'fixture:/root/%C3%A9%20%2F%3F'],
    ['fixture:/root{;v}', 'fixture:/root;v=%C3%A9%20%2F%3F'],
    ['fixture:/root{?v}', 'fixture:/root?v=%C3%A9%20%2F%3F'],
    ['fixture:/root?existing=1{&v}', 'fixture:/root?existing=1&v=%C3%A9%20%2F%3F']
  ])('expands the admitted scalar expression %s', (template, expected) => {
    expect(expandAgentMcpTemplate(template, { v: 'é /?' })).toBe(expected)
  })

  it.each([
    ['fixture:/root{v}', 'fixture:/root'],
    ['fixture:/root{+v}', 'fixture:/root'],
    ['fixture:/root{#v}', 'fixture:/root#'],
    ['fixture:/root{.v}', 'fixture:/root.'],
    ['fixture:/root{/v}', 'fixture:/root/'],
    ['fixture:/root{;v}', 'fixture:/root;v'],
    ['fixture:/root{?v}', 'fixture:/root?v='],
    ['fixture:/root?existing=1{&v}', 'fixture:/root?existing=1&v=']
  ])('keeps a defined empty scalar in %s', (template, expected) => {
    expect(expandAgentMcpTemplate(template, { v: '' })).toBe(expected)
  })

  it('uses repeated and dot-named scalar values without changing literal URI spelling', () => {
    const variables = { v: 'a/b', 'item.key': '雪', empty: '' }
    expect(
      expandAgentMcpTemplate('FiXtUrE://LoCaL:0080/%2f/../{v}/{v}{?item.key,empty}', variables)
    ).toBe('FiXtUrE://LoCaL:0080/%2f/../a%2Fb/a%2Fb?item.key=%E9%9B%AA&empty=')
    expect(variables).toEqual({ v: 'a/b', 'item.key': '雪', empty: '' })
    expect(expandAgentMcpTemplate(TEMPLATE, VALUES)).toBe(URI)
  })

  it.each(
    ['+', '#'].flatMap((operator) => ['%A', '%2', '%2x', '%a/é'].map((value) => [operator, value]))
  )('withholds malformed percent text in reserved operator %s for %s', (operator, value) => {
    expect(() => expandAgentMcpTemplate(`fixture:/root{${operator}v}`, { v: value })).toThrow()
  })

  it('retains valid percent-triplet spelling in reserved scalar expansions', () => {
    expect(expandAgentMcpTemplate('fixture:/root{+v}', { v: 'é%2f?/' })).toBe(
      'fixture:/root%C3%A9%2f?/'
    )
    expect(expandAgentMcpTemplate('fixture:/root{#v}', { v: 'é%2f?/' })).toBe(
      'fixture:/root#%C3%A9%2f?/'
    )
  })

  it.each([
    ['fixture:/{v*}', { v: 'plain' }],
    ['fixture:/{v:2}', { v: 'plain' }],
    ['fixture:/{v}', {}],
    ['fixture:/{v}', { v: 'plain', extra: 'unused' }],
    ['fixture:/{v}', { v: 4 }]
  ])('withholds values or syntax outside the scalar contract for %s', (template, variables) => {
    expect(() =>
      expandAgentMcpTemplate(template, variables as Readonly<Record<string, string>>)
    ).toThrow()
  })
})

describe('ordinary offline desktop resource-template reads', () => {
  it('requires explicit process startup and lists captured template metadata without a read', async () => {
    const subject = await fixture('normal', 'legacy', false)
    expect((await subject.service.list()).servers[0].state).toBe('disabled')
    expect(await subject.service.captureCatalogs(signal())).toEqual([])
    expect(await subject.messages()).toEqual([])
    await subject.startServer()
    expect((await subject.messages())[0]).toEqual({ fixture: 'started', environmentKeys: [] })
    const review = vi.fn<ReviewMcpOperation>()
    const registry = await subject.registry(review)
    const beforeListing = await subject.messages()
    const result = await registry.executeTool(
      { id: 'local-template-list', name: 'list_mcp_resources', arguments: { serverId: 'fixture' } },
      { signal: signal() }
    )
    expect(JSON.parse(result.content)).toMatchObject({
      source: 'mcp',
      untrusted: true,
      localMetadataOnly: true,
      servers: [
        {
          serverId: 'fixture',
          templates: [
            { uriTemplate: TEMPLATE, metadataOnly: false, variables: ['name', 'q'] },
            { uriTemplate: 'fixture:///metadata-only/{name*}', metadataOnly: true }
          ]
        }
      ]
    })
    expect(await subject.messages()).toEqual(beforeListing)
    expect(review).not.toHaveBeenCalled()
    expect(await subject.requests('resources/read')).toHaveLength(0)

    const catalogOnly = await subject.registry(review, false)
    expect(catalogOnly.tools.map((tool) => tool.name)).toEqual(['list_mcp_resources'])
    const catalogResult = await catalogOnly.executeTool(
      { id: 'catalog-only-list', name: 'list_mcp_resources', arguments: {} },
      { signal: signal() }
    )
    expect(JSON.parse(catalogResult.content).servers[0].templates[0]).toEqual({
      uriTemplate: TEMPLATE,
      metadataOnly: true
    })
    expect(await subject.messages()).toEqual(beforeListing)
  })

  it.each(['legacy', '2026-07-28'] as const)(
    'reviews the exact Unicode URI and sends one approved resources/read using %s',
    async (protocol) => {
      const subject = await fixture('normal', protocol)
      const approval = deferred<boolean>()
      const reviewed = deferred<McpPreparedOperation>()
      let invocationHooks!: AgentMcpInvocationHooks
      let outcome!: AgentMcpInvocationOutcome
      const registry = await subject.registry(async (operation, contextSignal) => {
        reviewed.resolve(operation)
        expect(await approval.promise).toBe(true)
        invocationHooks = subject.hooks(operation)
        outcome = await subject.service.invoke(operation, contextSignal, () => {}, invocationHooks)
        return outcome.result
      })
      const pending = registry.executeTool(call(), { signal: signal() })
      const operation = await reviewed.promise
      expect(operation).toMatchObject({
        catalogKind: 'resourceTemplates',
        remoteKey: TEMPLATE,
        resourceUri: URI
      })
      expect(mcpOperationRequest(operation)).toEqual({
        method: 'resources/read',
        params: { uri: URI }
      })
      const disclosure = subject.service.operationDisclosure(operation)
      for (const value of [TEMPLATE, URI, VALUES])
        expect(disclosure).toContain(mcpDisplayJson(value))
      expect(disclosure).toContain('Approval permits one attempt')
      expect(await subject.requests('resources/read')).toHaveLength(0)
      expect(subject.ledger.records()).toEqual([])

      approval.resolve(true)
      const result = await pending
      expect(outcome).toMatchObject({
        outcome: 'confirmed',
        requestSent: true,
        unknownOutcome: false,
        doNotRetry: false
      })
      expect(outcome.checkpointUnconfirmed).toBeUndefined()
      expect(invocationHooks.beforeSend).toHaveBeenCalledTimes(1)
      expect(invocationHooks.settle).toHaveBeenCalledTimes(1)
      expect(JSON.parse(result.content)).toMatchObject({
        success: true,
        method: 'resources/read',
        remoteKey: URI,
        content: [{ uri: URI, text: 'Offline template document' }]
      })
      const requests = await subject.requests('resources/read')
      expect(requests).toHaveLength(1)
      expect(requests[0].params).toEqual(
        protocol === 'legacy'
          ? { uri: URI }
          : {
              uri: URI,
              _meta: {
                [PROTOCOL_VERSION_META_KEY]: protocol,
                [CLIENT_INFO_META_KEY]: { name: 'bot-commander-agent-mcp', version: '1.7.0' },
                [CLIENT_CAPABILITIES_META_KEY]: {}
              }
            }
      )
      const records = await subject.reloadRecords()
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({
        catalogKind: 'resourceTemplates',
        remoteKey: TEMPLATE,
        resourceUri: URI,
        outcome: 'confirmed',
        requestSent: true
      })
      expect(records[0].call).toEqual(operation.call)
      const repaired = reconcileAgentMcpOutcomes(displaySession(operation), records)
      expect(repaired.messages[0].toolCalls![0]).toMatchObject({
        status: 'completed',
        mcp: { remoteKey: TEMPLATE, resourceUri: URI, outcome: 'confirmed', requestSent: true }
      })

      const replayHooks = {
        beforeSend: vi.fn(async () => {}),
        settle: vi.fn(async (_outcome: AgentMcpInvocationOutcome) => {})
      }
      const replay = await subject.service.invoke(operation, signal(), () => {}, replayHooks)
      expect(replay).toMatchObject({ outcome: 'not-sent', requestSent: false })
      expect(replayHooks.beforeSend).not.toHaveBeenCalled()
      expect(replayHooks.settle).toHaveBeenCalledTimes(1)
      expect(await subject.requests('resources/read')).toHaveLength(1)
    }
  )

  it('persists a manual template denial with both catalog and expanded identities', async () => {
    const subject = await fixture()
    let deniedOperation!: McpPreparedOperation
    const review = vi.fn<ReviewMcpOperation>(async (operation) => {
      deniedOperation = operation
      const result = mcpFailure('denied', 'Offline reviewer declined the exact template URI')
      result.content = JSON.stringify({ ...JSON.parse(result.content), denied: true })
      await subject.ledger.settle(SCOPE, operation, {
        result,
        outcome: 'not-sent',
        requestSent: false,
        unknownOutcome: false,
        doNotRetry: false
      })
      return subject.ledger.records()[0].result!
    })
    const registry = await subject.registry(review)
    const result = await registry.executeTool(call('denied-template'), { signal: signal() })
    expect(review).toHaveBeenCalledTimes(1)
    expect(JSON.parse(result.content)).toMatchObject({ denied: true, requestSent: false })
    expect(await subject.requests('resources/read')).toHaveLength(0)
    const records = await subject.reloadRecords()
    expect(records[0]).toMatchObject({
      remoteKey: TEMPLATE,
      resourceUri: URI,
      outcome: 'not-sent',
      requestSent: false
    })
    const repaired = reconcileAgentMcpOutcomes(displaySession(deniedOperation), records)
    expect(repaired.messages[0].toolCalls![0].status).toBe('rejected')
  })

  it('cancels an approved template at the durable send hook before any resources/read write', async () => {
    const subject = await fixture()
    const controller = new AbortController()
    const boundary = deferred<void>()
    const releaseBoundary = deferred<void>()
    let outcome!: AgentMcpInvocationOutcome
    const registry = await subject.registry(async (operation, contextSignal) => {
      outcome = await subject.service.invoke(
        operation,
        contextSignal,
        () => {},
        subject.hooks(operation, async () => {
          boundary.resolve()
          await releaseBoundary.promise
        })
      )
      return outcome.result
    })
    const pending = registry.executeTool(call('cancelled-template'), { signal: controller.signal })
    await boundary.promise
    expect(subject.ledger.records()[0]).toMatchObject({
      remoteKey: TEMPLATE,
      resourceUri: URI,
      outcome: 'pending'
    })
    controller.abort()
    releaseBoundary.resolve()
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(outcome).toMatchObject({
      outcome: 'not-sent',
      requestSent: false,
      unknownOutcome: false,
      doNotRetry: false
    })
    expect(JSON.parse(outcome.result.content).requestSent).toBe(false)
    expect(await subject.requests('resources/read')).toHaveLength(0)
    expect((await subject.reloadRecords())[0]).toMatchObject({
      outcome: 'not-sent',
      resourceUri: URI,
      requestSent: false
    })
  })

  it('rejects an approval made stale by a host catalog refresh while review is pending', async () => {
    const subject = await fixture()
    const reviewed = deferred<McpPreparedOperation>()
    const approval = deferred<void>()
    let invocationHooks!: AgentMcpInvocationHooks
    let outcome!: AgentMcpInvocationOutcome
    const registry = await subject.registry(async (operation, contextSignal) => {
      reviewed.resolve(operation)
      await approval.promise
      invocationHooks = subject.hooks(operation)
      outcome = await subject.service.invoke(operation, contextSignal, () => {}, invocationHooks)
      return outcome.result
    })
    const pending = registry.executeTool(call('stale-template'), { signal: signal() })
    const operation = await reviewed.promise
    await subject.service.refresh('fixture', ['resourceTemplates'])
    const current = (await subject.service.captureCatalogs(signal()))[0]
    expect(current.catalogGeneration).toBeGreaterThan(operation.snapshot.catalogGeneration)
    approval.resolve()
    await pending
    expect(outcome).toMatchObject({ outcome: 'not-sent', requestSent: false })
    expect(invocationHooks.beforeSend).not.toHaveBeenCalled()
    expect(await subject.requests('resources/templates/list')).toHaveLength(2)
    expect(await subject.requests('resources/read')).toHaveLength(0)
    expect((await subject.reloadRecords())[0]).toMatchObject({
      outcome: 'not-sent',
      remoteKey: TEMPLATE,
      resourceUri: URI
    })
  })

  it.each(['exit-on-read', 'different-uri'] as const)(
    'persists unknown/do-not-retry after an attempted template read in %s mode',
    async (mode) => {
      const subject = await fixture(mode)
      let operation!: McpPreparedOperation
      let outcome!: AgentMcpInvocationOutcome
      const registry = await subject.registry(async (prepared, contextSignal) => {
        operation = prepared
        outcome = await subject.service.invoke(
          prepared,
          contextSignal,
          () => {},
          subject.hooks(prepared)
        )
        return outcome.result
      })
      const result = await registry.executeTool(call(`uncertain-${mode}`), { signal: signal() })
      expect(outcome).toMatchObject({
        outcome: 'unknown',
        requestSent: true,
        unknownOutcome: true,
        doNotRetry: true
      })
      expect(outcome.checkpointUnconfirmed).toBeUndefined()
      expect(JSON.parse(result.content)).toMatchObject({
        success: false,
        unknownOutcome: true,
        doNotRetry: true
      })
      expect(await subject.requests('resources/read')).toEqual([
        expect.objectContaining({ method: 'resources/read', params: { uri: URI } })
      ])
      const records = await subject.reloadRecords()
      expect(records[0]).toMatchObject({
        remoteKey: TEMPLATE,
        resourceUri: URI,
        outcome: 'unknown',
        requestSent: true,
        unknownOutcome: true,
        doNotRetry: true
      })
      const repaired = reconcileAgentMcpOutcomes(displaySession(operation), records)
      expect(repaired.messages[0].toolCalls![0]).toMatchObject({
        status: 'error',
        mcp: { outcome: 'unknown', resourceUri: URI, requestSent: true }
      })
      const replay = await subject.service.invoke(operation, signal(), () => {}, {
        beforeSend: vi.fn(async () => {}),
        settle: vi.fn(async (_outcome: AgentMcpInvocationOutcome) => {})
      })
      expect(replay).toMatchObject({ outcome: 'not-sent', requestSent: false })
      expect(await subject.requests('resources/read')).toHaveLength(1)
    }
  )
})
