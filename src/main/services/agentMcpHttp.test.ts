import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike, JSONRPCMessage } from '@modelcontextprotocol/client'
import type { McpCatalogKind } from '@ayayaq/vivi/extensions/mcp'
import {
  McpConfigStore,
  prepareMcpLaunch,
  validateMcpServer,
  type McpServerConfig
} from './agentMcpConfig'
import {
  AgentMcpService,
  agentMcpOperationDisclosure,
  type AgentMcpInvocationHooks,
  type AgentMcpInvocationOutcome
} from './agentMcpService'
import { McpHttpTransport, MCP_HTTP_LIMITS } from './agentMcpHttpTransport'
import { reopenAtomicWrites } from './atomicPersistence'
import { resumeAgentPersistence } from './agentPersistenceLifecycle'

vi.mock('electron', () => ({ app: { getPath: () => '/unused-offline-http-state' } }))

const BASE = {
  transport: 'http',
  id: 'remote',
  label: 'Owned offline HTTP fixture',
  endpoint: 'https://mcp.example.test/endpoint',
  protocol: '2026-07-28',
  allowLoopbackHttp: false
} as const
const TOKEN = 'offline-session-bearer-fixture'
const REMOTE_NAME = 'echo/name'
const URI = 'fixture:///exact'
const TEMPLATE = 'fixture:///{name}'
const VARIABLES = { name: 'document/é %2f' }
const EXPANDED_URI = 'fixture:///document%2F%C3%A9%20%252f'
const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false
}
const signal = () => new AbortController().signal
const subjects: Array<{ directory: string; service: AgentMcpService }> = []
const standalone: McpHttpTransport[] = []

interface Authorization {
  revision: string
  bearerToken?: string
}
interface RecordedRequest {
  message: JSONRPCMessage
  headers: Headers
  signal?: AbortSignal
}
interface FixtureOptions {
  authorization?: Authorization
  disconnected?: boolean
  templates?: boolean
  metadataEffect?: (message: JSONRPCMessage) => Promise<Response> | Response
  effect?: (message: JSONRPCMessage, init: Parameters<FetchLike>[1]) => Promise<Response> | Response
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((fulfil) => {
    resolve = fulfil
  })
  return { promise, resolve }
}
function json(
  message: JSONRPCMessage,
  result: Record<string, unknown>,
  protocol: McpServerConfig['protocol'],
  headers: Record<string, string> = {}
): Response {
  if (!('id' in message)) throw new Error('Fixture response requires a request ID')
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result:
        protocol === 'legacy'
          ? result
          : { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
    }),
    { headers: { 'content-type': 'application/json', ...headers } }
  )
}
function hooks(beforeSend?: () => Promise<void>): AgentMcpInvocationHooks {
  return {
    beforeSend: vi.fn(beforeSend ?? (async () => {})),
    settle: vi.fn(async (_outcome: AgentMcpInvocationOutcome) => {})
  }
}
async function fixture(
  protocol: McpServerConfig['protocol'] = BASE.protocol,
  options: FixtureOptions = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-agent-mcp-http-'))
  const store = new McpConfigStore(join(directory, 'private'))
  const requests: RecordedRequest[] = []
  const effects: JSONRPCMessage[] = []
  const server: McpServerConfig = { ...BASE, protocol }
  let authorization: Authorization = options.authorization ?? { revision: 'anonymous' }
  let privacy = 1
  const httpFetch: FetchLike = async (input, init) => {
    // Every wire call stays in this fixture. The SDK's optional legacy GET is local-only.
    expect(String(input)).toBe(BASE.endpoint)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    expect(typeof init?.body).toBe('string')
    const message: JSONRPCMessage = JSON.parse(init!.body as string)
    if (!('method' in message)) throw new Error('Unsupported fixture message')
    const headers = new Headers(init?.headers)
    expect(headers.has('last-event-id')).toBe(false)
    requests.push({ message, headers, signal: init?.signal ?? undefined })
    if (['tools/call', 'resources/read'].includes(message.method)) {
      effects.push(message)
      if (options.effect) return options.effect(message, init)
      return json(
        message,
        message.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'HTTP_CONFIRMED' }] }
          : { contents: [{ uri: message.params?.uri, text: 'HTTP_RESOURCE' }] },
        protocol
      )
    }
    if (message.method === 'initialize')
      return json(
        message,
        {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'Owned offline fixture', version: '1' }
        },
        protocol,
        { 'mcp-session-id': 'owned-legacy-session' }
      )
    if (['notifications/initialized', 'notifications/cancelled'].includes(message.method))
      return new Response(null, { status: 202 })
    if (message.method === 'server/discover')
      return json(
        message,
        { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } },
        protocol
      )
    if (message.method === 'tools/list')
      return json(message, { tools: [{ name: REMOTE_NAME, inputSchema: SCHEMA }] }, protocol)
    if (message.method === 'resources/list' && options.metadataEffect)
      return options.metadataEffect(message)
    if (message.method === 'resources/list')
      return json(message, { resources: [{ uri: URI, name: 'Owned resource' }] }, protocol)
    if (message.method === 'resources/templates/list')
      return json(
        message,
        {
          resourceTemplates: options.templates ? [{ uriTemplate: TEMPLATE, name: 'Template' }] : []
        },
        protocol
      )
    throw new Error(`Unexpected fixture method ${message.method}`)
  }
  const service = new AgentMcpService({
    store,
    env: {},
    httpAuthorization: () => authorization,
    httpFetch,
    privacyRevision: () => privacy
  })
  subjects.push({ directory, service })
  await service.configure(server)
  if (!options.disconnected) {
    expect((await service.start((await service.prepareLaunch(server.id)).token)).started).toBe(true)
    await service.refresh(
      server.id,
      options.templates ? ['resources', 'resourceTemplates'] : ['resources']
    )
  }
  return {
    directory,
    store,
    server,
    service,
    requests,
    effects,
    setAuthorization(value: Authorization) {
      authorization = value
    },
    changePrivacy() {
      privacy++
    },
    async prepare(kind: McpCatalogKind = 'tools') {
      const [snapshot] = await service.captureCatalogs(signal())
      const entry = snapshot.categories[kind].entries[0]
      return service.prepareOperation(snapshot, entry, kind, {
        id: `http-operation-${kind}`,
        name:
          kind === 'tools'
            ? entry.alias
            : kind === 'resourceTemplates'
              ? 'read_mcp_resource_template'
              : 'read_mcp_resource',
        arguments:
          kind === 'tools'
            ? { query: 'ordinary' }
            : kind === 'resourceTemplates'
              ? { serverId: server.id, uriTemplate: TEMPLATE, variables: VARIABLES }
              : { serverId: server.id, uri: URI }
      })
    }
  }
}
async function transport(fetch: FetchLike, protocol: McpServerConfig['protocol'] = BASE.protocol) {
  const launch = await prepareMcpLaunch(
    { ...BASE, protocol },
    'offline-config',
    {},
    [],
    'anonymous'
  )
  const peer = new McpHttpTransport(launch, {
    beforeOperation: async () => {},
    operationStarted: () => {},
    fetch
  })
  standalone.push(peer)
  await peer.start()
  return peer
}
const REQUEST: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: REMOTE_NAME, arguments: { query: 'ordinary' } }
}

beforeEach(() => {
  resumeAgentPersistence()
  reopenAtomicWrites()
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network disabled in fixture'))
})
afterEach(async () => {
  try {
    for (const peer of standalone.splice(0)) await peer.close()
    for (const subject of subjects.splice(0)) {
      await subject.service.close()
      await rm(subject.directory, { recursive: true, force: true })
    }
  } finally {
    vi.restoreAllMocks()
  }
})

describe('HTTP configuration and launch approval', () => {
  it('accepts HTTPS and explicitly selected numeric loopback HTTP without arbitrary auth fields', () => {
    expect(validateMcpServer(BASE)).toEqual(BASE)
    for (const endpoint of ['http://127.0.0.1/mcp', 'http://[::1]/mcp']) {
      expect(validateMcpServer({ ...BASE, endpoint, allowLoopbackHttp: true })).toMatchObject({
        endpoint
      })
    }
    for (const endpoint of [
      'http://example.test/mcp',
      'http://127.0.0.1/mcp',
      'https://user:password@example.test/mcp',
      'https://example.test/mcp?token=value',
      'https://example.test/mcp#fragment',
      'file:///mcp',
      'https://mcp.example.test/endpoint?',
      'https://mcp.example.test/endpoint#',
      'https:mcp.example.test/endpoint',
      'https://mcp.example.test/a b',
      String.raw`https:\\mcp.example.test\endpoint`
    ]) {
      expect(() => validateMcpServer({ ...BASE, endpoint })).toThrow()
    }
    for (const endpoint of ['http://localhost/mcp', 'http://127.0.0.2/mcp']) {
      expect(() => validateMcpServer({ ...BASE, endpoint, allowLoopbackHttp: true })).toThrow()
    }
    for (const extra of [{ headers: {} }, { bearerToken: TOKEN }, { environment: [] }]) {
      expect(() => validateMcpServer({ ...BASE, ...extra })).toThrow()
    }
    expect(() => validateMcpServer({ ...BASE, label: TOKEN }, [TOKEN])).toThrow()
  })
  it('binds HTTP launch identity to configuration and auth revision without bearer data', async () => {
    const first = await prepareMcpLaunch(BASE, 'config-1', {}, [], 'auth-1')
    const changedAuth = await prepareMcpLaunch(BASE, 'config-1', {}, [], 'auth-2')
    const changedConfig = await prepareMcpLaunch(BASE, 'config-2', {}, [], 'auth-1')
    expect(first).toMatchObject({
      server: BASE,
      configRevision: 'config-1',
      authRevision: 'auth-1'
    })
    expect(changedAuth.digest).not.toBe(first.digest)
    expect(changedConfig.digest).not.toBe(first.digest)
    expect(JSON.stringify(first)).not.toContain(TOKEN)
  })
  it('configuration/list/capture are offline and startup uses separate one-shot approval', async () => {
    const subject = await fixture('2026-07-28', { disconnected: true })
    expect((await subject.service.list()).servers[0].state).toBe('disabled')
    expect(await subject.service.captureCatalogs(signal())).toEqual([])
    expect(subject.requests).toEqual([])
    const launch = await subject.service.prepareLaunch('remote')
    expect(launch.disclosure).toContain(BASE.endpoint)
    expect(launch.disclosure).not.toContain('Executable:')
    expect(subject.requests).toEqual([])
    subject.service.cancelLaunch(launch.token)
    await expect(subject.service.start(launch.token)).rejects.toThrow()
    expect(subject.requests).toEqual([])
  })
  it('session bearer remains absent from persisted config, launch approval and result', async () => {
    const subject = await fixture('2026-07-28', {
      disconnected: true,
      authorization: { revision: 'auth-1', bearerToken: TOKEN }
    })
    const launch = await subject.service.prepareLaunch('remote')
    expect(launch.disclosure).not.toContain(TOKEN)
    expect(await readFile(join(subject.store.directory, 'mcp-servers.json'), 'utf8')).not.toContain(
      TOKEN
    )
    expect(JSON.stringify(await subject.service.list())).not.toContain(TOKEN)
    expect((await subject.service.start(launch.token)).started).toBe(true)
    const outcome = await subject.service.invoke(
      await subject.prepare(),
      signal(),
      () => {},
      hooks()
    )
    expect(outcome.outcome).toBe('confirmed')
    expect(JSON.stringify(outcome)).not.toContain(TOKEN)
    expect(
      subject.requests
        .find(({ message }) => 'method' in message && message.method === 'tools/call')
        ?.headers.get('authorization')
    ).toBe(`Bearer ${TOKEN}`)
  })
  it.each(['auth', 'token', 'endpoint', 'privacy'] as const)(
    'changed %s after approval requires fresh startup and sends nothing',
    async (change) => {
      const subject = await fixture('2026-07-28', {
        disconnected: true,
        authorization: { revision: 'auth-1', bearerToken: TOKEN }
      })
      const launch = await subject.service.prepareLaunch('remote')
      if (change === 'auth') subject.setAuthorization({ revision: 'auth-2', bearerToken: TOKEN })
      if (change === 'token')
        subject.setAuthorization({ revision: 'auth-1', bearerToken: 'offline-replaced-bearer' })
      if (change === 'privacy') subject.changePrivacy()
      if (change === 'endpoint')
        await subject.store.save(
          [{ ...subject.server, endpoint: 'https://mcp.example.test/changed' }],
          (await subject.store.load()).revision
        )
      await expect(subject.service.start(launch.token)).rejects.toThrow()
      expect(subject.requests).toEqual([])
    }
  )
})

for (const protocol of ['legacy', '2026-07-28'] as const) {
  describe(`${protocol} HTTP through real client SDK`, () => {
    it.each(['tools', 'resources'] as const)(
      'sends one exact %s POST after durable intent',
      async (kind) => {
        const subject = await fixture(protocol)
        const operation = await subject.prepare(kind)
        const lifecycle = hooks(async () => {
          expect(subject.effects).toEqual([])
        })
        const outcome = await subject.service.invoke(operation, signal(), () => {}, lifecycle)
        expect(outcome).toMatchObject({
          outcome: 'confirmed',
          requestSent: true,
          unknownOutcome: false,
          doNotRetry: false
        })
        expect(outcome.result.content).toContain(
          kind === 'tools' ? 'HTTP_CONFIRMED' : 'HTTP_RESOURCE'
        )
        expect(subject.effects).toHaveLength(1)
        expect(lifecycle.beforeSend).toHaveBeenCalledOnce()
        expect(lifecycle.settle).toHaveBeenCalledWith(outcome)
        const request = subject.requests.find(
          ({ message }) =>
            'method' in message &&
            message.method === (kind === 'tools' ? 'tools/call' : 'resources/read')
        )!
        expect(request.headers.get('mcp-protocol-version')).toBe(
          protocol === 'legacy' ? '2025-11-25' : protocol
        )
        expect(request.headers.get('mcp-session-id')).toBe(
          protocol === 'legacy' ? 'owned-legacy-session' : null
        )
        expect(request.headers.get('mcp-method')).toBe(
          protocol === 'legacy' ? null : kind === 'tools' ? 'tools/call' : 'resources/read'
        )
        if ('method' in request.message) {
          expect(request.message.params).toMatchObject(
            kind === 'tools'
              ? { name: REMOTE_NAME, arguments: { query: 'ordinary' } }
              : { uri: URI }
          )
        }
        const repeated = await subject.service.invoke(operation, signal(), () => {}, hooks())
        expect(repeated.requestSent).toBe(false)
        expect(subject.effects).toHaveLength(1)
        expect(
          subject.requests.filter(
            ({ message }) => 'method' in message && message.method === 'tools/list'
          )
        ).toHaveLength(1)
      }
    )
    it('expands an approved template into an exact resource read', async () => {
      const subject = await fixture(protocol, { templates: true })
      const operation = await subject.prepare('resourceTemplates')
      expect(operation.remoteKey).toBe(TEMPLATE)
      expect(operation.resourceUri).toBe(EXPANDED_URI)
      expect(agentMcpOperationDisclosure(operation)).toContain(EXPANDED_URI)
      const outcome = await subject.service.invoke(operation, signal(), () => {}, hooks())
      expect(outcome.outcome).toBe('confirmed')
      expect(JSON.parse(outcome.result.content).remoteKey).toBe(EXPANDED_URI)
      expect(subject.effects).toHaveLength(1)
      expect(subject.effects[0]).toMatchObject({
        method: 'resources/read',
        params: { uri: EXPANDED_URI }
      })
      if ('method' in subject.effects[0])
        expect(subject.effects[0].params).not.toHaveProperty('uriTemplate')
    })
    it.each([401, 403, 404, 500, 307])(
      'keeps HTTP %s uncertain without retry, redirect or sign-in requests',
      async (status) => {
        const subject = await fixture(protocol, {
          authorization: { revision: 'auth-1', bearerToken: TOKEN },
          effect: () =>
            new Response('untrusted error text', {
              status,
              headers:
                status === 307
                  ? { location: 'https://different.example.test/' }
                  : { 'www-authenticate': 'Bearer' }
            })
        })
        const outcome = await subject.service.invoke(
          await subject.prepare(),
          signal(),
          () => {},
          hooks()
        )
        expect(outcome).toMatchObject({
          outcome: 'unknown',
          requestSent: true,
          unknownOutcome: true,
          doNotRetry: true
        })
        expect(outcome.result.content).not.toContain('untrusted error text')
        expect(outcome.result.content).not.toContain(TOKEN)
        expect(subject.effects).toHaveLength(1)
        expect(await subject.service.captureCatalogs(signal())).toEqual([])
      }
    )
    it('rejects 403 insufficient_scope without OAuth discovery or expanded-scope sends', async () => {
      const subject = await fixture(protocol, {
        authorization: { revision: 'auth-1', bearerToken: TOKEN },
        effect: () =>
          new Response('scope escalation is unavailable', {
            status: 403,
            headers: {
              'www-authenticate':
                'Bearer error="insufficient_scope", scope="write admin", resource_metadata="https://auth.example.test/resource"'
            }
          })
      })
      const outcome = await subject.service.invoke(
        await subject.prepare(),
        signal(),
        () => {},
        hooks()
      )
      expect(outcome).toMatchObject({ outcome: 'unknown', requestSent: true, doNotRetry: true })
      expect(subject.effects).toHaveLength(1)
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect((await subject.service.list()).servers[0]).toMatchObject({ state: 'error' })
      expect(await subject.service.captureCatalogs(signal())).toEqual([])
    })
    it('waits for metadata SSE cancellation before refresh resolves', async () => {
      const entered = deferred(),
        cancellation = deferred()
      const subject = await fixture(protocol, {
        disconnected: true,
        metadataEffect: (message) => {
          if (!('id' in message)) throw new Error('Missing metadata request ID')
          const payload = {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              resources: [],
              ...(protocol === 'legacy'
                ? {}
                : { resultType: 'complete', ttlMs: 0, cacheScope: 'private' })
            }
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
              },
              async cancel() {
                entered.resolve()
                await cancellation.promise
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      })
      expect(
        (await subject.service.start((await subject.service.prepareLaunch('remote')).token)).started
      ).toBe(true)
      let settled = false
      const refreshing = subject.service.refresh('remote', ['resources']).then((value) => {
        settled = true
        return value
      })
      await entered.promise
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(settled).toBe(false)
      } finally {
        cancellation.resolve()
      }
      expect((await refreshing).servers[0].catalog?.resources).toMatchObject({
        state: 'ready',
        available: 0
      })
      expect(subject.effects).toEqual([])
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })
    it.each(['auth', 'token', 'config', 'privacy'] as const)(
      'rechecks changed %s after durable intent and sends nothing',
      async (change) => {
        const subject = await fixture(protocol, {
          templates: true,
          authorization: { revision: 'auth-1', bearerToken: TOKEN }
        })
        const operation = await subject.prepare('resourceTemplates')
        const lifecycle = hooks(async () => {
          if (change === 'auth')
            subject.setAuthorization({ revision: 'auth-2', bearerToken: TOKEN })
          if (change === 'token')
            subject.setAuthorization({ revision: 'auth-1', bearerToken: 'offline-replaced-bearer' })
          if (change === 'privacy') subject.changePrivacy()
          if (change === 'config')
            await subject.store.save(
              [{ ...subject.server, label: 'Changed owned fixture' }],
              (await subject.store.load()).revision
            )
        })
        const outcome = await subject.service.invoke(operation, signal(), () => {}, lifecycle)
        expect(outcome).toMatchObject({
          outcome: 'not-sent',
          requestSent: false,
          unknownOutcome: false
        })
        expect(lifecycle.beforeSend).toHaveBeenCalledOnce()
        expect(lifecycle.settle).toHaveBeenCalledWith(outcome)
        expect(subject.effects).toEqual([])
      }
    )
    it('aborts request-scoped SSE on cancellation without a resume request', async () => {
      const entered = deferred()
      const controller = new AbortController()
      let cancelled = 0
      let wireSignal: AbortSignal | undefined
      const subject = await fixture(protocol, {
        effect: (_message, init) => {
          wireSignal = init?.signal ?? undefined
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new TextEncoder().encode('id: prime\ndata: \n\n'))
                entered.resolve()
              },
              cancel() {
                cancelled++
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      })
      const pending = subject.service.invoke(
        await subject.prepare(),
        controller.signal,
        () => {},
        hooks()
      )
      await entered.promise
      controller.abort()
      expect(await pending).toMatchObject({
        outcome: 'unknown',
        requestSent: true,
        doNotRetry: true
      })
      expect(wireSignal?.aborted).toBe(true)
      expect(cancelled).toBe(1)
      expect(subject.effects).toHaveLength(1)
      if (protocol !== 'legacy')
        expect(
          subject.requests.some(
            ({ message }) => 'method' in message && message.method === 'notifications/cancelled'
          )
        ).toBe(false)
    })
    it('bounds JSON response bytes before parsing and never retries', async () => {
      const subject = await fixture(protocol, {
        effect: () =>
          new Response('x'.repeat(MCP_HTTP_LIMITS.responseBytes + 1), {
            headers: { 'content-type': 'application/json' }
          })
      })
      expect(
        await subject.service.invoke(await subject.prepare(), signal(), () => {}, hooks())
      ).toMatchObject({ outcome: 'unknown', requestSent: true, doNotRetry: true })
      expect(subject.effects).toHaveLength(1)
    })
    it('waits for completed SSE cancellation before settling a confirmed operation', async () => {
      const entered = deferred(),
        cancellation = deferred()
      let cancelled = 0,
        settled = false
      const subject = await fixture(protocol, {
        effect: (message) => {
          if (!('id' in message)) throw new Error('Missing request ID')
          const payload = {
            jsonrpc: '2.0',
            id: message.id,
            result: {
              content: [{ type: 'text', text: 'SSE_CONFIRMED' }],
              ...(protocol === 'legacy' ? {} : { resultType: 'complete' })
            }
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`))
              },
              async cancel() {
                cancelled++
                entered.resolve()
                await cancellation.promise
              }
            }),
            { headers: { 'content-type': 'text/event-stream' } }
          )
        }
      })
      const pending = subject.service
        .invoke(await subject.prepare(), signal(), () => {}, hooks())
        .then((value) => {
          settled = true
          return value
        })
      await entered.promise
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(settled).toBe(false)
        expect(cancelled).toBe(1)
      } finally {
        cancellation.resolve()
      }
      expect(await pending).toMatchObject({ outcome: 'confirmed', requestSent: true })
      expect(subject.effects).toHaveLength(1)
      expect((await subject.service.list()).servers[0].state).toBe('connected')
    })
  })
}

describe('HTTP one-shot wire ticket', () => {
  it('rejects an SDK-internal duplicate POST before a second fetch or send marker', async () => {
    const launch = await prepareMcpLaunch(BASE, 'offline-config', {}, [], 'anonymous')
    const beforeOperation = vi.fn(async () => {})
    const operationStarted = vi.fn()
    const offlineFetch = vi.fn<FetchLike>(async () => new Response(null, { status: 202 }))
    const peer = new McpHttpTransport(launch, {
      beforeOperation,
      operationStarted,
      fetch: offlineFetch
    })
    standalone.push(peer)
    // Simulate an SDK regression replaying a POST inside one transport.send call.
    // Both attempts still pass through the production guarded fetch boundary.
    const sdk = (peer as unknown as { sdk: { _fetch: FetchLike } }).sdk
    const guarded = sdk._fetch
    sdk._fetch = async (input, init) => {
      await guarded(input, init)
      return guarded(input, init)
    }
    await peer.start()
    await expect(peer.send(REQUEST)).rejects.toThrow('no one-shot send ticket')
    expect(offlineFetch).toHaveBeenCalledOnce()
    expect(beforeOperation).toHaveBeenCalledOnce()
    expect(operationStarted).toHaveBeenCalledOnce()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('HTTP transport owned cleanup', () => {
  it('close owns pending SSE-reader cancellation until cleanup settles', async () => {
    const entered = deferred(),
      cancellation = deferred()
    const peer = await transport(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('id: prime\ndata: \n\n'))
            },
            async cancel() {
              entered.resolve()
              await cancellation.promise
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
    )
    await peer.send(REQUEST)
    let closed = false
    const closing = peer.close().then(() => {
      closed = true
    })
    await entered.promise
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(closed).toBe(false)
    } finally {
      cancellation.resolve()
    }
    await closing
    expect(closed).toBe(true)
  })
  it('oversized Content-Length drains the rejected response before send and close settle', async () => {
    const entered = deferred(),
      cancellation = deferred()
    const peer = await transport(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              entered.resolve()
              await cancellation.promise
            }
          }),
          {
            headers: {
              'content-type': 'application/json',
              'content-length': String(MCP_HTTP_LIMITS.responseBytes + 1)
            }
          }
        )
    )
    let settled = false,
      closed = false
    const sending = peer.send(REQUEST).catch((error: Error) => {
      settled = true
      expect(error.message).toMatch(/byte limit/)
    })
    await entered.promise
    const closing = peer.close().then(() => {
      closed = true
    })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(settled).toBe(false)
      expect(closed).toBe(false)
    } finally {
      cancellation.resolve()
    }
    await Promise.all([sending, closing])
    expect(settled).toBe(true)
    expect(closed).toBe(true)
  })
  it.each(['legacy', '2026-07-28'] as const)(
    'completed %s metadata SSE drains without a background stream',
    async (protocol) => {
      const entered = deferred(),
        cancellation = deferred()
      const peer = await transport(async (_input, init) => {
        const message: JSONRPCMessage = JSON.parse(init!.body as string)
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              if (!('id' in message)) throw new Error('Missing request ID')
              stream.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}\n\n`
                )
              )
            },
            async cancel() {
              entered.resolve()
              await cancellation.promise
            }
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        )
      }, protocol)
      const responses = vi.fn()
      peer.onmessage = responses
      await peer.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      await entered.promise
      let drained = false
      const draining = peer.drainCleanup().then(() => {
        drained = true
      })
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(drained).toBe(false)
        expect(responses).toHaveBeenCalledOnce()
      } finally {
        cancellation.resolve()
      }
      await draining
      expect(drained).toBe(true)
    }
  )
})
