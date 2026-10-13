// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Adapted for Electron main from ayayaQ/vivi-cli, revision
// 38978a34adf1ae16ea2e61cbe15f9d8b01e1065c.
// https://github.com/ayayaQ/vivi-cli/blob/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c/src/mcp-oauth-callback.ts
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'

export class McpOAuthError extends Error {
  constructor(
    readonly code:
      | 'cancelled'
      | 'timeout'
      | 'callback-unavailable'
      | 'authorization-denied'
      | 'invalid-plan'
      | 'client-registration-required'
      | 'authorization-failed'
      | 'client-registration-failed'
      | 'client-registration-uncertain'
      | 'client-registration-cancelled'
  ) {
    super(
      {
        cancelled: 'MCP sign-in cancelled',
        timeout: 'MCP sign-in timed out',
        'callback-unavailable': 'MCP sign-in callback is unavailable',
        'authorization-denied': 'MCP sign-in was declined',
        'invalid-plan': 'MCP sign-in changed; prepare it again',
        'client-registration-required': 'MCP requires a registered public OAuth client',
        'client-registration-failed': 'MCP public client registration failed',
        'client-registration-cancelled': 'MCP public client registration cancelled before sending',
        'client-registration-uncertain':
          'MCP public client registration is unconfirmed; the service may have created a client. Nothing was stored. Check the service before trying again',
        'authorization-failed': 'MCP sign-in failed'
      }[code]
    )
    this.name = 'McpOAuthError'
  }
}
export interface McpOAuthCallbackOptions {
  readonly state: string
  readonly issuer: string
  readonly requireIssuer: boolean
  readonly port: number
  readonly path?: string
  readonly signal: AbortSignal
  readonly isActive: () => boolean
  readonly registerSecrets: (values: readonly string[]) => void
}
export interface McpOAuthCallbackResult {
  readonly code: string
  readonly iss?: string
}
export function validateMcpOAuthRedirectPath(path: string): string {
  if (
    path.length > 512 ||
    !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(path) ||
    new URL(path, 'http://127.0.0.1').pathname !== path
  )
    throw new McpOAuthError('authorization-failed')
  return path
}
const PAGE = 'MCP sign-in received. You can return to Bot Commander Desktop.'
const INVALID = 'This MCP sign-in callback is invalid.'
const text = (value: string | null): value is string =>
  !!value && value.length <= 4096 && !/[\u0000-\u0020\u007f-\u009f]/.test(value)
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a),
    right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
/** One IPv4 loopback listener owned by one sign-in. Never serves provider text or credentials. */
export class McpOAuthCallback {
  readonly result: Promise<McpOAuthCallbackResult>
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private resolve!: (result: McpOAuthCallbackResult) => void
  private reject!: (error: McpOAuthError) => void
  private settled = false
  private closing: Promise<void> | undefined
  private connections = 0
  private readonly path: string
  private url: URL | undefined
  private readonly abort = (): void => {
    this.fail(new McpOAuthError('cancelled'))
    void this.close()
  }
  private constructor(private readonly options: McpOAuthCallbackOptions) {
    this.path =
      options.path === undefined
        ? `/mcp-oauth/${randomBytes(24).toString('hex')}`
        : validateMcpOAuthRedirectPath(options.path)
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    void this.result.catch(() => undefined)
    this.server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      const reject = (): void => {
        response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
        response.end(INVALID)
      }
      const raw = request.url ?? ''
      const hosts = request.rawHeaders.filter(
        (_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'host'
      )
      if (
        this.settled ||
        options.signal.aborted ||
        !options.isActive() ||
        !this.url ||
        request.method !== 'GET' ||
        hosts.length !== 1 ||
        request.headers.host !== this.url.host ||
        !raw.startsWith('/') ||
        raw.startsWith('//') ||
        raw.includes('\\') ||
        Buffer.byteLength(raw) > 8192 ||
        raw.includes('#') ||
        /%(?![\da-f]{2})/i.test(raw) ||
        request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0')
      ) {
        reject()
        return
      }
      let parsed
      try {
        parsed = new URL(raw, this.url)
      } catch {
        reject()
        return
      }
      if (parsed.origin !== this.url.origin || parsed.pathname !== this.path) {
        reject()
        return
      }
      const params = parsed.searchParams
      if (
        [...new Set(params.keys())].some((key) => params.getAll(key).length !== 1) ||
        !equal(params.get('state') ?? '', options.state)
      ) {
        reject()
        return
      }
      const iss = params.get('iss')
      // Bind both success and error responses before consuming any provider text.
      if ((iss !== null && iss !== options.issuer) || (options.requireIssuer && iss === null)) {
        reject()
        return
      }
      const code = params.get('code'),
        error = params.get('error')
      if ((code !== null && error !== null) || (!text(code) && !text(error))) {
        reject()
        return
      }
      if (code) {
        try {
          options.registerSecrets([code])
        } catch {
          reject()
          this.fail(new McpOAuthError('authorization-failed'))
          void this.close()
          return
        }
      }
      this.settled = true
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
        Connection: 'close'
      })
      response.end(PAGE)
      if (error) this.reject(new McpOAuthError('authorization-denied'))
      else this.resolve({ code: code!, ...(iss === null ? {} : { iss }) })
    })
    this.server.headersTimeout = 5000
    this.server.requestTimeout = 5000
    this.server.maxConnections = 16
    this.server.on('connection', (socket) => {
      if (++this.connections > 64) {
        socket.destroy()
        this.fail(new McpOAuthError('callback-unavailable'))
        void this.close()
        return
      }
      this.sockets.add(socket)
      socket.setTimeout(5000, () => socket.destroy())
      socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('error', () => {
      this.fail(new McpOAuthError('callback-unavailable'))
      void this.close()
    })
    options.signal.addEventListener('abort', this.abort, { once: true })
  }
  static async listen(options: McpOAuthCallbackOptions): Promise<McpOAuthCallback> {
    if (options.signal.aborted || !options.isActive()) throw new McpOAuthError('cancelled')
    const callback = new McpOAuthCallback(options)
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (): void => {
          reject(new McpOAuthError('callback-unavailable'))
        }
        const aborted = (): void => {
          reject(new McpOAuthError('cancelled'))
        }
        const cleanup = (): void => {
          callback.server.removeListener('error', failed)
          options.signal.removeEventListener('abort', aborted)
        }
        callback.server.once('error', failed)
        options.signal.addEventListener('abort', aborted, { once: true })
        callback.server.listen(options.port, '127.0.0.1', () => {
          cleanup()
          resolve()
        })
        void callback.result.catch(() => cleanup())
      })
      const address = callback.server.address()
      if (!address || typeof address === 'string' || options.signal.aborted || !options.isActive())
        throw new McpOAuthError('cancelled')
      callback.url = new URL(`http://127.0.0.1:${address.port}${callback.path}`)
      return callback
    } catch (error) {
      await callback.close()
      throw error
    }
  }
  get redirectUrl(): URL {
    if (!this.url) throw new McpOAuthError('callback-unavailable')
    return new URL(this.url)
  }
  private fail(error: McpOAuthError): void {
    if (!this.settled) {
      this.settled = true
      this.reject(error)
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.options.signal.removeEventListener('abort', this.abort)
    this.fail(new McpOAuthError('cancelled'))
    this.closing = new Promise((resolve) => {
      this.server.close(() => resolve())
      for (const socket of this.sockets) socket.destroy()
    })
    return this.closing
  }
}
