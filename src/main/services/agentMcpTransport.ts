// SPDX-License-Identifier: Apache-2.0
// Licensed owned-process implementation adapted from vivi-cli mcp-transport.ts.
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/client'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client'
import type { McpLaunchIdentity } from './agentMcpConfig'
import type { WindowsMcpProcess } from './agentMcpWindows'
import { verifyMcpGroupDead } from './agentMcpProcessGroup'

const REQUESTS = new Set([
  'initialize',
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'tools/call',
  'resources/read'
])
const NOTIFICATIONS = new Set(['notifications/initialized', 'notifications/cancelled'])
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
/** Single owned process group, strict launch environment, no shell or automatic sibling probe. */
export class McpStdioTransport implements Transport {
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onmessage: ((message: JSONRPCMessage) => void) | undefined
  private child: ChildProcessWithoutNullStreams | undefined
  private windows: WindowsMcpProcess | undefined
  private closing: Promise<void> | undefined
  private closed = false
  private closeNotified = false
  private posixCleanupAttempted = false
  private started = false
  private starting: Promise<void> | undefined
  private readonly buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 })
  constructor(private readonly launch: McpLaunchIdentity) {}
  get stderr(): null {
    return null
  }
  get pid(): number | undefined {
    return this.child?.pid
  }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('MCP transport cannot be restarted')
    this.started = true
    this.starting = this.beginStart()
    await this.starting
  }
  private async beginStart(): Promise<void> {
    if (process.platform === 'win32') {
      const { launchWindowsMcp } = await import('./agentMcpWindows')
      if (this.closed) throw new Error('MCP connection closed before startup')
      const owned = await launchWindowsMcp(
        {
          executable: this.launch.server.executable,
          args: this.launch.server.args,
          cwd: this.launch.server.cwd,
          env: this.launch.environment
        },
        { hostEnv: process.env, cleanupTimeoutMs: 5000 }
      )
      this.windows = owned
      if (this.closed) {
        await owned.stop()
        throw new Error('MCP connection closed during startup')
      }
      owned.stderr.on('data', () => undefined)
      owned.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
      void owned.completed.then((result) => {
        if (result.error)
          this.onerror?.(new Error('MCP Windows process cleanup could not be verified'))
        void this.close().catch(() =>
          this.onerror?.(new Error('MCP process cleanup could not be verified'))
        )
      })
      return
    }
    const child = spawn(this.launch.server.executable, [...this.launch.server.args], {
      cwd: this.launch.server.cwd,
      env: { ...this.launch.environment },
      shell: false,
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    // Server stderr is untrusted, may contain credentials and terminal controls. Drain, never display/store it.
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => this.onerror?.(new Error('MCP input stream failed')))
    child.stdout.on('error', () => this.onerror?.(new Error('MCP output stream failed')))
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    child.once('exit', () => {
      void this.close().catch(() =>
        this.onerror?.(new Error('MCP process cleanup could not be verified'))
      )
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => {
        const error = new Error('MCP installed executable could not start')
        this.onerror?.(error)
        reject(error)
        void this.close().catch(() =>
          this.onerror?.(new Error('MCP process cleanup could not be verified'))
        )
      })
    })
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('MCP connection is closed')
    if ('method' in message && !('id' in message ? REQUESTS : NOTIFICATIONS).has(message.method))
      throw new Error('MCP request is unsupported')
    const encoded = serializeMessage(message)
    if (Buffer.byteLength(encoded) > 64 * 1024)
      throw new Error('MCP outgoing frame exceeds its limit')
    if (this.windows) {
      await this.windows.write(Buffer.from(encoded, 'utf8'))
      return
    }
    const stream = this.child?.stdin
    if (!stream || this.closed || stream.destroyed) throw new Error('MCP connection is closed')
    await new Promise<void>((resolve, reject) => {
      stream.write(encoded, (error) =>
        error ? reject(new Error('MCP input stream failed')) : resolve()
      )
    })
  }
  private receive(chunk: Buffer): void {
    if (this.closed) return
    try {
      this.buffer.append(chunk)
      let message
      while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message)
    } catch {
      this.onerror?.(new Error('MCP protocol frame is invalid or exceeds its limit'))
      void this.close().catch(() =>
        this.onerror?.(new Error('MCP process cleanup could not be verified'))
      )
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    const closing = this.dispose()
    this.closing = closing
    void closing.catch(() => {
      if (this.closing === closing) this.closing = undefined
    })
    return closing
  }
  private async dispose(): Promise<void> {
    this.closed = true
    await this.starting?.catch(() => undefined)
    const child = this.child,
      pid = child?.pid
    try {
      if (this.windows) {
        await this.windows.stop()
        const result = await this.windows.completed
        if (result.error) throw new Error('MCP Windows process cleanup could not be verified')
      }
      if (pid) {
        // A trusted server can still escape a process group. This is lifecycle ownership, not an OS sandbox.
        if (!this.posixCleanupAttempted) {
          this.posixCleanupAttempted = true
          try {
            process.kill(-pid, 'SIGTERM')
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
              throw new Error('MCP process cleanup could not be verified')
          }
          const exited =
            child?.exitCode !== null || child?.signalCode !== null
              ? Promise.resolve()
              : new Promise<void>((resolve) => child?.once('exit', () => resolve()))
          await Promise.race([exited, wait(250)])
          try {
            process.kill(-pid, 'SIGKILL')
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
              throw new Error('MCP process cleanup could not be verified')
          }
          await Promise.race([exited, wait(1000)])
        }
        if (child?.exitCode === null && child.signalCode === null)
          throw new Error('MCP process cleanup timed out')
        // POSIX retries only verify death: cached numeric group IDs may have been reused.
        await verifyMcpGroupDead(pid)
      }
    } finally {
      child?.stdin.destroy()
      child?.stdout.destroy()
      child?.stderr.destroy()
      this.buffer.clear()
      if (!this.closeNotified) {
        this.closeNotified = true
        this.onclose?.()
      }
    }
  }
}
