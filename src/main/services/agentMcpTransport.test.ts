import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Client, type JSONRPCMessage } from '@modelcontextprotocol/client'
import { McpStdioTransport } from './agentMcpTransport'
import type { McpLaunchIdentity } from './agentMcpConfig'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), verify: vi.fn(async (_group: number) => {}) }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./agentMcpProcessGroup', () => ({ verifyMcpGroupDead: mocks.verify }))
function child() {
  const result = Object.assign(new EventEmitter(), {
    pid: 2147483647,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((_signal: string) => {
      result.emit('close', null)
      return true
    })
  })
  return result
}
const launch = Object.freeze<McpLaunchIdentity>({
  server: {
    id: 'fixture',
    label: 'Inert',
    executable: '/installed/trusted-server',
    args: ['literal white space', '$(never a shell)', '%TOKEN%', ''],
    cwd: '/approved/work',
    protocol: 'legacy',
    environment: ['HOME']
  },
  configRevision: 'config',
  executableRevision: 'executable',
  workingDirectoryRevision: 'cwd',
  environment: { HOME: '/approved/home' },
  digest: 'launch'
})
const subjects: McpStdioTransport[] = []
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
let peer: ReturnType<typeof child>, kill: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  peer = child()
  mocks.spawn.mockReset()
  mocks.verify.mockReset()
  mocks.verify.mockResolvedValue(undefined)
  mocks.spawn.mockImplementation(() => {
    queueMicrotask(() => peer.emit('spawn'))
    return peer as unknown as ChildProcessWithoutNullStreams
  })
  kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal !== 0) {
      peer.exitCode = 0
      peer.emit('exit', 0, null)
    }
    return true
  })
})
afterEach(async () => {
  vi.useRealTimers()
  mocks.verify.mockResolvedValue(undefined)
  for (const transport of subjects.splice(0)) await transport.close().catch(() => undefined)
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const helperFrame = (value: unknown): string => JSON.stringify(value) + '\n'
async function windowsFixture(protocol: 'legacy' | '2026-07-28' = 'legacy') {
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  vi.stubEnv('SystemRoot', 'C:\\Windows')
  const transport = new McpStdioTransport({
    ...launch,
    server: {
      ...launch.server,
      executable: 'C:\\Trusted\\server.exe',
      cwd: 'C:\\approved work',
      protocol,
      environment: ['SYSTEMROOT']
    },
    environment: { SYSTEMROOT: 'C:\\Windows' }
  })
  subjects.push(transport)
  const requests: JSONRPCMessage[] = []
  peer.stdin.on('data', (bytes: Buffer) => {
    const line = bytes.toString('utf8').trim()
    if (line.startsWith('{')) return // Fixed helper configuration, not a server request.
    const request = JSON.parse(Buffer.from(line, 'base64').toString('utf8')) as JSONRPCMessage
    requests.push(request)
    if (
      'method' in request &&
      'id' in request &&
      ['initialize', 'server/discover'].includes(request.method)
    )
      peer.stdout.write(
        helperFrame({
          type: 'stdout',
          data: Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result:
                request.method === 'initialize'
                  ? {
                      protocolVersion: '2025-11-25',
                      capabilities: {},
                      serverInfo: { name: 'Inert readiness fixture', version: '1' }
                    }
                  : {
                      resultType: 'complete',
                      supportedVersions: ['2026-07-28'],
                      capabilities: {},
                      _meta: {
                        'io.modelcontextprotocol/serverInfo': {
                          name: 'Inert readiness fixture',
                          version: '1'
                        }
                      }
                    }
            }) + '\n'
          ).toString('base64')
        })
      )
  })
  return { transport, requests }
}
function verifiedHelperStop(started = false): void {
  peer.stdin.once('end', () => {
    peer.stdout.write(helperFrame({ type: 'exit', exitCode: started ? 1 : null, stopped: true }))
    peer.emit('close', 0)
  })
}
describe('injected Windows readiness and SDK transport boundary', () => {
  it.each(['legacy', '2026-07-28'] as const)(
    'waits for the actual helper acknowledgment before starting the SDK %s five-second handshake',
    async (protocol) => {
      const subject = await windowsFixture(protocol),
        client = new Client(
          { name: 'Inert offline readiness test', version: '1' },
          { versionNegotiation: { mode: protocol === 'legacy' ? 'legacy' : { pin: protocol } } }
        )
      vi.useFakeTimers()
      const connecting = client.connect(subject.transport, {
        timeout: 5000,
        maxTotalTimeout: 10000
      })
      await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
      await vi.advanceTimersByTimeAsync(6000)
      expect(subject.requests).toEqual([])
      expect(peer.stdin.writableEnded).toBe(false)
      peer.stdout.write(helperFrame({ type: 'started' }))
      await connecting
      expect(subject.requests.filter((message) => 'id' in message)).toHaveLength(1)
      expect(subject.requests[0]).toMatchObject({
        method: protocol === 'legacy' ? 'initialize' : 'server/discover'
      })
      expect(client.getNegotiatedProtocolVersion()).toBe(
        protocol === 'legacy' ? '2025-11-25' : protocol
      )
      verifiedHelperStop(true)
      await client.close()
      expect(peer.kill).not.toHaveBeenCalled()
    }
  )
  it('signals EOF before awaiting pending startup and preserves verified prelaunch cleanup', async () => {
    const subject = await windowsFixture(),
      startup = subject.transport.start(),
      rejected = expect(startup).rejects.toThrow('cancelled before readiness')
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
    verifiedHelperStop()
    const closing = subject.transport.close()
    expect(peer.stdin.writableEnded).toBe(true)
    await rejected
    await closing
    expect(subject.requests).toEqual([])
    expect(peer.kill).not.toHaveBeenCalled()
    await expect(subject.transport.start()).rejects.toThrow('cannot be restarted')
  })
  it('rejects strict cleanup and retains the transport when a helper dies without readiness or terminal proof', async () => {
    const subject = await windowsFixture(),
      startup = subject.transport.start(),
      rejected = expect(startup).rejects.toThrow('before readiness')
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())
    peer.emit('close', null)
    await rejected
    await expect(subject.transport.close()).rejects.toThrow('cleanup could not be verified')
    await expect(subject.transport.close()).rejects.toThrow('cleanup could not be verified')
    await expect(subject.transport.start()).rejects.toThrow('cannot be restarted')
    expect(subject.requests).toEqual([])
  })
})
async function fixture() {
  const transport = new McpStdioTransport(launch)
  subjects.push(transport)
  await transport.start()
  return transport
}
describe.skipIf(process.platform === 'win32')('injected owned POSIX stdio', () => {
  it('uses one detached group and exact approved argv/cwd/env, without shell or ambient credentials', async () => {
    const transport = await fixture()
    expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
      launch.server.executable,
      [...launch.server.args],
      {
        cwd: launch.server.cwd,
        env: { HOME: '/approved/home' },
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    expect(transport.stderr).toBeNull()
    expect(transport.pid).toBe(peer.pid)
    await expect(transport.start()).rejects.toThrow('cannot be restarted')
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })
  it('drains stderr, frames exact requests, blocks unsupported methods and bounds output', async () => {
    const transport = await fixture(),
      errors = vi.fn(),
      frames: string[] = []
    transport.onerror = errors
    peer.stderr.write('private marker\x1b[2J')
    peer.stdin.on('data', (bytes) => frames.push(bytes.toString('utf8')))
    const message: JSONRPCMessage = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'exact/name', arguments: { query: 'literal' } }
    }
    await transport.send(message)
    expect(JSON.parse(frames.join(''))).toEqual(message)
    for (const method of [
      'tasks/get',
      'tasks/result',
      'resources/subscribe',
      'subscriptions/listen',
      'elicitation/create',
      'sampling/createMessage',
      'prompts/get'
    ])
      await expect(transport.send({ jsonrpc: '2.0', id: 8, method })).rejects.toThrow('unsupported')
    await expect(
      transport.send({
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name: 'exact', arguments: { text: 'a'.repeat(65536) } }
      })
    ).rejects.toThrow('exceeds')
    expect(errors).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)
  })
  it('decodes split frames and closes invalid JSON-RPC without reporting raw content', async () => {
    const transport = await fixture(),
      messages: JSONRPCMessage[] = [],
      errors: string[] = []
    transport.onmessage = (message) => messages.push(message)
    transport.onerror = (error) => errors.push(error.message)
    const frame =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'ordinary' }] }
      }) + '\n'
    for (const character of frame) peer.stdout.write(character)
    expect(messages).toHaveLength(1)
    peer.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'private invalid frame' }) + '\n'
    )
    await transport.close()
    expect(errors.join(' ')).toContain('protocol frame is invalid')
    expect(errors.join(' ')).not.toContain('private invalid')
    await expect(transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).rejects.toThrow(
      'closed'
    )
  })
  it('fails oversized incoming frame and does not preserve its body', async () => {
    const transport = await fixture(),
      errors: string[] = []
    transport.onerror = (error) => errors.push(error.message)
    peer.stdout.write(Buffer.alloc(1024 * 1024 + 1, 97))
    await transport.close()
    expect(errors.join(' ')).toContain('exceeds its limit')
  })
  it('deduplicates disposal and verifies group death with one closure notification', async () => {
    const transport = await fixture(),
      closed = vi.fn()
    transport.onclose = closed
    const first = transport.close()
    expect(transport.close()).toBe(first)
    await first
    expect(kill).toHaveBeenCalledWith(-peer.pid, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-peer.pid, 'SIGKILL')
    expect(mocks.verify).toHaveBeenCalledWith(peer.pid)
    await transport.close()
    expect(closed).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledOnce()
  })
  it('retains failed cleanup and only verifies on retry, never re-signals cached reused group ID', async () => {
    const transport = await fixture(),
      closed = vi.fn()
    transport.onclose = closed
    mocks.verify.mockRejectedValueOnce(new Error('Death unverified'))
    await expect(transport.close()).rejects.toThrow('Death unverified')
    const count = kill.mock.calls.length
    await transport.close()
    expect(kill.mock.calls).toHaveLength(count)
    expect(mocks.verify).toHaveBeenCalledTimes(2)
    expect(closed).toHaveBeenCalledOnce()
    await expect(transport.start()).rejects.toThrow('cannot be restarted')
  })
  it('redacts spawn errors but still owns cleanup', async () => {
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => peer.emit('error', new Error('private diagnostics')))
      return peer
    })
    const transport = new McpStdioTransport(launch)
    subjects.push(transport)
    const errors: string[] = []
    transport.onerror = (error) => errors.push(error.message)
    await expect(transport.start()).rejects.toThrow('installed executable could not start')
    await transport.close()
    expect(errors.join(' ')).not.toContain('private diagnostics')
  })
})
