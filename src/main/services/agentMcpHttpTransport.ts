// SPDX-License-Identifier: Apache-2.0
// Guarded Streamable HTTP wire policy adapted from licensed vivi-cli mcp-http-transport.ts.
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type {
  FetchLike,
  JSONRPCMessage,
  Transport,
  TransportSendOptions
} from '@modelcontextprotocol/client'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { validateMcpEndpoint } from './agentMcpConfig'
import type { McpHttpLaunchIdentity } from './agentMcpConfig'

export const MCP_HTTP_LIMITS = Object.freeze({
  requestBytes: 64 * 1024,
  responseBytes: 1024 * 1024,
  requestMs: 30_000
})
const requests = new Set([
  'initialize',
  'server/discover',
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'tools/call',
  'resources/read'
])
const notifications = new Set(['notifications/initialized', 'notifications/cancelled'])
interface SendTicket {
  readonly message: JSONRPCMessage
  readonly signal?: AbortSignal
  used: boolean
}
export interface McpHttpTransportOptions {
  /** Recheck the approved connection after SDK async setup and before each startup request. */
  readonly beforeConnectRequest?: () => Promise<void>
  /** Trusted session-only credential read. Never refreshes or starts an auth flow. */
  readonly token?: () => string | undefined
  readonly fetch?: FetchLike
  /** Host approval/persistence recheck at the final HTTP wire boundary. */
  readonly operationStarted: (message: JSONRPCMessage) => void
  readonly beforeOperation: (message: JSONRPCMessage) => Promise<void>
  /** Rejects credentials without any automatic auth flow, scope expansion or replay. */
  readonly authorizationRejected?: () => void | Promise<void>
}
/** Streamable HTTP only: no redirects, background GET, resumption, replay or automatic auth. */
export class McpHttpTransport implements Transport {
  readonly hasPerRequestStream = true
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined
  onmessage: ((message: JSONRPCMessage) => void) | undefined
  private readonly sdk: StreamableHTTPClientTransport
  private readonly controller = new AbortController()
  private readonly tickets = new Map<string, SendTicket>()
  private readonly bodies = new Set<() => Promise<void>>()
  private readonly cleanup = new Set<Promise<void>>()
  private readonly requestControllers = new Map<string | number, AbortController>()
  private readonly operationBodies = new Map<string | number, Set<() => Promise<void>>>()
  private closed = false
  private started = false
  private closing?: Promise<void>
  constructor(
    private readonly launch: McpHttpLaunchIdentity,
    private readonly options: McpHttpTransportOptions
  ) {
    validateMcpEndpoint(launch.server.endpoint, launch.server.allowLoopbackHttp)
    this.sdk = new StreamableHTTPClientTransport(new URL(launch.server.endpoint), {
      fetch: (input, init) => this.wire(input, init),
      requestInit: { redirect: 'manual' },
      ...(options.token ? { authProvider: { token: async () => options.token!() } } : {}),
      onInsufficientScope: 'throw',
      maxStepUpRetries: 0,
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 0,
        maxReconnectionDelay: 0,
        reconnectionDelayGrowFactor: 1
      }
    })
    this.sdk.onclose = () => this.onclose?.()
    this.sdk.onerror = () =>
      this.onerror?.(new Error('MCP HTTP request or response is unavailable'))
    this.sdk.onmessage = (message) => {
      this.onmessage?.(message)
      // A response completes this request. Do not retain a server-kept-open SSE stream.
      if ('id' in message && message.id !== undefined && !('method' in message))
        void this.finishOperation(message.id)
    }
  }
  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('MCP HTTP transport cannot be restarted')
    this.started = true
    await this.sdk.start()
  }
  setProtocolVersion(version: string): void {
    this.sdk.setProtocolVersion(version)
  }
  async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    if (!this.started || this.closed) throw new Error('MCP HTTP connection is closed')
    if (
      !('method' in message) ||
      !('id' in message ? requests : notifications).has(message.method) ||
      options?.resumptionToken
    )
      throw new Error('MCP HTTP request is unsupported')
    if (message.method === 'notifications/cancelled') {
      const requestId = message.params?.requestId
      if (typeof requestId === 'string' || typeof requestId === 'number')
        void this.finishOperation(requestId)
    }
    if (
      options?.headers &&
      Object.keys(options.headers).some((name) => !/^mcp-param-[a-z0-9_-]+$/i.test(name))
    )
      throw new Error('MCP HTTP request headers are unsupported')
    const body = JSON.stringify(message)
    if (Buffer.byteLength(body) > MCP_HTTP_LIMITS.requestBytes || this.tickets.has(body))
      throw new Error('MCP HTTP outgoing frame exceeds its limit or is already in flight')
    const request = new AbortController()
    const requestId = 'id' in message ? message.id : undefined
    if (requestId !== undefined) this.requestControllers.set(requestId, request)
    const requestSignal = AbortSignal.any([
      request.signal,
      this.controller.signal,
      AbortSignal.timeout(MCP_HTTP_LIMITS.requestMs),
      ...(options?.requestSignal ? [options.requestSignal] : [])
    ])
    requestSignal.addEventListener(
      'abort',
      () => {
        if (requestId !== undefined && this.requestControllers.get(requestId) === request)
          this.requestControllers.delete(requestId)
      },
      { once: true }
    )
    const ticket: SendTicket = { message, signal: requestSignal, used: false }
    this.tickets.set(body, ticket)
    try {
      await this.sdk.send(message, {
        requestSignal,
        ...(options?.onRequestStreamEnd ? { onRequestStreamEnd: options.onRequestStreamEnd } : {}),
        ...(options?.headers ? { headers: options.headers } : {})
      })
    } catch (error) {
      request.abort()
      if (requestId !== undefined) this.requestControllers.delete(requestId)
      throw error
    } finally {
      this.tickets.delete(body)
    }
  }
  private async wire(
    input: Parameters<FetchLike>[0],
    init?: Parameters<FetchLike>[1]
  ): Promise<Response> {
    this.controller.signal.throwIfAborted()
    await this.options.beforeConnectRequest?.()
    this.controller.signal.throwIfAborted()
    const target = typeof input === 'string' ? input : input.href
    if (target !== this.launch.server.endpoint)
      throw new Error('MCP HTTP destination differs from the configured endpoint')
    const headers = new Headers(init?.headers)
    // The legacy SDK probes this optional channel. Keep it local and never open a background stream.
    if (init?.method === 'GET' && !headers.has('last-event-id'))
      return new Response(null, { status: 405 })
    if (init?.method !== 'POST' || headers.has('last-event-id') || typeof init.body !== 'string')
      throw new Error('MCP HTTP replay, resumption or extra request is unsupported')
    const ticket = this.tickets.get(init.body)
    if (!ticket || ticket.used || mcpDigest(JSON.parse(init.body)) !== mcpDigest(ticket.message))
      throw new Error('MCP HTTP request has no one-shot send ticket')
    // Consume before any async work: even an SDK-internal retry cannot reuse this ticket.
    ticket.used = true
    const signal = AbortSignal.any([
      this.controller.signal,
      AbortSignal.timeout(MCP_HTTP_LIMITS.requestMs),
      ...(init.signal ? [init.signal] : []),
      ...(ticket.signal ? [ticket.signal] : [])
    ])
    signal.throwIfAborted()
    if (
      'method' in ticket.message &&
      ['tools/call', 'resources/read'].includes(ticket.message.method)
    )
      await this.options.beforeOperation(ticket.message)
    signal.throwIfAborted()
    // No asynchronous token refresh is allowed; authentication changes require a new connection/proposal.
    const token = this.options.token?.()
    if ((headers.get('authorization') ?? undefined) !== (token ? `Bearer ${token}` : undefined))
      throw new Error('MCP HTTP authorization changed before send')
    if (
      'method' in ticket.message &&
      ['tools/call', 'resources/read'].includes(ticket.message.method)
    )
      this.options.operationStarted(ticket.message)
    const response = await (this.options.fetch ?? fetch)(input, {
      ...init,
      signal,
      redirect: 'manual'
    })
    if (response.status === 401 || response.status === 403) {
      // Even a late response to a cancelled request rejects its captured epoch.
      // The owner checks that epoch before synchronously revoking current authority.
      try {
        await this.options.authorizationRejected?.()
      } finally {
        await this.cancelResponse(response)
      }
      throw new Error('MCP HTTP needs sign-in; one-shot request was not replayed')
    }
    if (signal.aborted) {
      await this.cancelResponse(response)
      signal.throwIfAborted()
    }
    if ((response.status >= 300 && response.status < 400) || response.redirected) {
      await this.cancelResponse(response)
      throw new Error('MCP HTTP redirects require a separately configured endpoint')
    }
    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId !== null && (sessionId.length > 256 || !/^[\x21-\x7e]+$/.test(sessionId))) {
      await this.cancelResponse(response)
      throw new Error('MCP HTTP session header is invalid or exceeds its bounds')
    }
    // Auto negotiates on this connection. Failed modern probes cannot establish
    // a legacy session; successful modern responses must never carry one.
    if (
      response.ok &&
      headers.get('mcp-protocol-version') === '2026-07-28' &&
      response.headers.has('mcp-session-id')
    ) {
      await this.cancelResponse(response)
      throw new Error('Modern MCP HTTP does not support transport sessions')
    }
    return await this.boundResponse(
      response,
      signal,
      'id' in ticket.message ? ticket.message.id : undefined
    )
  }
  private cancelResponse(response: Response): Promise<void> {
    if (!response.body) return Promise.resolve()
    const task = response.body.cancel().catch(() => undefined)
    this.cleanup.add(task)
    void task.finally(() => this.cleanup.delete(task))
    return task
  }
  private async boundResponse(
    response: Response,
    signal: AbortSignal,
    requestId?: string | number
  ): Promise<Response> {
    const length = response.headers.get('content-length')
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > MCP_HTTP_LIMITS.responseBytes)
    ) {
      await this.cancelResponse(response)
      throw new Error('MCP HTTP response exceeds its byte limit')
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    let bytes = 0,
      finished = false,
      streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const release = (): void => {
      this.bodies.delete(cancel)
      if (requestId !== undefined) {
        const bodies = this.operationBodies.get(requestId)
        bodies?.delete(cancel)
        if (!bodies?.size) this.operationBodies.delete(requestId)
      }
    }
    const finish = (): void => {
      signal.removeEventListener('abort', abort)
      release()
    }
    let cancelling: Promise<void> | undefined
    const cancel = (): Promise<void> => {
      if (cancelling) return cancelling
      if (finished) return Promise.resolve()
      finished = true
      signal.removeEventListener('abort', abort)
      streamController?.error(new Error('MCP HTTP response stream closed'))
      cancelling = reader
        .cancel()
        .catch(() => undefined)
        .finally(() => {
          release()
          this.cleanup.delete(cancelling!)
        })
      this.cleanup.add(cancelling)
      return cancelling
    }
    const abort = (): void => {
      void cancel()
    }
    this.bodies.add(cancel)
    if (requestId !== undefined) {
      const bodies = this.operationBodies.get(requestId) ?? new Set<() => Promise<void>>()
      bodies.add(cancel)
      this.operationBodies.set(requestId, bodies)
    }
    signal.addEventListener('abort', abort, { once: true })
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller
      },
      async pull(controller) {
        try {
          signal.throwIfAborted()
          const next = await reader.read()
          if (finished) return
          if (next.done) {
            finished = true
            finish()
            controller.close()
            return
          }
          bytes += next.value.byteLength
          if (bytes > MCP_HTTP_LIMITS.responseBytes)
            throw new Error('MCP HTTP response exceeds its byte limit')
          controller.enqueue(next.value)
        } catch {
          if (!finished) {
            controller.error(new Error('MCP HTTP response is invalid or exceeds its bounds'))
            await cancel()
          }
        }
      },
      async cancel() {
        await cancel()
      }
    })
    if (signal.aborted) void cancel()
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
  /** Await already-started stream cancellation without touching other live requests. */
  async drainCleanup(): Promise<void> {
    await Promise.all([...this.cleanup])
  }
  /** Close and drain the exact completed invocation's response stream. */
  async finishOperation(requestId: string | number | undefined): Promise<void> {
    if (requestId === undefined) return
    this.requestControllers.get(requestId)?.abort()
    this.requestControllers.delete(requestId)
    await Promise.all([...(this.operationBodies.get(requestId) ?? [])].map((cancel) => cancel()))
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    for (const request of this.requestControllers.values()) request.abort()
    this.requestControllers.clear()
    const bodies = [...this.bodies]
    this.controller.abort()
    this.closing = (async () => {
      await this.sdk.close()
      await Promise.all([...bodies.map((cancel) => cancel()), ...this.cleanup])
      this.tickets.clear()
    })()
    return this.closing
  }
}
