import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { JSONRPCMessage } from '@modelcontextprotocol/client'
import { McpStdioTransport } from './agentMcpTransport'
import type { McpLaunchIdentity } from './agentMcpConfig'
const mocks = vi.hoisted(() => ({ spawn: vi.fn(), verify: vi.fn(async (_group: number) => {}) }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('./agentMcpProcessGroup', () => ({ verifyMcpGroupDead: mocks.verify }))
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 2147483647,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
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
  mocks.verify.mockResolvedValue(undefined)
  for (const transport of subjects.splice(0)) await transport.close().catch(() => undefined)
  vi.restoreAllMocks()
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
