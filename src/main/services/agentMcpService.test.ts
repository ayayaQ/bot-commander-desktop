import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JsonObject } from '@ayayaq/vivi'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import type { McpCatalogSnapshot } from '@ayayaq/vivi/extensions/mcp'
import { AgentMcpService, type AgentMcpInvocationOutcome } from './agentMcpService'
import { McpConfigStore, type McpServerConfig } from './agentMcpConfig'
import { reopenAtomicWrites } from './atomicPersistence'
import { resumeAgentPersistence } from './agentPersistenceLifecycle'
vi.mock('electron', () => ({ app: { getPath: () => '/unreferenced-test-state' } }))
const signal = () => new AbortController().signal
const tool = {
  name: 'echo/name',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false
  }
}
function gate() {
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
      release = resolve
    }),
    ready = new Promise<void>((resolve) => {
      entered = resolve
    })
  return { held, ready, release, entered }
}
class OfflineTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  readonly messages: JSONRPCMessage[] = []
  starts = 0
  closes = 0
  closeFailure = false
  closeThrows = false
  handshakeFailure = false
  mode: 'normal' | 'drop' | 'throw' | 'protocol-error' | 'input-required' | 'binary' = 'normal'
  tools: unknown[] = [tool]
  responseText: string | undefined
  resourceReads = 0
  startupGate?: ReturnType<typeof gate>
  start(): Promise<void> {
    this.starts++
    if (this.startupGate) {
      this.startupGate.entered()
      return this.startupGate.held
    }
    return Promise.resolve()
  }
  close(): Promise<void> {
    this.closes++
    if (this.closeThrows) throw new Error('offline synchronous cleanup failure')
    if (this.closeFailure) return Promise.reject(new Error('offline cleanup failure'))
    this.onclose?.()
    return Promise.resolve()
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.messages.push(structuredClone(message))
    if (!('method' in message) || !('id' in message)) return
    if (message.method === 'initialize' && this.handshakeFailure) {
      queueMicrotask(() =>
        this.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: 'offline rejected handshake' }
        })
      )
      return
    }
    let result: unknown
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
        serverInfo: { name: 'Inert offline fixture', version: '1' }
      }
    else if (message.method === 'server/discover')
      result = {
        resultType: 'complete',
        supportedVersions: ['2026-07-28'],
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: 'Inert offline fixture', version: '1' }
        }
      }
    else if (message.method === 'tools/list') result = { resultType: 'complete', tools: this.tools }
    else if (message.method === 'resources/list')
      result = {
        resultType: 'complete',
        resources: [{ uri: 'fixture:///document', name: 'Document' }]
      }
    else if (message.method === 'resources/templates/list')
      result = {
        resultType: 'complete',
        resourceTemplates: [{ uriTemplate: 'fixture:///{name}', name: 'Template' }]
      }
    else if (message.method === 'tools/call' || message.method === 'resources/read') {
      if (this.mode === 'drop') return
      if (this.mode === 'throw') throw new Error('offline partial write uncertainty')
      if (this.mode === 'protocol-error') {
        queueMicrotask(() =>
          this.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: 'Never disclose raw server diagnostics' }
          })
        )
        return
      }
      result =
        this.mode === 'input-required'
          ? { resultType: 'input_required', inputRequests: {} }
          : message.method === 'resources/read'
            ? {
                resultType: 'complete',
                contents: [
                  {
                    uri: 'fixture:///document',
                    text: this.responseText ?? `Fresh resource ${++this.resourceReads}`
                  }
                ]
              }
            : {
                resultType: 'complete',
                content:
                  this.mode === 'binary'
                    ? [
                        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
                        {
                          type: 'resource_link',
                          uri: 'https://never-fetch.example.test/',
                          name: 'Unfetched link'
                        }
                      ]
                    : [{ type: 'text', text: this.responseText ?? 'Confirmed offline result' }]
              }
    } else throw new Error('Unsupported inert fixture method')
    queueMicrotask(() =>
      this.onmessage?.({
        jsonrpc: '2.0',
        id: message.id,
        result: { ...(result as Record<string, unknown>), ttlMs: 0, cacheScope: 'private' }
      })
    )
  }
  notify(): void {
    this.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} })
  }
  count(method: string): number {
    return this.messages.filter((message) => 'method' in message && message.method === method)
      .length
  }
}
const subjects: Array<{
  directory: string
  service: AgentMcpService
  transports: OfflineTransport[]
}> = []
beforeEach(() => {
  resumeAgentPersistence()
  reopenAtomicWrites()
})
afterEach(async () => {
  for (const subject of subjects.splice(0)) {
    for (const peer of subject.transports) {
      peer.closeFailure = false
      peer.closeThrows = false
      peer.startupGate?.release()
    }
    await subject.service.close()
    await rm(subject.directory, { recursive: true, force: true })
  }
})
async function fixture(
  protocol: McpServerConfig['protocol'] = 'legacy',
  start = true,
  configureTransport?: (peer: OfflineTransport) => void
) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-agent-mcp-'))
  const executable = join(
    directory,
    process.platform === 'win32' ? 'fixture.exe' : 'fixture-server'
  )
  await copyFile(process.platform === 'win32' ? process.execPath : '/bin/true', executable)
  await chmod(executable, 0o700)
  const store = new McpConfigStore(join(directory, 'private')),
    transports: OfflineTransport[] = []
  const env: NodeJS.ProcessEnv = {
      HOME: directory,
      SYSTEMROOT: 'C:\\Windows',
      API_KEY: 'offline-known-credential'
    },
    secrets = ['offline-known-credential']
  let privacy = 1,
    now = 1000
  const service = new AgentMcpService({
    store,
    env,
    secrets: () => secrets,
    privacyRevision: () => privacy,
    now: () => now,
    transportFactory: () => {
      const peer = new OfflineTransport()
      configureTransport?.(peer)
      transports.push(peer)
      return peer
    }
  })
  subjects.push({ directory, service, transports })
  const server: McpServerConfig = {
    id: 'fixture',
    label: 'Offline fixture',
    executable,
    args: [],
    cwd: directory,
    protocol,
    environment: []
  }
  await service.configure(server)
  if (start)
    expect((await service.start((await service.prepareLaunch('fixture')).token)).started).toBe(true)
  return {
    directory,
    store,
    server,
    service,
    transports,
    env,
    secrets,
    privacyChange() {
      privacy++
    },
    expire() {
      now += 120001
    },
    peer: () => transports.at(-1)!
  }
}
async function prepared(
  subject: Awaited<ReturnType<typeof fixture>>,
  kind: 'tools' | 'resources' = 'tools',
  snapshot?: McpCatalogSnapshot
) {
  if (kind === 'resources') await subject.service.refresh('fixture', ['resources'])
  snapshot ??= (await subject.service.captureCatalogs(signal()))[0]
  const entry = snapshot.categories[kind].entries[0]
  return subject.service.prepareOperation(snapshot, entry, kind, {
    id: `call-${kind}`,
    name: kind === 'tools' ? entry.alias : 'read_mcp_resource',
    arguments: kind === 'tools' ? { query: 'hello' } : { serverId: 'fixture', uri: entry.remoteKey }
  })
}
function hooks() {
  return {
    beforeSend: vi.fn(async () => {}),
    settle: vi.fn(async (_outcome: AgentMcpInvocationOutcome) => {})
  }
}
function internalTransport(service: AgentMcpService): Transport {
  return (
    service as unknown as { connections: Map<string, { transport: Transport }> }
  ).connections.get('fixture')!.transport
}

describe('explicit lifecycle and control authority', () => {
  it('construction/list/capture never starts a process and cancelled launch cannot be consumed', async () => {
    const subject = await fixture('legacy', false)
    expect((await subject.service.list()).servers[0].state).toBe('disabled')
    expect(await subject.service.captureCatalogs(signal())).toEqual([])
    const launch = await subject.service.prepareLaunch('fixture')
    expect(launch.disclosure).toContain('before any tool-call approval')
    expect(launch.disclosure).toContain('selected provider context')
    subject.service.cancelLaunch(launch.token)
    await expect(subject.service.start(launch.token)).rejects.toThrow('unavailable')
    expect(subject.transports).toHaveLength(0)
  })
  it.each(['legacy', '2026-07-28'] as const)(
    'starts exactly once using %s and emits terminal status before response',
    async (protocol) => {
      const subject = await fixture(protocol, false),
        states: string[] = []
      subject.service.onStatusChanged((status) => states.push(status.servers[0].state))
      const launch = await subject.service.prepareLaunch('fixture'),
        pending = subject.service.start(launch.token)
      await expect(subject.service.start(launch.token)).rejects.toThrow('consumed')
      const result = await pending
      expect(result.started).toBe(true)
      expect(states).toContain('connecting')
      expect(states.at(-1)).toBe('connected')
      expect(result.status.servers[0].catalog?.tools.available).toBe(1)
      expect(subject.peer().starts).toBe(1)
      expect(subject.peer().count('tools/call')).toBe(0)
      expect(subject.peer().count('resources/read')).toBe(0)
    }
  )
  it.each(['rejected Promise', 'synchronous throw'] as const)(
    'observes detached SDK close %s while retaining strict host cleanup failures',
    async (failure) => {
      const unhandled: unknown[] = [],
        observe = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', observe)
      try {
        const subject = await fixture('legacy', false, (peer) => {
          peer.handshakeFailure = true
          peer.closeFailure = failure === 'rejected Promise'
          peer.closeThrows = failure === 'synchronous throw'
        })
        await expect(
          subject.service.start((await subject.service.prepareLaunch('fixture')).token)
        ).rejects.toThrow('cleanup could not be verified')
        // The SDK's detached close and strict host close both exercised the same owned handle.
        expect(subject.peer().closes).toBeGreaterThanOrEqual(2)
        expect((await subject.service.list()).servers[0]).toMatchObject({
          state: 'error',
          cleanupPending: true
        })
        await expect(subject.service.prepareLaunch('fixture')).rejects.toThrow('disconnect')
        await expect(subject.service.disconnect('fixture')).rejects.toThrow(
          'cleanup could not be verified'
        )
        await expect(subject.service.close()).rejects.toThrow(/cleanup|drain/)
        subject.service.resume()
        await expect(subject.service.prepareLaunch('fixture')).rejects.toThrow('disconnect')
        expect(subject.transports).toHaveLength(1)
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(unhandled).toEqual([])
        subject.peer().closeFailure = false
        subject.peer().closeThrows = false
        expect((await subject.service.disconnect('fixture')).servers[0].state).toBe('disabled')
      } finally {
        process.off('unhandledRejection', observe)
      }
    }
  )
  it.each(['config', 'executable', 'cwd', 'environment', 'privacy', 'expiration'] as const)(
    'rejects changed %s before actual process startup',
    async (change) => {
      const subject = await fixture('legacy', false)
      const name = process.platform === 'win32' ? 'SYSTEMROOT' : 'HOME'
      if (change === 'environment')
        await subject.service.configure({ ...subject.server, environment: [name] })
      const launch = await subject.service.prepareLaunch('fixture')
      if (change === 'config')
        await subject.store.save(
          [{ ...subject.server, label: 'Changed' }],
          (await subject.store.load()).revision
        )
      if (change === 'executable')
        await writeFile(subject.server.executable, 'different installed bytes')
      if (change === 'cwd') await rm(subject.directory, { recursive: true, force: true })
      if (change === 'environment') subject.env[name] += 'changed'
      if (change === 'privacy') subject.privacyChange()
      if (change === 'expiration') subject.expire()
      await expect(subject.service.start(launch.token)).rejects.toThrow()
      expect(subject.transports.every((peer) => peer.starts === 0)).toBe(true)
    }
  )
  it('prunes a lost expired token while keeping fresh approval explicit', async () => {
    const subject = await fixture('legacy', false),
      old = await subject.service.prepareLaunch('fixture')
    subject.expire()
    const fresh = await subject.service.prepareLaunch('fixture')
    expect(fresh.token).not.toBe(old.token)
    await expect(subject.service.start(old.token)).rejects.toThrow('unavailable')
    expect(subject.transports).toHaveLength(0)
    expect((await subject.service.start(fresh.token)).started).toBe(true)
  })
  it('cancels pending permits on renderer lifecycle while preserving completed connections', async () => {
    const subject = await fixture('legacy', false),
      old = await subject.service.prepareLaunch('fixture')
    subject.service.cancelPendingLaunches()
    await expect(subject.service.start(old.token)).rejects.toThrow('unavailable')
    expect(
      (await subject.service.start((await subject.service.prepareLaunch('fixture')).token)).started
    ).toBe(true)
    subject.service.cancelPendingLaunches()
    expect((await subject.service.list()).servers[0].state).toBe('connected')
  })
  it('renderer revocation also cancels a preparation whose control callback has not run', async () => {
    const subject = await fixture('legacy', false),
      pending = subject.service.prepareLaunch('fixture'),
      rejected = expect(pending).rejects.toThrow('cancelled')
    subject.service.cancelPendingLaunches()
    await rejected
    expect(
      (await subject.service.start((await subject.service.prepareLaunch('fixture')).token)).started
    ).toBe(true)
  })
  it('renderer revocation blocks a late preparation response from issuing an orphan token', async () => {
    const subject = await fixture('legacy', false),
      held = gate(),
      load = subject.store.load.bind(subject.store)
    let reads = 0
    subject.store.load = async () => {
      const value = await load()
      if (reads++ === 0) {
        held.entered()
        await held.held
      }
      return value
    }
    const pending = subject.service.prepareLaunch('fixture'),
      rejected = expect(pending).rejects.toThrow('cancelled')
    await held.ready
    subject.service.cancelPendingLaunches()
    held.release()
    await rejected
    expect(
      (await subject.service.start((await subject.service.prepareLaunch('fixture')).token)).started
    ).toBe(true)
  })
  it('cancelLaunch aborts an in-flight delayed startup without discarding its owner', async () => {
    const subject = await fixture('legacy', false),
      held = gate()
    ;(
      subject.service as unknown as { options: { transportFactory: () => OfflineTransport } }
    ).options.transportFactory = () => {
      const peer = new OfflineTransport()
      peer.startupGate = held
      subject.transports.push(peer)
      return peer
    }
    const launch = await subject.service.prepareLaunch('fixture'),
      pending = subject.service.start(launch.token)
    await held.ready
    subject.service.cancelLaunch(launch.token)
    subject.expire()
    await expect(subject.service.prepareLaunch('fixture')).rejects.toThrow()
    held.release()
    expect((await pending).started).toBe(false)
    expect(subject.peer().closes).toBeGreaterThan(0)
  })
  it('expected pre-start cancellation drains cleanly at quit and resume never reconnects', async () => {
    const subject = await fixture('legacy', false),
      held = gate(),
      load = subject.store.load.bind(subject.store)
    subject.store.load = async () => {
      const value = await load()
      held.entered()
      await held.held
      return value
    }
    const pending = subject.service.prepareLaunch('fixture'),
      rejected = expect(pending).rejects.toThrow()
    await held.ready
    subject.service.pause()
    const closing = subject.service.close()
    held.release()
    await rejected
    await closing
    subject.service.resume()
    expect((await subject.service.list()).servers[0].state).toBe('disabled')
    expect(subject.transports).toHaveLength(0)
  })
  it('upsert revokes old catalog/launch and pause/close/resume restores no connection', async () => {
    const subject = await fixture(),
      old = await prepared(subject)
    await subject.service.configure({ ...subject.server, label: 'Edited trusted fixture' })
    expect((await subject.service.invoke(old, signal(), () => {}, hooks())).requestSent).toBe(false)
    expect(subject.peer().closes).toBeGreaterThan(0)
    expect((await subject.service.list()).servers[0].server.label).toBe('Edited trusted fixture')
    await subject.service.close()
    subject.service.resume()
    expect(await subject.service.captureCatalogs(signal())).toEqual([])
    expect(subject.transports).toHaveLength(1)
  })
})

describe('one-shot actual send and durable outcomes', () => {
  it.each(['legacy', '2026-07-28'] as const)(
    'sends exact %s once after durable intent without SDK refresh/retry',
    async (protocol) => {
      const subject = await fixture(protocol),
        operation = await prepared(subject),
        lifecycle = hooks()
      lifecycle.beforeSend.mockImplementation(async () => {
        expect(subject.peer().count('tools/call')).toBe(0)
      })
      const outcome = await subject.service.invoke(operation, signal(), () => {}, lifecycle)
      expect(outcome).toMatchObject({
        outcome: 'confirmed',
        requestSent: true,
        unknownOutcome: false,
        doNotRetry: false
      })
      expect(outcome.result.content).toContain('Confirmed offline result')
      expect(lifecycle.beforeSend).toHaveBeenCalledOnce()
      expect(lifecycle.settle).toHaveBeenCalledWith(outcome)
      expect(subject.peer().count('tools/call')).toBe(1)
      expect(subject.peer().count('tools/list')).toBe(1)
      expect(
        (await subject.service.invoke(operation, signal(), () => {}, hooks())).requestSent
      ).toBe(false)
    }
  )
  it.each(['method', 'name', 'arguments', 'metadata', 'top-level'] as const)(
    'rejects outgoing SDK %s drift at boundary',
    async (change) => {
      const subject = await fixture('2026-07-28'),
        operation = await prepared(subject),
        lifecycle = hooks(),
        transport = internalTransport(subject.service),
        guarded = transport.send.bind(transport)
      transport.send = async (message, options) => {
        if ('method' in message && message.method === 'tools/call') {
          const altered = structuredClone(message)
          if (change === 'method') altered.method = 'tools/list'
          if (change === 'name') altered.params = { ...altered.params, name: 'unapproved' }
          if (change === 'arguments')
            altered.params = { ...altered.params, arguments: { query: 'unapproved' } }
          if (change === 'metadata')
            altered.params = {
              ...altered.params,
              _meta: { ...(altered.params?._meta as Record<string, unknown>), unapproved: 'extra' }
            }
          if (change === 'top-level') Object.assign(altered, { unapproved: 'extra' })
          await guarded(altered, options)
        } else await guarded(message, options)
      }
      expect(
        (await subject.service.invoke(operation, signal(), () => {}, lifecycle)).requestSent
      ).toBe(false)
      expect(lifecycle.beforeSend).not.toHaveBeenCalled()
      expect(lifecycle.settle).toHaveBeenCalledOnce()
      expect(subject.peer().count('tools/call')).toBe(0)
      expect(subject.peer().count('tools/list')).toBe(1)
    }
  )
  it('blocks a second transport write after permit consumption', async () => {
    const subject = await fixture(),
      operation = await prepared(subject),
      transport = internalTransport(subject.service),
      guarded = transport.send.bind(transport)
    let blocked = false
    transport.send = async (message, options) => {
      await guarded(message, options)
      if ('method' in message && message.method === 'tools/call') {
        try {
          await guarded(message, options)
        } catch {
          blocked = true
        }
      }
    }
    expect((await subject.service.invoke(operation, signal(), () => {}, hooks())).outcome).toBe(
      'confirmed'
    )
    expect(blocked).toBe(true)
    expect(subject.peer().count('tools/call')).toBe(1)
  })
  it('intent rejection proves not-sent and still awaits settlement', async () => {
    const subject = await fixture(),
      lifecycle = hooks()
    lifecycle.beforeSend.mockRejectedValue(new Error('Disk checkpoint unavailable'))
    const outcome = await subject.service.invoke(
      await prepared(subject),
      signal(),
      () => {},
      lifecycle
    )
    expect(outcome).toMatchObject({ outcome: 'not-sent', requestSent: false })
    expect(lifecycle.settle).toHaveBeenCalledWith(outcome)
    expect(subject.peer().count('tools/call')).toBe(0)
  })
  it.each(['config', 'launch', 'catalog', 'privacy', 'run', 'cancel'] as const)(
    'rechecks %s after awaited intent',
    async (change) => {
      const subject = await fixture(),
        lifecycle = hooks(),
        controller = new AbortController(),
        operation = await prepared(subject)
      let active = true
      lifecycle.beforeSend.mockImplementation(async () => {
        if (change === 'config')
          await subject.store.save(
            [{ ...subject.server, label: 'Changed during intent' }],
            (await subject.store.load()).revision
          )
        if (change === 'launch') await writeFile(subject.server.executable, 'changed executable')
        if (change === 'catalog') subject.peer().notify()
        if (change === 'privacy') subject.privacyChange()
        if (change === 'run') active = false
        if (change === 'cancel') controller.abort()
      })
      const outcome = await subject.service.invoke(
        operation,
        controller.signal,
        () => {
          if (!active) throw new Error('Run ended')
        },
        lifecycle
      )
      expect(outcome.requestSent).toBe(false)
      expect(lifecycle.beforeSend).toHaveBeenCalledOnce()
      expect(lifecycle.settle).toHaveBeenCalledOnce()
      expect(subject.peer().count('tools/call')).toBe(0)
    }
  )
  it('does not settle cancellation ahead of the unfinished intent checkpoint', async () => {
    const subject = await fixture(),
      held = gate(),
      lifecycle = hooks(),
      controller = new AbortController()
    lifecycle.beforeSend.mockImplementation(async () => {
      held.entered()
      await held.held
    })
    const pending = subject.service.invoke(
      await prepared(subject),
      controller.signal,
      () => {},
      lifecycle
    )
    await held.ready
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(lifecycle.settle).not.toHaveBeenCalled()
    held.release()
    expect((await pending).requestSent).toBe(false)
    expect(lifecycle.settle).toHaveBeenCalledOnce()
    expect(subject.peer().count('tools/call')).toBe(0)
  })
  it.each(['throw', 'input-required', 'drop'] as const)(
    'treats %s after send as unknown and revokes without retry',
    async (mode) => {
      const subject = await fixture(),
        lifecycle = hooks(),
        controller = new AbortController()
      subject.peer().mode = mode
      const pending = subject.service.invoke(
        await prepared(subject),
        controller.signal,
        () => {},
        lifecycle
      )
      if (mode === 'drop')
        await vi.waitFor(() => {
          expect(subject.peer().count('tools/call')).toBe(1)
          controller.abort()
        })
      const outcome = await pending
      expect(outcome).toMatchObject({
        outcome: 'unknown',
        requestSent: true,
        unknownOutcome: true,
        doNotRetry: true
      })
      expect(JSON.parse(outcome.result.content)).toMatchObject({
        requestSent: true,
        unknownOutcome: true,
        doNotRetry: true
      })
      expect((await subject.service.list()).servers[0].state).toBe('error')
      expect(await subject.service.captureCatalogs(signal())).toEqual([])
      expect(subject.peer().count('tools/call')).toBe(1)
      await expect(subject.service.prepareLaunch('fixture')).rejects.toThrow('disconnect')
    }
  )
  it('retains unverified cleanup handle until explicit disconnect retry', async () => {
    const subject = await fixture()
    subject.peer().mode = 'throw'
    subject.peer().closeFailure = true
    expect(
      (await subject.service.invoke(await prepared(subject), signal(), () => {}, hooks())).outcome
    ).toBe('unknown')
    expect((await subject.service.list()).servers[0].cleanupPending).toBe(true)
    await expect(subject.service.prepareLaunch('fixture')).rejects.toThrow('disconnect')
    subject.peer().closeFailure = false
    await subject.service.disconnect('fixture')
    expect(
      (await subject.service.start((await subject.service.prepareLaunch('fixture')).token)).started
    ).toBe(true)
  })
  it.each(['tools', 'resources'] as const)(
    'binds a safe confirmed %s protocol error with no-retry semantics',
    async (kind) => {
      const subject = await fixture()
      subject.peer().mode = 'protocol-error'
      const outcome = await subject.service.invoke(
        await prepared(subject, kind),
        signal(),
        () => {},
        hooks()
      )
      expect(outcome).toMatchObject({
        outcome: 'confirmed',
        requestSent: true,
        unknownOutcome: false,
        doNotRetry: true
      })
      expect(outcome.result.isError).toBe(true)
      expect(outcome.result.content).not.toContain('Never disclose')
      expect(JSON.parse(outcome.result.content)).toMatchObject({
        success: false,
        source: 'mcp',
        untrusted: true,
        serverId: 'fixture',
        method: kind === 'tools' ? 'tools/call' : 'resources/read',
        remoteKey: kind === 'tools' ? 'echo/name' : 'fixture:///document',
        content: [],
        error: { code: 'mcp_protocol_error' },
        doNotRetry: true
      })
    }
  )
  it.each(['tools', 'resources'] as const)(
    'rejects near64KiB %s output that cannot retain mandatory markers without clipping',
    async (kind) => {
      const subject = await fixture(),
        lifecycle = hooks()
      subject.peer().responseText = 'x'.repeat(65355)
      const outcome = await subject.service.invoke(
        await prepared(subject, kind),
        signal(),
        () => {},
        lifecycle
      )
      expect(outcome).toMatchObject({ outcome: 'unknown', requestSent: true, doNotRetry: true })
      expect(Buffer.byteLength(outcome.result.content)).toBeLessThan(65536)
      expect((await subject.service.list()).servers[0].state).toBe('error')
      expect(lifecycle.settle).toHaveBeenCalledOnce()
    }
  )
  it('retains full nearby confirmed result and reserves checkpoint marker under failed settlement', async () => {
    const subject = await fixture(),
      lifecycle = hooks()
    subject.peer().responseText = 'x'.repeat(65200)
    lifecycle.settle.mockRejectedValue(new Error('Failed outcome checkpoint'))
    const outcome = await subject.service.invoke(
      await prepared(subject),
      signal(),
      () => {},
      lifecycle
    )
    expect(outcome).toMatchObject({
      outcome: 'confirmed',
      checkpointUnconfirmed: true,
      unknownOutcome: false
    })
    expect(outcome.result.content).toContain('x'.repeat(65200))
    expect(Buffer.byteLength(outcome.result.content)).toBeLessThanOrEqual(65536)
    expect(JSON.parse(outcome.result.content)).toMatchObject({
      requestSent: true,
      unknownOutcome: false,
      doNotRetry: false,
      checkpointUnconfirmed: true
    })
  })
  it('always sends a fresh exact discovered resource read without SDK cache', async () => {
    const subject = await fixture()
    for (let sequence = 1; sequence <= 2; sequence++) {
      const outcome = await subject.service.invoke(
        await prepared(subject, 'resources'),
        signal(),
        () => {},
        hooks()
      )
      expect(outcome.outcome).toBe('confirmed')
      expect(outcome.result.content).toContain(`Fresh resource ${sequence}`)
    }
    expect(subject.peer().count('resources/read')).toBe(2)
  })
  it('omits binary and leaves links as unfetched untrusted data', async () => {
    const subject = await fixture()
    subject.peer().mode = 'binary'
    const outcome = await subject.service.invoke(
      await prepared(subject),
      signal(),
      () => {},
      hooks()
    )
    expect(outcome.outcome).toBe('confirmed')
    expect(outcome.result.content).toContain('binaryOmitted')
    expect(outcome.result.content).not.toContain('aW1hZ2U=')
    expect(subject.peer().count('resources/read')).toBe(0)
  })
  it('invalid external config revokes and repairs never restore prior connection', async () => {
    const subject = await fixture()
    await writeFile(join(subject.store.directory, 'mcp-servers.json'), '{invalid private marker')
    await expect(subject.service.captureCatalogs(signal())).rejects.toThrow(
      'unavailable or invalid'
    )
    expect(subject.peer().closes).toBeGreaterThan(0)
    await writeFile(
      join(subject.store.directory, 'mcp-servers.json'),
      JSON.stringify({ schemaVersion: 1, servers: [subject.server] })
    )
    expect((await subject.service.list()).servers[0].state).toBe('disabled')
    expect(subject.transports).toHaveLength(1)
  })
  it('rejects encoded environment-only credentials at the32nd layer before proposal or startup', async () => {
    const subject = await fixture()
    subject.env.API_KEY = 'environment-only-private-fixture'
    let encoded = '%65nvironment-only-private-fixture'
    for (let pass = 1; pass < 32; pass++) encoded = encoded.replace(/%/g, '%25')
    const [snapshot] = await subject.service.captureCatalogs(signal()),
      entry = snapshot.categories.tools.entries[0]
    expect(() =>
      subject.service.prepareOperation(snapshot, entry, 'tools', {
        id: 'encoded',
        name: entry.alias,
        arguments: { query: encoded }
      })
    ).toThrow('known credential')
    await subject.service.disconnect('fixture')
    const name = process.platform === 'win32' ? 'SYSTEMROOT' : 'HOME'
    await subject.service.configure({ ...subject.server, environment: [name] })
    subject.env[name] = encoded
    await expect(subject.service.prepareLaunch('fixture')).rejects.toThrow('known credential')
    expect(subject.transports).toHaveLength(1)
  })
  it('uses shared argument validation/quarantine and invalidates stale snapshots', async () => {
    const subject = await fixture(),
      [snapshot] = await subject.service.captureCatalogs(signal()),
      entry = snapshot.categories.tools.entries[0]
    for (const args of [
      {},
      { query: '' },
      { query: 1 },
      { query: 'ok', extra: true },
      { query: 'offline-known-credential' }
    ])
      expect(() =>
        subject.service.prepareOperation(snapshot, entry, 'tools', {
          id: 'bad',
          name: entry.alias,
          arguments: args as JsonObject
        })
      ).toThrow()
    subject.peer().tools = [
      tool,
      {
        name: 'remote-schema',
        inputSchema: { type: 'object', $ref: 'https://never-fetch.example.test/schema' }
      }
    ]
    expect(
      (await subject.service.refresh('fixture', ['tools'])).servers[0].catalog?.tools.entries[1]
        .state
    ).toBe('quarantined')
    const [current] = await subject.service.captureCatalogs(signal())
    subject.peer().notify()
    expect((await subject.service.list()).servers[0].catalog?.tools.state).toBe('stale')
    await expect(prepared(subject, 'tools', current)).rejects.toThrow('stale')
    expect(subject.peer().count('tools/call')).toBe(0)
  })
  it('never expands resource templates and settles already aborted/paused invocations without intent', async () => {
    const subject = await fixture()
    await subject.service.refresh('fixture', ['resourceTemplates'])
    const [snapshot] = await subject.service.captureCatalogs(signal())
    expect(() =>
      subject.service.prepareOperation(
        snapshot,
        snapshot.categories.resourceTemplates.entries[0],
        'resources',
        {
          id: 'template',
          name: 'read_mcp_resource',
          arguments: { serverId: 'fixture', uri: 'fixture:///invented' }
        }
      )
    ).toThrow()
    for (const paused of [false, true]) {
      const operation = await prepared(subject),
        controller = new AbortController(),
        lifecycle = hooks()
      if (paused) subject.service.pause()
      else controller.abort()
      expect(
        (await subject.service.invoke(operation, controller.signal, () => {}, lifecycle))
          .requestSent
      ).toBe(false)
      expect(lifecycle.beforeSend).not.toHaveBeenCalled()
      expect(lifecycle.settle).toHaveBeenCalledOnce()
      if (paused) subject.service.resume()
    }
  })
})
