// SPDX-License-Identifier: Apache-2.0
// Host lifecycle/review ownership adapted from licensed vivi-cli src/mcp-manager.ts.
// Catalogs, schemas, prepared bindings and content projections use the reviewed shared Vivi API.
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type {
  Client,
  JSONRPCMessage,
  JsonSchemaType,
  Tool,
  Transport
} from '@modelcontextprotocol/client'
import type { JsonObject, ToolCall, ToolResult } from '@ayayaq/vivi'
import {
  assertMcpJson,
  assertMcpOperationCurrent,
  assertMcpOperationResult,
  collectMcpCategory,
  emptyMcpCategory,
  mcpDigest,
  mcpDisplayJson,
  mcpFailure,
  mcpOperationRevisions,
  MCP_LIMITS,
  MCP_OPERATION_LIMITS,
  prepareMcpOperation,
  projectMcpResult,
  type McpCatalogEntry,
  type McpCatalogKind,
  type McpCatalogSnapshot,
  type McpPreparedOperation,
  type McpSchemaValidator
} from '@ayayaq/vivi/extensions/mcp'
import type {
  AgentMcpCategoryStatus,
  AgentMcpLaunchPreparation,
  AgentMcpServerStatus,
  AgentMcpStartResult,
  AgentMcpStatus
} from '../../shared/agentMcpTypes'
import {
  MCP_ENV_NAMES,
  McpConfigStore,
  mcpFreeze,
  prepareMcpLaunch,
  validateMcpServer,
  type McpConfiguration,
  type McpLaunchIdentity,
  type McpServerConfig
} from './agentMcpConfig'
import { environmentSecrets, mcpContainsSecret } from './agentMcpPrivacy'
import { assertAgentMcpPrivacy, agentDecisionPrivacyRevision } from './agentDecisionPrivacy'
import { isAgentPersistencePaused } from './agentPersistenceLifecycle'

// Resolve installed/packaged dependencies relative to this module in either Electron CJS or test ESM.
const requireSdk = createRequire(typeof __filename !== 'undefined' ? __filename : import.meta.url)
export const validateAgentMcpSchema: McpSchemaValidator = (schema) => {
  const { AjvJsonSchemaValidator } = requireSdk(
    '@modelcontextprotocol/client/validators/ajv'
  ) as typeof import('@modelcontextprotocol/client/validators/ajv')
  const validate = new AjvJsonSchemaValidator().getValidator(schema as JsonSchemaType)
  return (arguments_) => {
    if (!validate(arguments_).valid)
      throw new Error('MCP arguments do not match the captured schema')
  }
}
export interface AgentMcpInvocationOutcome {
  readonly result: ToolResult
  readonly outcome: 'not-sent' | 'confirmed' | 'unknown'
  readonly requestSent: boolean
  readonly unknownOutcome: boolean
  readonly doNotRetry: boolean
  readonly checkpointUnconfirmed?: boolean
}
export interface AgentMcpInvocationHooks {
  /** Awaited durable intent at the actual send boundary; failure guarantees no operation send. */
  beforeSend(): Promise<void>
  /** Always awaited, even for cancellation or rejected intent. */
  settle(outcome: AgentMcpInvocationOutcome): Promise<void>
}
export interface AgentMcpServiceOptions {
  readonly store: McpConfigStore
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly secrets?: () => readonly string[]
  readonly assertAllowed?: (value: unknown) => void
  readonly privacyRevision?: () => number | string
  readonly validateSchema?: McpSchemaValidator
  /** Trusted wiring only. The factory must not start a process. Never exposed through IPC. */
  readonly transportFactory?: (launch: McpLaunchIdentity) => Transport | Promise<Transport>
  readonly now?: () => number
}
interface LaunchPermit {
  readonly preparation: AgentMcpLaunchPreparation
  readonly launch: McpLaunchIdentity
  readonly privacyRevision: number | string
  readonly controller: AbortController
  starting: boolean
}
interface PendingOperation {
  readonly operation: McpPreparedOperation
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly hooks: AgentMcpInvocationHooks
  readonly privacyRevision: number | string
  phase: 'ready' | 'checking' | 'consumed'
  requestSent: boolean
  requestId?: string | number
  boundary?: Promise<void>
  confirmedError?: boolean
}
interface Connection {
  readonly client: Client
  readonly transport: Transport
  /** Strict host cleanup authority; SDK-facing close only observes detached failures. */
  readonly closeOwned: () => Promise<void>
  readonly controller: AbortController
  readonly generation: string
  readonly launch: McpLaunchIdentity
  catalogGeneration: number
  snapshot?: McpCatalogSnapshot
  state: 'connecting' | 'connected' | 'error'
  message?: string
  refresh?: Promise<void>
  pending?: PendingOperation
  cleanupPending: boolean
}
const kinds: readonly McpCatalogKind[] = ['tools', 'resources', 'resourceTemplates']
const methods = {
  tools: 'tools/list',
  resources: 'resources/list',
  resourceTemplates: 'resources/templates/list'
} as const
const noSignal = (): AbortSignal => new AbortController().signal
const LAUNCH_LIFETIME_MS = 120000
class ConfigurationLoadError extends Error {}
class ControlCancelledError extends Error {}
export const AGENT_MCP_START_WARNING =
  'Starting this trusted server runs its installed code with your OS permissions, before any tool-call approval. It can access your files and network. This is not a sandbox. Startup performs the protocol handshake and discovers tool metadata. Ready tool metadata is advertised to the selected model; discovered resource metadata can also be listed in its context. Every tool call and resource read requires separate human approval; returned text enters the local transcript and selected provider context.'
export function agentMcpStartDisclosure(launch: McpLaunchIdentity): string {
  const disclosure = `${AGENT_MCP_START_WARNING}\nServer: ${launch.server.id} · ${mcpDisplayJson(launch.server.label)}\nExecutable: ${mcpDisplayJson(launch.server.executable)}\nArguments: ${launch.server.args.map(mcpDisplayJson).join(' ') || '(none)'}\nWorking directory: ${mcpDisplayJson(launch.server.cwd)}\nProtocol: ${launch.server.protocol}\nEnvironment: ${
    Object.entries(launch.environment)
      .map(([name, value]) => `${name}=${mcpDisplayJson(value)}`)
      .join(', ') || '(empty)'
  }\nApproval applies only to this exact launch. Configuration, executable, working directory, environment or privacy changes require fresh approval. Trusted code can escape process ownership; disconnect is neither a sandbox nor an undo.`
  if (Buffer.byteLength(disclosure) > 48 * 1024)
    throw new Error('MCP launch disclosure exceeds its limit')
  return disclosure
}
export function agentMcpOperationDisclosure(operation: McpPreparedOperation): string {
  const disclosure = `${operation.catalogKind === 'tools' ? 'Call MCP tool' : 'Read MCP resource'} on trusted server ${mcpDisplayJson(operation.serverId)}.\nThis sends the exact request below to that server. Effects cannot be verified from metadata; read-only annotations are not authority. Resource fetches, including file URIs, are server operations.\nBounded returned text and structured data is untrusted and enters the local transcript and selected provider context. Binary data and linked resources are never fetched. Approval permits one attempt. Cancellation cannot undo effects, and uncertain outcomes are never retried automatically.\nExact ${operation.catalogKind === 'tools' ? 'tool name' : 'resource URI'}: ${mcpDisplayJson(operation.remoteKey)}\nArguments: ${mcpDisplayJson(operation.call.arguments)}\nCatalog descriptor (untrusted): ${mcpDisplayJson(operation.descriptor)}\nBinding: ${mcpDisplayJson(operation.binding)}`
  if (Buffer.byteLength(disclosure) > 96 * 1024)
    throw new Error('MCP operation disclosure exceeds its limit')
  return disclosure
}
/** Explicit startup and one-shot reviewed invocation; no autoconnection, retries or input fulfillment. */
export class AgentMcpService {
  private configuration: McpConfiguration = mcpFreeze({ revision: '', servers: [] })
  private readonly connections = new Map<string, Connection>()
  private readonly launches = new Map<string, LaunchPermit>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controls = new Set<AbortController>()
  private readonly prepared = new WeakMap<
    McpPreparedOperation,
    { privacyRevision: number | string; attempted: boolean }
  >()
  private readonly listeners = new Set<(status: AgentMcpStatus) => void>()
  private configurationChain: Promise<unknown> = Promise.resolve()
  private launchPreparationGeneration = 0
  private paused = false
  private closed = false
  readonly validateSchema: McpSchemaValidator
  readonly operationDisclosure = agentMcpOperationDisclosure
  constructor(private readonly options: AgentMcpServiceOptions) {
    this.validateSchema = options.validateSchema ?? validateAgentMcpSchema
  }
  readonly assertAllowed = (value: unknown): void => {
    assertMcpJson(value, 8 * 1024 * 1024, { nodes: 8 * 1024 * 1024, depth: 64 })
    if (mcpContainsSecret(value, this.secrets()))
      throw new Error('MCP content contains a known credential')
    const returned = (this.options.assertAllowed ?? assertAgentMcpPrivacy)(value)
    if (returned !== undefined) throw new Error('MCP privacy assertion must complete synchronously')
  }
  private secrets(): readonly string[] {
    const values = [
      ...environmentSecrets(this.options.env),
      ...(this.options.secrets?.() ?? [])
    ].filter(Boolean)
    this.options.store.addSecrets(values)
    return values
  }
  private privacyRevision(): number | string {
    return this.options.privacyRevision?.() ?? agentDecisionPrivacyRevision()
  }
  private assertOpen(): void {
    if (this.closed || this.paused || isAgentPersistencePaused())
      throw new ControlCancelledError('Agent MCP controls are paused or closed')
  }
  private control<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal = noSignal()
  ): Promise<T> {
    try {
      this.assertOpen()
      signal.throwIfAborted()
    } catch (error) {
      return Promise.reject(error)
    }
    const controller = new AbortController(),
      combined = AbortSignal.any([signal, controller.signal])
    this.controls.add(controller)
    const task = Promise.resolve()
      .then(() => {
        combined.throwIfAborted()
        return operation(combined)
      })
      .catch((error) => {
        if (combined.aborted && error === combined.reason)
          throw new ControlCancelledError('Agent MCP control cancelled')
        throw error
      })
    this.operations.add(task)
    void task.then(
      () => {
        this.operations.delete(task)
        this.controls.delete(controller)
      },
      () => {
        this.operations.delete(task)
        this.controls.delete(controller)
      }
    )
    return task
  }
  onStatusChanged(listener: (status: AgentMcpStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private notify(): void {
    const status = this.statuses()
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch {
        /* UI cannot alter ownership. */
      }
    }
  }
  private statuses(): AgentMcpStatus {
    const servers: AgentMcpServerStatus[] = this.configuration.servers.map((server) => {
      const connection = this.connections.get(server.id),
        snapshot = connection?.snapshot
      const category = (kind: McpCatalogKind): AgentMcpCategoryStatus => {
        const source = snapshot!.categories[kind]
        const entries = source.entries.map((entry) => {
          try {
            this.assertAllowed(entry)
            return {
              remoteKey: entry.remoteKey,
              alias: entry.alias,
              state: entry.state,
              descriptorJson: mcpDisplayJson(entry.descriptor),
              ...(entry.reason ? { reason: entry.reason } : {})
            }
          } catch {
            return {
              remoteKey: '(withheld)',
              alias: '(withheld)',
              state: 'quarantined' as const,
              reason: 'Metadata withheld by credential privacy policy'
            }
          }
        })
        return {
          state: source.state,
          count: entries.length,
          available: entries.filter((entry) => entry.state === 'available').length,
          entries,
          ...(source.reason ? { reason: source.reason } : {})
        }
      }
      return {
        server,
        state: connection?.state ?? 'disabled',
        cleanupPending: connection?.cleanupPending ?? false,
        ...(connection?.message ? { message: connection.message } : {}),
        ...(snapshot
          ? {
              catalog: {
                generation: snapshot.catalogGeneration,
                tools: category('tools'),
                resources: category('resources'),
                resourceTemplates: category('resourceTemplates')
              }
            }
          : {})
      }
    })
    return mcpFreeze({
      revision: this.configuration.revision,
      servers,
      environmentNames: [...MCP_ENV_NAMES],
      paused: this.closed || this.paused || isAgentPersistencePaused()
    })
  }
  cancelPendingLaunches(): void {
    this.cancelPreparedLaunches()
  }
  private pruneExpiredLaunches(): void {
    const now = this.options.now?.() ?? Date.now()
    for (const [token, permit] of this.launches)
      if (!permit.starting && now >= permit.preparation.expiresAt) {
        permit.controller.abort()
        this.launches.delete(token)
      }
  }
  private cancelPreparedLaunches(): void {
    this.launchPreparationGeneration++
    for (const [token, permit] of this.launches) {
      permit.controller.abort()
      if (!permit.starting) this.launches.delete(token)
    }
  }
  private invalidate(connection: Connection, message: string): void {
    connection.state = 'error'
    connection.message = message
    connection.catalogGeneration++
    delete connection.snapshot
    connection.controller.abort()
  }
  private async cleanup(id: string, connection: Connection, remove = true): Promise<void> {
    try {
      await connection.closeOwned()
      connection.cleanupPending = false
      if (remove && this.connections.get(id) === connection) this.connections.delete(id)
    } catch {
      connection.cleanupPending = true
      connection.message = `${connection.message ?? 'MCP disconnected'}; owned process cleanup remains unverified`
      throw new Error(
        'MCP owned process cleanup could not be verified; retry disconnect before launching again'
      )
    }
  }
  private async revokeConnections(): Promise<void> {
    this.cancelPreparedLaunches()
    const outcomes = await Promise.allSettled(
      [...this.connections].map(async ([id, connection]) => {
        this.invalidate(connection, 'MCP configuration changed or is unavailable')
        await this.cleanup(id, connection)
      })
    )
    this.notify()
    if (outcomes.some((result) => result.status === 'rejected'))
      throw new ConfigurationLoadError(
        'MCP configuration is unavailable and owned process cleanup could not be verified'
      )
  }
  private async loadConfiguration(): Promise<McpConfiguration> {
    this.secrets()
    try {
      const loaded = await this.options.store.load()
      this.assertAllowed(loaded)
      return loaded
    } catch {
      await this.revokeConnections()
      throw new ConfigurationLoadError(
        'MCP configuration is unavailable or invalid; server connections are disabled'
      )
    }
  }
  private async reload(): Promise<void> {
    const current = await this.loadConfiguration()
    if (this.configuration.revision && current.revision !== this.configuration.revision)
      await this.revokeConnections()
    this.configuration = current
  }
  list(signal = noSignal()): Promise<AgentMcpStatus> {
    if (this.closed || this.paused || isAgentPersistencePaused())
      return Promise.resolve(this.statuses())
    return this.control(async (current) => {
      await this.reload()
      current.throwIfAborted()
      return this.statuses()
    }, signal)
  }
  private configureAdmitted(
    operation: (signal: AbortSignal) => Promise<void>,
    signal: AbortSignal
  ): Promise<AgentMcpStatus> {
    return this.control(async (current) => {
      const task = this.configurationChain
        .catch(() => undefined)
        .then(async () => {
          current.throwIfAborted()
          await this.reload()
          current.throwIfAborted()
          this.assertOpen()
          try {
            await operation(current)
            await this.reload()
            return this.statuses()
          } finally {
            this.notify()
          }
        })
      this.configurationChain = task
      return task
    }, signal)
  }
  configure(server: McpServerConfig, signal = noSignal()): Promise<AgentMcpStatus> {
    let captured: McpServerConfig
    try {
      captured = validateMcpServer(server, this.secrets())
      this.assertAllowed(captured)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.configureAdmitted(async (current) => {
      this.assertAllowed(captured)
      await this.revokeConnections()
      current.throwIfAborted()
      this.assertOpen()
      await this.options.store.save(
        [...this.configuration.servers.filter((value) => value.id !== captured.id), captured],
        this.configuration.revision
      )
    }, signal)
  }
  remove(id: string, signal = noSignal()): Promise<AgentMcpStatus> {
    return this.configureAdmitted(async (current) => {
      if (typeof id !== 'string') throw new Error('Invalid MCP server ID')
      await this.revokeConnections()
      current.throwIfAborted()
      this.assertOpen()
      await this.options.store.save(
        this.configuration.servers.filter((server) => server.id !== id),
        this.configuration.revision
      )
    }, signal)
  }
  prepareLaunch(id: string, signal = noSignal()): Promise<AgentMcpLaunchPreparation> {
    // Capture synchronously: a renderer reload can revoke this request before its queued control runs.
    const generation = this.launchPreparationGeneration
    return this.control(async (current) => {
      await this.reload()
      current.throwIfAborted()
      this.assertPreparationCurrent(generation)
      this.options.store.assertLaunchable()
      const server = this.configuration.servers.find((value) => value.id === id)
      if (!server) throw new Error('MCP server is no longer configured')
      this.pruneExpiredLaunches()
      if (
        this.connections.has(id) ||
        [...this.launches.values()].some((value) => value.launch.server.id === id)
      )
        throw new Error('Cancel or disconnect the current launch before preparing a replacement')
      if (this.launches.size >= 8) throw new Error('Too many pending MCP launches')
      const privacyRevision = this.privacyRevision()
      const launch = await prepareMcpLaunch(
        server,
        this.configuration.revision,
        this.options.env,
        this.secrets()
      )
      current.throwIfAborted()
      this.assertOpen()
      this.assertPreparationCurrent(generation)
      this.assertAllowed(launch)
      if (privacyRevision !== this.privacyRevision())
        throw new Error('MCP privacy changed; prepare launch again')
      const preparation = mcpFreeze({
        token: randomUUID(),
        serverId: id,
        disclosure: agentMcpStartDisclosure(launch),
        launchDigest: launch.digest,
        expiresAt: (this.options.now?.() ?? Date.now()) + LAUNCH_LIFETIME_MS
      })
      this.launches.set(preparation.token, {
        preparation,
        launch,
        privacyRevision,
        controller: new AbortController(),
        starting: false
      })
      return preparation
    }, signal)
  }
  private assertPreparationCurrent(generation: number): void {
    if (generation !== this.launchPreparationGeneration)
      throw new ControlCancelledError('MCP launch preparation cancelled')
  }
  cancelLaunch(token: string): void {
    const permit = this.launches.get(token)
    if (permit) {
      permit.controller.abort()
      if (!permit.starting) this.launches.delete(token)
    }
  }
  start(token: string, signal = noSignal()): Promise<AgentMcpStartResult> {
    const permit = this.launches.get(token)
    if (!permit || permit.starting)
      return Promise.reject(new Error('MCP launch approval is unavailable or already consumed'))
    permit.starting = true
    const task = this.control(async (controlSignal) => {
      const current = AbortSignal.any([controlSignal, permit.controller.signal])
      current.throwIfAborted()
      await this.reload()
      this.options.store.assertLaunchable()
      if (
        (this.options.now?.() ?? Date.now()) >= permit.preparation.expiresAt ||
        permit.privacyRevision !== this.privacyRevision() ||
        this.connections.has(permit.launch.server.id)
      )
        throw new Error('MCP launch approval expired or changed; prepare a fresh launch')
      await this.assertLaunchCurrent(permit.launch, current)
      current.throwIfAborted()
      this.assertOpen()
      return {
        started: await this.connect(permit.launch, permit.privacyRevision, current),
        status: this.statuses()
      }
    }, signal)
    void task.then(
      () => {
        this.launches.delete(token)
        this.notify()
      },
      () => {
        this.launches.delete(token)
        this.notify()
      }
    )
    return task
  }
  private async assertLaunchCurrent(launch: McpLaunchIdentity, signal: AbortSignal): Promise<void> {
    const persisted = await this.loadConfiguration()
    if (
      persisted.revision !== launch.configRevision ||
      this.configuration.revision !== launch.configRevision
    )
      throw new Error('MCP configuration changed; request fresh approval')
    const server = persisted.servers.find((value) => value.id === launch.server.id)
    if (!server) throw new Error('MCP server is no longer configured')
    this.options.store.assertLaunchable()
    this.assertAllowed(launch)
    const latest = await prepareMcpLaunch(
      server,
      persisted.revision,
      this.options.env,
      this.secrets()
    )
    if (latest.digest !== launch.digest)
      throw new Error('MCP executable, directory or environment changed; request fresh approval')
    if ((await this.loadConfiguration()).revision !== launch.configRevision)
      throw new Error('MCP configuration changed before send')
    signal.throwIfAborted()
    this.assertOpen()
  }
  private async connect(
    launch: McpLaunchIdentity,
    privacyRevision: number | string,
    signal: AbortSignal
  ): Promise<boolean> {
    const sdk = await import('@modelcontextprotocol/client')
    signal.throwIfAborted()
    this.assertOpen()
    const client = new sdk.Client(
      { name: 'bot-commander-agent-mcp', version: '1.7.0' },
      {
        capabilities: {},
        jsonSchemaValidator: {
          getValidator: <T>(schema: JsonSchemaType) => {
            const { AjvJsonSchemaValidator } = requireSdk(
              '@modelcontextprotocol/client/validators/ajv'
            ) as typeof import('@modelcontextprotocol/client/validators/ajv')
            return new AjvJsonSchemaValidator().getValidator<T>(schema)
          }
        },
        inputRequired: { autoFulfill: false },
        enforceStrictCapabilities: true,
        versionNegotiation: {
          mode: launch.server.protocol === 'legacy' ? 'legacy' : { pin: launch.server.protocol }
        }
      }
    )
    const owned = this.options.transportFactory
      ? await this.options.transportFactory(launch)
      : new (await import('./agentMcpTransport')).McpStdioTransport(launch)
    await this.assertLaunchCurrent(launch, signal)
    signal.throwIfAborted()
    this.assertOpen()
    if (this.connections.has(launch.server.id))
      throw new Error('MCP connection already owns this server ID')
    const closeOwned = async (): Promise<void> => {
      // Also convert a synchronous owned close throw into an observed rejected Promise.
      await owned.close()
    }
    const transport: Transport = {
      start: async () => {
        await this.assertLaunchCurrent(launch, signal)
        signal.throwIfAborted()
        this.assertOpen()
        if (privacyRevision !== this.privacyRevision())
          throw new Error('MCP privacy changed before process startup')
        await owned.start()
      },
      // Pinned SDK legacy handshake failure detaches this close Promise. Only its
      // adapter observes that rejection; all host paths use strict closeOwned below.
      close: () => closeOwned().catch(() => undefined),
      send: async (message, options) => {
        if (
          'method' in message &&
          (('id' in message && connection.pending) ||
            ['tools/call', 'resources/read'].includes(message.method))
        ) {
          const pending = connection.pending
          if (!pending || pending.phase !== 'ready' || !('id' in message))
            throw new Error('MCP request has no unused one-shot approval')
          pending.phase = 'checking'
          assertMcpJson(message, 64 * 1024)
          const captured = mcpFreeze(structuredClone(message))
          const boundary = this.guardSend(connection, pending, captured, sdk, () =>
            owned.send(captured, options)
          )
          pending.boundary = boundary
          await boundary
          return
        }
        await owned.send(message, options)
      }
    }
    const connection: Connection = {
      client,
      transport,
      closeOwned,
      launch,
      controller: new AbortController(),
      generation: randomUUID(),
      catalogGeneration: 0,
      state: 'connecting',
      cleanupPending: false
    }
    owned.onclose = () => transport.onclose?.()
    owned.onerror = (error) => transport.onerror?.(error)
    owned.onmessage = (message: JSONRPCMessage) => {
      const pending = connection.pending
      if (
        pending?.requestSent &&
        'id' in message &&
        message.id === pending.requestId &&
        !('method' in message)
      ) {
        try {
          if ('result' in message)
            assertMcpOperationResult(
              pending.operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read',
              message.result
            )
          else if ('error' in message) {
            assertMcpJson(message.error, MCP_OPERATION_LIMITS.resultBytes)
            if (!Number.isInteger(message.error.code) || typeof message.error.message !== 'string')
              throw new Error('Invalid protocol error')
            pending.confirmedError = true
          } else throw new Error('Missing operation response')
        } catch {
          transport.onmessage?.({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32603, message: 'MCP response is unsupported or exceeded its bounds' }
          })
          return
        }
      }
      transport.onmessage?.(message)
    }
    this.connections.set(launch.server.id, connection)
    const invalidate = (changed: readonly McpCatalogKind[]): void => {
      connection.catalogGeneration++
      if (connection.snapshot)
        connection.snapshot = mcpFreeze({
          ...connection.snapshot,
          catalogGeneration: connection.catalogGeneration,
          categories: Object.fromEntries(
            kinds.map((kind) => {
              const category = connection.snapshot!.categories[kind]
              return [
                kind,
                changed.includes(kind) && ['ready', 'stale'].includes(category.state)
                  ? {
                      ...category,
                      state: 'stale',
                      reason: 'Server catalog changed; refresh metadata before approval'
                    }
                  : category
              ]
            })
          ) as unknown as McpCatalogSnapshot['categories']
        })
      this.notify()
    }
    client.setNotificationHandler('notifications/tools/list_changed', () => invalidate(['tools']))
    client.setNotificationHandler('notifications/resources/list_changed', () =>
      invalidate(['resources', 'resourceTemplates'])
    )
    client.onclose = () => {
      connection.state = 'error'
      connection.message ??= 'MCP connection closed; reconnect requires fresh approval'
      invalidate(kinds)
      connection.controller.abort()
    }
    client.onerror = () => {
      /* Never report raw server diagnostics or stderr. */
    }
    this.notify()
    const combined = AbortSignal.any([
      signal,
      connection.controller.signal,
      AbortSignal.timeout(MCP_LIMITS.categoryMs)
    ])
    const abort = (): void => {
      void connection.closeOwned().catch(() => {
        connection.cleanupPending = true
        this.notify()
      })
    }
    combined.addEventListener('abort', abort, { once: true })
    try {
      await client.connect(transport, {
        signal: combined,
        timeout: MCP_LIMITS.pageMs,
        maxTotalTimeout: MCP_LIMITS.categoryMs
      })
      combined.throwIfAborted()
      await this.reload()
      combined.throwIfAborted()
      if (
        this.connections.get(launch.server.id) !== connection ||
        this.configuration.revision !== launch.configRevision
      )
        throw new Error('MCP connection changed during startup')
      connection.state = 'connected'
      connection.snapshot = mcpFreeze({
        serverId: launch.server.id,
        configRevision: launch.configRevision,
        connectionGeneration: connection.generation,
        protocolVersion: client.getNegotiatedProtocolVersion() ?? 'unknown',
        catalogGeneration: connection.catalogGeneration,
        categories: {
          tools: emptyMcpCategory(),
          resources: emptyMcpCategory(),
          resourceTemplates: emptyMcpCategory()
        }
      })
      await this.refreshConnection(connection, ['tools'], combined)
      this.notify()
      return true
    } catch {
      this.invalidate(
        connection,
        signal.aborted ? 'MCP startup cancelled' : 'MCP startup failed or timed out'
      )
      try {
        await this.cleanup(launch.server.id, connection)
      } finally {
        // Unverified cleanup rejects startup and keeps this connection's ownership.
        this.notify()
      }
      return false
    } finally {
      combined.removeEventListener('abort', abort)
    }
  }
  private checkRun(assertCurrent: () => void): void {
    if (assertCurrent() !== undefined)
      throw new Error('MCP active-run assertion must complete synchronously')
  }
  private async guardSend(
    connection: Connection,
    pending: PendingOperation,
    message: JSONRPCMessage,
    sdk: typeof import('@modelcontextprotocol/client'),
    send: () => Promise<void>
  ): Promise<void> {
    const check = (): void => {
      if (connection.pending !== pending || pending.phase !== 'checking')
        throw new Error('MCP approval changed during SDK send setup')
      pending.signal.throwIfAborted()
      this.assertOpen()
      this.checkRun(pending.assertCurrent)
      if (pending.privacyRevision !== this.privacyRevision())
        throw new Error('MCP privacy changed before send')
      this.assertOperationCurrent(pending.operation)
      this.assertAllowed([pending.operation.call, pending.operation.descriptor])
      const expected: Record<string, unknown> =
        pending.operation.catalogKind === 'tools'
          ? { name: pending.operation.remoteKey, arguments: pending.operation.call.arguments }
          : { uri: pending.operation.remoteKey }
      if (pending.operation.snapshot.protocolVersion === '2026-07-28')
        expected._meta = {
          [sdk.PROTOCOL_VERSION_META_KEY]: pending.operation.snapshot.protocolVersion,
          [sdk.CLIENT_INFO_META_KEY]: { name: 'bot-commander-agent-mcp', version: '1.7.0' },
          [sdk.CLIENT_CAPABILITIES_META_KEY]: {}
        }
      if (
        !('method' in message) ||
        !('id' in message) ||
        message.jsonrpc !== '2.0' ||
        Object.keys(message).some((key) => !['jsonrpc', 'method', 'id', 'params'].includes(key)) ||
        message.method !==
          (pending.operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read') ||
        mcpDigest(message.params) !== mcpDigest(expected)
      )
        throw new Error('MCP outgoing request differs from exact approval')
    }
    await this.reload()
    await this.assertLaunchCurrent(connection.launch, pending.signal)
    check()
    await pending.hooks.beforeSend()
    // Persisted intent is not delivery or send authority. Repeat every mutable check after it.
    await this.reload()
    await this.assertLaunchCurrent(connection.launch, pending.signal)
    check()
    if (!('id' in message)) throw new Error('MCP operation requires an exact request ID')
    // No await separates the final checks, one-shot consumption and possible server write.
    pending.phase = 'consumed'
    pending.requestSent = true
    pending.requestId = message.id
    await send()
  }
  refresh(
    id: string,
    selected: readonly McpCatalogKind[],
    signal = noSignal()
  ): Promise<AgentMcpStatus> {
    return this.control(async (current) => {
      try {
        await this.reload()
        current.throwIfAborted()
        const connection = this.connections.get(id)
        if (!connection || connection.state !== 'connected' || !connection.snapshot)
          throw new Error('Start this MCP server explicitly before metadata discovery')
        await this.refreshConnection(connection, selected, current)
        return this.statuses()
      } finally {
        this.notify()
      }
    }, signal)
  }
  private async refreshConnection(
    connection: Connection,
    selected: readonly McpCatalogKind[],
    signal: AbortSignal
  ): Promise<void> {
    if (
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > 3 ||
      new Set(selected).size !== selected.length ||
      selected.some((kind) => !kinds.includes(kind))
    )
      throw new Error('Unsupported MCP catalog selection')
    if (connection.refresh) throw new Error('MCP metadata refresh is already running')
    if (connection.pending) throw new Error('MCP operation is in flight; refresh after it settles')
    const task = this.collect(connection, [...selected], signal)
    connection.refresh = task
    try {
      await task
    } finally {
      if (connection.refresh === task) delete connection.refresh
    }
  }
  private async collect(
    connection: Connection,
    selected: readonly McpCatalogKind[],
    signal: AbortSignal
  ): Promise<void> {
    const snapshot = connection.snapshot!,
      generation = connection.catalogGeneration,
      categories = { ...snapshot.categories }
    const capabilities = connection.client.getServerCapabilities()
    for (const kind of selected) {
      signal.throwIfAborted()
      if (!(kind === 'tools' ? capabilities?.tools : capabilities?.resources)) {
        categories[kind] = emptyMcpCategory('unsupported')
        continue
      }
      const combined = AbortSignal.any([
        signal,
        connection.controller.signal,
        AbortSignal.timeout(MCP_LIMITS.categoryMs)
      ])
      try {
        const category = await collectMcpCategory(
          snapshot.serverId,
          kind,
          (cursor, pageSignal) =>
            connection.client.request(
              { method: methods[kind], params: cursor === undefined ? {} : { cursor } },
              {
                signal: pageSignal,
                timeout: MCP_LIMITS.pageMs,
                maxTotalTimeout: MCP_LIMITS.categoryMs
              }
            ),
          combined,
          this.validateSchema
        )
        combined.throwIfAborted()
        await this.reload()
        combined.throwIfAborted()
        if (
          connection.catalogGeneration !== generation ||
          this.configuration.revision !== snapshot.configRevision ||
          connection.state !== 'connected'
        )
          throw new Error('MCP catalog changed during discovery')
        const entries = category.entries.map((entry) => {
          try {
            this.assertAllowed(entry)
            return entry
          } catch {
            return {
              ...entry,
              state: 'quarantined' as const,
              reason: 'Metadata withheld by credential privacy policy'
            }
          }
        })
        categories[kind] = mcpFreeze({ ...category, entries, digest: mcpDigest(entries) })
      } catch (error) {
        if (error instanceof ConfigurationLoadError) throw error
        const previous = categories[kind]
        categories[kind] = mcpFreeze({
          ...previous,
          state: previous.entries.length ? 'stale' : 'error',
          reason: combined.aborted
            ? 'Metadata discovery cancelled or timed out'
            : 'Metadata discovery failed, changed or exceeded its bounds'
        })
      }
    }
    if (
      connection.catalogGeneration !== generation ||
      this.configuration.revision !== snapshot.configRevision ||
      connection.state !== 'connected'
    )
      return
    if (
      kinds.reduce(
        (bytes, kind) => bytes + Buffer.byteLength(JSON.stringify(categories[kind].entries)),
        0
      ) > MCP_LIMITS.bytes
    ) {
      for (const kind of selected)
        categories[kind] = mcpFreeze({
          ...snapshot.categories[kind],
          state: 'error',
          reason: 'Combined catalog byte limit exceeded'
        })
    }
    connection.catalogGeneration++
    connection.snapshot = mcpFreeze({
      ...snapshot,
      catalogGeneration: connection.catalogGeneration,
      categories
    })
  }
  captureCatalogs(signal: AbortSignal): Promise<readonly McpCatalogSnapshot[]> {
    return this.control(async (current) => {
      await this.reload()
      current.throwIfAborted()
      this.assertOpen()
      return mcpFreeze(
        [...this.connections.values()]
          .filter((connection) => connection.state === 'connected' && connection.snapshot)
          .map((connection) => {
            this.assertAllowed(connection.snapshot!)
            return connection.snapshot!
          })
      )
    }, signal)
  }
  prepareOperation(
    snapshot: McpCatalogSnapshot,
    entry: McpCatalogEntry,
    kind: 'tools' | 'resources',
    call: ToolCall
  ): McpPreparedOperation {
    this.assertOpen()
    const connection = this.connections.get(snapshot.serverId)
    const operation = prepareMcpOperation(
      snapshot,
      entry,
      kind,
      call,
      connection?.launch.digest ?? '',
      this.validateSchema
    )
    this.assertOperationCurrent(operation)
    this.assertAllowed([operation.call, operation.descriptor])
    this.prepared.set(operation, { privacyRevision: this.privacyRevision(), attempted: false })
    return operation
  }
  operationRevisions(operation: McpPreparedOperation): JsonObject {
    const connection = this.connections.get(operation.serverId)
    return mcpOperationRevisions(
      operation,
      connection?.snapshot,
      connection?.launch.digest ?? '',
      connection?.state === 'connected' &&
        !connection.controller.signal.aborted &&
        !this.closed &&
        !this.paused &&
        !isAgentPersistencePaused(),
      this.configuration.revision
    )
  }
  private assertOperationCurrent(operation: McpPreparedOperation): void {
    this.assertOpen()
    const connection = this.connections.get(operation.serverId)
    assertMcpOperationCurrent(
      operation,
      connection?.snapshot,
      connection?.launch.digest ?? '',
      connection?.state === 'connected' && !connection.controller.signal.aborted,
      this.configuration.revision
    )
  }
  invoke(
    operation: McpPreparedOperation,
    signal: AbortSignal,
    assertCurrent: () => void,
    hooks: AgentMcpInvocationHooks
  ): Promise<AgentMcpInvocationOutcome> {
    const task = this.invokeAdmitted(operation, signal, assertCurrent, hooks)
    this.operations.add(task)
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task)
    )
    return task
  }
  private async invokeAdmitted(
    operation: McpPreparedOperation,
    signal: AbortSignal,
    assertCurrent: () => void,
    hooks: AgentMcpInvocationHooks
  ): Promise<AgentMcpInvocationOutcome> {
    let pending: PendingOperation | undefined,
      connection: Connection | undefined,
      outcome: AgentMcpInvocationOutcome
    const controller = new AbortController()
    this.controls.add(controller)
    try {
      this.assertOpen()
      signal.throwIfAborted()
      if (typeof hooks?.beforeSend !== 'function' || typeof hooks?.settle !== 'function')
        throw new Error('MCP durable invocation hooks are required')
      await this.reload()
      signal.throwIfAborted()
      this.checkRun(assertCurrent)
      const authority = this.prepared.get(operation)
      if (!authority || authority.attempted || authority.privacyRevision !== this.privacyRevision())
        throw new Error('MCP one-shot approval is unavailable')
      authority.attempted = true
      this.assertOperationCurrent(operation)
      this.assertAllowed([operation.call, operation.descriptor])
      connection = this.connections.get(operation.serverId)!
      if (connection.pending) throw new Error('MCP server already has an operation in flight')
      const combined = AbortSignal.any([
        signal,
        controller.signal,
        connection.controller.signal,
        AbortSignal.timeout(MCP_OPERATION_LIMITS.operationMs)
      ])
      pending = {
        operation,
        signal: combined,
        assertCurrent,
        hooks,
        privacyRevision: authority.privacyRevision,
        phase: 'ready',
        requestSent: false
      }
      connection.pending = pending
      const options = {
        signal: combined,
        timeout: MCP_OPERATION_LIMITS.operationMs,
        maxTotalTimeout: MCP_OPERATION_LIMITS.operationMs
      }
      const result =
        operation.catalogKind === 'tools'
          ? await connection.client.callTool(
              { name: operation.remoteKey, arguments: operation.call.arguments },
              { ...options, toolDefinition: operation.descriptor as unknown as Tool }
            )
          : await connection.client.readResource(
              { uri: operation.remoteKey },
              { ...options, cacheMode: 'bypass' }
            )
      combined.throwIfAborted()
      this.checkRun(assertCurrent)
      this.assertOperationCurrent(operation)
      await this.reload()
      combined.throwIfAborted()
      this.checkRun(assertCurrent)
      this.assertOperationCurrent(operation)
      const sharedProjection = projectMcpResult(
        operation.serverId,
        operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read',
        operation.remoteKey,
        result,
        this.assertAllowed
      )
      const projected = this.resultWithSafety(sharedProjection, true, false, false)
      this.assertAllowed(JSON.parse(projected.content))
      outcome = {
        result: projected,
        outcome: 'confirmed',
        requestSent: true,
        unknownOutcome: false,
        doNotRetry: false
      }
    } catch {
      // An SDK cancellation/deadline may settle while its asynchronous boundary still persists intent.
      // Wait for that boundary before any terminal checkpoint, so intent cannot land behind outcome.
      await pending?.boundary?.catch(() => undefined)
      if (pending?.requestSent && connection) {
        let confirmedError: ToolResult | undefined
        if (pending.confirmedError) {
          try {
            confirmedError = this.projectProtocolError(operation)
          } catch {
            /* Withhold identities rejected by new privacy. */
          }
        }
        if (confirmedError)
          outcome = {
            result: confirmedError,
            outcome: 'confirmed',
            requestSent: true,
            unknownOutcome: false,
            doNotRetry: true
          }
        else {
          this.invalidate(
            connection,
            'MCP operation outcome is unconfirmed; do not retry automatically. Disconnect before a fresh launch'
          )
          try {
            await this.cleanup(operation.serverId, connection, false)
          } catch {
            /* Retain failed cleanup ownership. */
          }
          outcome = {
            result: this.resultWithSafety(
              mcpFailure(
                'mcp_unknown_outcome',
                'The MCP request may have reached the server, but its outcome could not be confirmed. Do not retry automatically; inspect the external resource before reconnecting',
                true
              ),
              true,
              true,
              true
            ),
            outcome: 'unknown',
            requestSent: true,
            unknownOutcome: true,
            doNotRetry: true
          }
        }
      } else
        outcome = {
          result: this.resultWithSafety(
            mcpFailure(
              signal.aborted || controller.signal.aborted ? 'cancelled' : 'mcp_unavailable',
              'MCP request was not sent: approval, catalog, configuration, launch, privacy or active run became unavailable'
            ),
            false,
            false,
            false
          ),
          outcome: 'not-sent',
          requestSent: false,
          unknownOutcome: false,
          doNotRetry: false
        }
    } finally {
      if (connection && connection.pending === pending) delete connection.pending
      this.controls.delete(controller)
    }
    try {
      await hooks.settle(outcome)
    } catch {
      outcome = {
        ...outcome,
        result: this.resultWithSafety(
          outcome.result,
          outcome.requestSent,
          outcome.unknownOutcome,
          outcome.doNotRetry,
          true
        ),
        checkpointUnconfirmed: true
      }
    }
    this.notify()
    return mcpFreeze(outcome)
  }
  private resultWithSafety(
    result: ToolResult,
    requestSent: boolean,
    unknownOutcome: boolean,
    doNotRetry: boolean,
    checkpointUnconfirmed = false
  ): ToolResult {
    const body = {
      ...JSON.parse(result.content),
      requestSent,
      unknownOutcome,
      doNotRetry,
      ...(checkpointUnconfirmed ? { checkpointUnconfirmed: true } : {})
    }
    assertMcpJson({ ...body, checkpointUnconfirmed: true }, MCP_OPERATION_LIMITS.resultBytes)
    return {
      content: JSON.stringify(body),
      ...(result.isError !== undefined ? { isError: result.isError } : {})
    }
  }
  private projectProtocolError(operation: McpPreparedOperation): ToolResult {
    const method = operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read'
    const projected = projectMcpResult(
      operation.serverId,
      method,
      operation.remoteKey,
      method === 'tools/call' ? { isError: true, content: [] } : { isError: true, contents: [] },
      this.assertAllowed
    )
    const body = {
      ...JSON.parse(projected.content),
      doNotRetry: true,
      error: {
        code: 'mcp_protocol_error',
        message:
          'The MCP server returned a protocol error. Its effects were not verified; do not retry automatically.'
      }
    }
    assertMcpJson(body, MCP_OPERATION_LIMITS.resultBytes)
    this.assertAllowed(body)
    return this.resultWithSafety(
      { content: JSON.stringify(body), isError: true },
      true,
      false,
      true
    )
  }
  disconnect(id: string): Promise<AgentMcpStatus> {
    const task = (async () => {
      try {
        for (const [token, permit] of this.launches)
          if (permit.launch.server.id === id) this.cancelLaunch(token)
        const connection = this.connections.get(id)
        if (connection) {
          this.invalidate(connection, 'MCP disconnected')
          await this.cleanup(id, connection)
          await connection.refresh?.catch(() => undefined)
        }
        return this.statuses()
      } finally {
        this.notify()
      }
    })()
    this.operations.add(task)
    void task.then(
      () => this.operations.delete(task),
      () => this.operations.delete(task)
    )
    return task
  }
  pause(): void {
    this.paused = true
    for (const controller of this.controls) controller.abort()
    this.cancelPreparedLaunches()
    this.notify()
  }
  resume(): void {
    this.closed = false
    this.paused = false
    this.notify()
  }
  async drain(): Promise<void> {
    const errors: unknown[] = []
    while (this.operations.size) {
      const results = await Promise.allSettled([...this.operations])
      for (const result of results)
        if (
          result.status === 'rejected' &&
          !(result.reason instanceof ControlCancelledError) &&
          !(result.reason instanceof Error && result.reason.name === 'AbortError')
        )
          errors.push(result.reason)
    }
    if (errors.length) throw new AggregateError(errors, 'Agent MCP controls did not drain cleanly')
  }
  async close(): Promise<void> {
    this.closed = true
    this.pause()
    const results = await Promise.allSettled(
      [...this.connections.keys()].map((id) => this.disconnect(id))
    )
    await this.drain()
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('Agent MCP process cleanup remains unverified')
  }
}
let singleton: AgentMcpService | undefined
function currentService(): AgentMcpService {
  singleton ??= new AgentMcpService({
    store: new McpConfigStore(join(app.getPath('userData'), 'agent-mcp')),
    env: process.env,
    assertAllowed: assertAgentMcpPrivacy
  })
  return singleton
}
/** Importing this module never reads app state or starts a server. */
export const agentMcpService = new Proxy({} as AgentMcpService, {
  get(_target, key) {
    const service = currentService(),
      value = Reflect.get(service, key)
    return typeof value === 'function' ? value.bind(service) : value
  }
})
