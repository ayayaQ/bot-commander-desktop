// SPDX-License-Identifier: Apache-2.0
// Session ownership and reviews adapted from licensed vivi-cli src/mcp-oauth-controls.ts.
import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import type { FetchLike } from '@modelcontextprotocol/client'
import { mcpDisplayJson, assertMcpJson } from '@ayayaq/vivi/extensions/mcp'
import type {
  AgentMcpHttpServerConfig,
  AgentMcpLaunchPreparation,
  AgentMcpStatus
} from '../../shared/agentMcpTypes'
import type {
  AgentMcpOAuthPublicClient,
  AgentMcpOAuthRegistrationSettings,
  AgentMcpOAuthReview,
  AgentMcpOAuthSignInResult,
  AgentMcpOAuthStatus
} from '../../shared/agentMcpOAuthTypes'
import { McpOAuthError, validateMcpOAuthRedirectPath } from './agentMcpOAuthCallback'
import { McpOAuthSession, type McpOAuthSignInPlan } from './agentMcpOAuthSession'
import { McpOAuthRegistration, type McpOAuthRegistrationPlan } from './agentMcpOAuthRegistration'

export type AgentMcpAuthorizationLifecycle =
  | 'configuration'
  | 'disconnect'
  | 'closed'
  | 'paused'
  | 'resumed'
  | 'navigation'
  | 'needs-sign-in'
  | 'launch-cancelled'
  | 'connection-failed'
  | 'connected'

/** Trusted main-only interface. None of these hooks is an IPC credential path. */
export interface AgentMcpOAuthOwner {
  list(signal?: AbortSignal): Promise<AgentMcpStatus>
  authorizationContext(): {
    readonly revision: string
    readonly servers: readonly AgentMcpHttpServerConfig[]
    readonly paused: boolean
  }
  disconnect(id: string): Promise<AgentMcpStatus>
  disconnectForAuthorization(id: string): Promise<AgentMcpStatus>
  prepareLaunch(id: string, signal?: AbortSignal): Promise<AgentMcpLaunchPreparation>
  cancelLaunch(token: string): void
  addSecrets(values: readonly string[]): void
  assertAllowed(value: unknown): void
  notifyAuthorizationChanged(): void
}
export interface AgentMcpOAuthServiceOptions {
  readonly fetchFn?: FetchLike
  readonly openBrowser?: (url: URL, signal: AbortSignal) => Promise<void>
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly reviewLifetimeMs?: number
}
interface ClientEntry {
  readonly client: AgentMcpOAuthPublicClient
  readonly endpoint: string
  readonly configRevision: string
  revision: string
  state: 'configured' | 'cancelled' | 'failed' | 'needs-sign-in'
  message?: string
  session?: McpOAuthSession
  connectionReview?: string
  connectionTimer?: ReturnType<typeof setTimeout>
}
interface Attempt {
  readonly serverId: string
  readonly revision: string
  readonly abort: AbortController
  running: boolean
  consumed: boolean
  endpoint?: string
  configRevision?: string
  entry?: ClientEntry
  registration?: McpOAuthRegistration
  registrationPlan?: McpOAuthRegistrationPlan
  session?: McpOAuthSession
  signInPlan?: McpOAuthSignInPlan
  review?: AgentMcpOAuthReview
  timer?: ReturnType<typeof setTimeout>
}
const CLIENT_KEYS = ['id', 'issuer', 'redirectPort', 'redirectPath', 'scopes']
const REGISTRATION_KEYS = ['issuer', 'redirectPort', 'redirectPath', 'scopes', 'clientName']
function exactPublicObject(value: unknown, keys: readonly string[]): void {
  assertMcpJson(value, 16 * 1024)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new McpOAuthError('authorization-failed')
}
/** Consent-specific copy only; the protocol policy has no provider exception. */
function providerConsentDisclosure(issuer: string): string {
  return issuer === 'https://mcp.openrouter.ai'
    ? ' OpenRouter says consent creates a dedicated API key with seven-day expiry and an editable default $10 spending cap. Inspect the current consent and limits yourself before granting access. A spending cap does not authorize paid inference.'
    : ''
}
async function openAuthorizationBrowser(url: URL, signal: AbortSignal): Promise<void> {
  if (signal.aborted || url.protocol !== 'https:' || url.username || url.password)
    throw new McpOAuthError('cancelled')
  // The URL stays in privileged main; renderer receives only origin/path in its public review.
  await shell.openExternal(url.href)
  if (signal.aborted) throw new McpOAuthError('cancelled')
}

/** Explicit public-client reviews and session-only authority. No persistence or automatic grants. */
export class AgentMcpOAuthService {
  private owner_: AgentMcpOAuthOwner | undefined
  private readonly clients = new Map<string, ClientEntry>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly anonymousRevision = randomUUID()
  private closed = false
  private readonly lifetime: number
  constructor(private readonly options: AgentMcpOAuthServiceOptions = {}) {
    this.lifetime = options.reviewLifetimeMs ?? 120_000
    if (!Number.isFinite(this.lifetime) || this.lifetime < 1 || this.lifetime > 600_000)
      throw new McpOAuthError('invalid-plan')
  }
  bind(owner: AgentMcpOAuthOwner): void {
    if (this.owner_ || this.closed) throw new McpOAuthError('invalid-plan')
    this.owner_ = owner
  }
  private owner(): AgentMcpOAuthOwner {
    if (!this.owner_ || this.closed) throw new McpOAuthError('cancelled')
    return this.owner_
  }
  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private notify(): void {
    this.owner_?.notifyAuthorizationChanged()
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task)
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task)
    )
    return task
  }
  private claim(serverId: string): Attempt {
    this.owner()
    if (
      typeof serverId !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,15}$/.test(serverId) ||
      this.attempts.has(serverId) ||
      this.attempts.size >= 8
    )
      throw new McpOAuthError('invalid-plan')
    const attempt: Attempt = {
      serverId,
      revision: randomUUID(),
      abort: new AbortController(),
      running: true,
      consumed: false
    }
    this.attempts.set(serverId, attempt)
    return attempt
  }
  private current(attempt: Attempt): boolean {
    const status = this.owner_?.authorizationContext()
    const server = status?.servers.find((server) => server.id === attempt.serverId)
    return (
      !this.closed &&
      !attempt.abort.signal.aborted &&
      this.attempts.get(attempt.serverId) === attempt &&
      !!status &&
      !status.paused &&
      (attempt.configRevision === undefined ||
        (status.revision === attempt.configRevision &&
          server?.transport === 'http' &&
          server.endpoint === attempt.endpoint &&
          this.clients.get(attempt.serverId) === attempt.entry))
    )
  }
  private assertCurrent(attempt: Attempt): void {
    if (!this.current(attempt)) throw new McpOAuthError('cancelled')
  }
  private registerSecrets = (values: readonly string[]): void => {
    this.owner_?.addSecrets(values)
  }
  private async setup(attempt: Attempt): Promise<AgentMcpHttpServerConfig> {
    const owner = this.owner(),
      status = await owner.list(attempt.abort.signal)
    this.assertCurrent(attempt)
    const entry = status.servers.find((entry) => entry.server.id === attempt.serverId)
    if (
      status.paused ||
      entry?.server.transport !== 'http' ||
      !entry.server.endpoint.startsWith('https:') ||
      entry.cleanupPending
    )
      throw new McpOAuthError('authorization-failed')
    attempt.endpoint = entry.server.endpoint
    attempt.configRevision = status.revision
    attempt.entry = this.clients.get(attempt.serverId)
    if (attempt.entry) await this.clearAuthority(attempt.entry, 'configured')
    this.assertCurrent(attempt)
    // This trusted call closes only MCP transport ownership. External Disconnect still cancels this exact attempt.
    await owner.disconnectForAuthorization(attempt.serverId)
    await owner.list(attempt.abort.signal)
    this.assertCurrent(attempt)
    return entry.server
  }
  private fetchFor(attempt: Attempt): FetchLike {
    return async (input, init) => {
      await this.owner().list(attempt.abort.signal)
      this.assertCurrent(attempt)
      const response = await (this.options.fetchFn ?? fetch)(input, init)
      try {
        await this.owner().list(attempt.abort.signal)
        this.assertCurrent(attempt)
      } catch (error) {
        void response.body?.cancel().catch(() => undefined)
        throw error
      }
      return response
    }
  }
  private checkPublic(value: unknown): void {
    this.owner().assertAllowed(value)
  }
  private clearReview(attempt: Attempt): void {
    clearTimeout(attempt.timer)
    delete attempt.timer
    delete attempt.review
  }
  private review(
    attempt: Attempt,
    kind: AgentMcpOAuthReview['kind'],
    disclosure: string
  ): AgentMcpOAuthReview {
    this.assertCurrent(attempt)
    const review: AgentMcpOAuthReview = Object.freeze({
      token: randomUUID(),
      kind,
      serverId: attempt.serverId,
      configRevision: attempt.configRevision!,
      disclosure,
      expiresAt: this.now() + this.lifetime
    })
    this.checkPublic(review)
    attempt.review = review
    attempt.timer = setTimeout(() => {
      if (this.attempts.get(attempt.serverId) === attempt)
        void this.invalidate(attempt.serverId, 'launch-cancelled')
    }, this.lifetime)
    this.notify()
    return review
  }
  private consume(token: string, kind: AgentMcpOAuthReview['kind']): Attempt {
    const attempt = [...this.attempts.values()].find((value) => value.review?.token === token)
    if (
      typeof token !== 'string' ||
      !attempt ||
      attempt.running ||
      attempt.consumed ||
      attempt.review?.kind !== kind ||
      this.now() >= attempt.review.expiresAt ||
      !this.current(attempt)
    )
      throw new McpOAuthError('invalid-plan')
    attempt.consumed = true
    attempt.running = true
    this.clearReview(attempt)
    return attempt
  }
  private finish(attempt: Attempt): void {
    this.clearReview(attempt)
    if (this.attempts.get(attempt.serverId) === attempt) this.attempts.delete(attempt.serverId)
    this.notify()
  }
  private install(attempt: Attempt, client: AgentMcpOAuthPublicClient): void {
    this.assertCurrent(attempt)
    this.checkPublic(client)
    this.clients.set(attempt.serverId, {
      client: Object.freeze({ ...client, scopes: Object.freeze([...client.scopes]) }),
      endpoint: attempt.endpoint!,
      configRevision: attempt.configRevision!,
      revision: randomUUID(),
      state: 'configured'
    })
  }
  configureClient(serverId: string, client: AgentMcpOAuthPublicClient): Promise<AgentMcpStatus> {
    const attempt = this.claim(serverId)
    return this.track(
      (async () => {
        try {
          exactPublicObject(client, CLIENT_KEYS)
          this.checkPublic(client)
          if (
            !Number.isInteger(client.redirectPort) ||
            client.redirectPort < 1 ||
            typeof client.redirectPath !== 'string' ||
            !Array.isArray(client.scopes)
          )
            throw new McpOAuthError('authorization-failed')
          validateMcpOAuthRedirectPath(client.redirectPath)
          const captured = structuredClone(client),
            server = await this.setup(attempt)
          const validator = new McpOAuthSession({
            endpoint: server.endpoint,
            configRevision: attempt.configRevision!,
            client: captured,
            scopes: captured.scopes,
            fetchFn: this.options.fetchFn ?? fetch,
            openBrowser: openAuthorizationBrowser,
            registerSecrets: () => undefined,
            configurationIsCurrent: () => true
          })
          await validator.disconnect()
          this.install(attempt, captured)
          this.finish(attempt)
          return await this.owner().list()
        } catch {
          throw new McpOAuthError(
            attempt.abort.signal.aborted ? 'cancelled' : 'authorization-failed'
          )
        } finally {
          this.finish(attempt)
        }
      })()
    )
  }
  prepareRegistration(
    serverId: string,
    settings: AgentMcpOAuthRegistrationSettings
  ): Promise<AgentMcpOAuthReview> {
    const attempt = this.claim(serverId)
    return this.track(
      (async () => {
        try {
          exactPublicObject(settings, REGISTRATION_KEYS)
          this.checkPublic(settings)
          if (!Array.isArray(settings.scopes)) throw new McpOAuthError('client-registration-failed')
          const captured = structuredClone(settings),
            server = await this.setup(attempt)
          attempt.registration = new McpOAuthRegistration({
            ...captured,
            endpoint: server.endpoint,
            configRevision: attempt.configRevision!,
            fetchFn: this.fetchFor(attempt),
            registerSecrets: this.registerSecrets,
            configurationIsCurrent: () => this.current(attempt),
            ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs })
          })
          const plan = await attempt.registration.prepareRegistration(attempt.abort.signal)
          this.assertCurrent(attempt)
          attempt.registrationPlan = plan
          const disclosure = `Register one public OAuth client. This sends the exact public metadata below once to the validated registration endpoint. The issuer may retain the registration. Public client settings remain only for this app launch; configuration changes, removal and shutdown clear them. Local disconnect does not delete the provider registration. Registration opens no browser, creates no authorization grant, and starts no MCP connection. Sign-in and MCP connection each require separate fresh review.${providerConsentDisclosure(plan.issuer)}\nServer: ${mcpDisplayJson(serverId)}\nEndpoint: ${mcpDisplayJson(plan.endpoint)}\nIssuer: ${mcpDisplayJson(plan.issuer)}\nRegistration endpoint: ${mcpDisplayJson(plan.registrationEndpoint)}\nExact public client metadata: ${mcpDisplayJson(plan.clientMetadata)}\nConfiguration revision: ${mcpDisplayJson(plan.configRevision)}\nRegistration revision: ${mcpDisplayJson(plan.revision)}`
          this.checkPublic([plan, disclosure])
          const review = this.review(attempt, 'registration', disclosure)
          attempt.running = false
          return review
        } catch (error) {
          await attempt.registration?.cancelRegistration()
          this.finish(attempt)
          throw error instanceof McpOAuthError
            ? error
            : new McpOAuthError(
                attempt.abort.signal.aborted
                  ? 'client-registration-cancelled'
                  : 'client-registration-failed'
              )
        }
      })()
    )
  }
  register(token: string): Promise<AgentMcpStatus> {
    const attempt = this.consume(token, 'registration')
    return this.track(
      (async () => {
        let submitted = false
        try {
          await this.owner().list(attempt.abort.signal)
          this.assertCurrent(attempt)
          this.checkPublic(attempt.registrationPlan)
          submitted = true
          const client = await attempt.registration!.beginRegistration(
            attempt.registrationPlan!,
            attempt.abort.signal
          )
          await this.owner().list(attempt.abort.signal)
          this.assertCurrent(attempt)
          this.install(attempt, client)
          this.finish(attempt)
          return await this.owner().list()
        } catch (error) {
          const safe =
            error instanceof McpOAuthError && error.code.startsWith('client-registration-')
              ? error
              : new McpOAuthError(
                  submitted
                    ? 'client-registration-uncertain'
                    : attempt.abort.signal.aborted
                      ? 'client-registration-cancelled'
                      : 'client-registration-failed'
                )
          if (this.current(attempt) && attempt.entry) {
            attempt.entry.state = 'failed'
            attempt.entry.message = safe.message
          }
          throw safe
        } finally {
          await attempt.registration?.cancelRegistration()
          this.finish(attempt)
        }
      })()
    )
  }
  prepareSignIn(serverId: string): Promise<AgentMcpOAuthReview> {
    const attempt = this.claim(serverId)
    return this.track(
      (async () => {
        try {
          const server = await this.setup(attempt),
            entry = attempt.entry
          if (
            !entry ||
            entry.configRevision !== attempt.configRevision ||
            entry.endpoint !== server.endpoint
          )
            throw new McpOAuthError('client-registration-required')
          const session = new McpOAuthSession({
            endpoint: entry.endpoint,
            configRevision: entry.configRevision,
            client: entry.client,
            scopes: entry.client.scopes,
            fetchFn: this.fetchFor(attempt),
            openBrowser: async (url, signal) => {
              this.assertCurrent(attempt)
              this.checkPublic(url.origin + url.pathname)
              await (this.options.openBrowser ?? openAuthorizationBrowser)(url, signal)
              this.assertCurrent(attempt)
            },
            registerSecrets: this.registerSecrets,
            configurationIsCurrent: () =>
              this.clients.get(serverId) === entry &&
              !this.closed &&
              !this.owner_?.authorizationContext().paused &&
              this.owner_?.authorizationContext().revision === entry.configRevision &&
              !attempt.abort.signal.aborted,
            ...(this.options.now ? { now: this.options.now } : {}),
            ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs })
          })
          entry.session = session
          attempt.session = session
          const plan = await session.prepareSignIn(attempt.abort.signal)
          this.assertCurrent(attempt)
          attempt.signInPlan = plan
          const disclosure = `Sign in using your browser for this app launch only. This opens the validated authorization endpoint, sends the public client ID and exact requested scopes, and receives the response at the owned loopback callback. Credentials remain in memory. Successful sign-in still needs a separate fresh MCP connection approval. Inspect provider consent, expiry and spending limits before granting access. Local disconnect clears session credentials; it does not revoke provider-side grants or API keys.${providerConsentDisclosure(plan.issuer)}\nServer: ${mcpDisplayJson(serverId)}\nEndpoint: ${mcpDisplayJson(plan.endpoint)}\nIssuer: ${mcpDisplayJson(plan.issuer)}\nAuthorization endpoint: ${mcpDisplayJson(plan.authorizationEndpoint)}\nClient ID: ${mcpDisplayJson(plan.clientId)}\nExact callback: ${mcpDisplayJson(`http://127.0.0.1:${entry.client.redirectPort}${entry.client.redirectPath}`)}\nRequested scopes: ${mcpDisplayJson(plan.scopes)}\nConfiguration revision: ${mcpDisplayJson(plan.configRevision)}\nAuthorization revision: ${mcpDisplayJson(plan.revision)}`
          this.checkPublic([entry.client, plan, disclosure])
          const review = this.review(attempt, 'sign-in', disclosure)
          attempt.running = false
          return review
        } catch (error) {
          if (attempt.entry)
            await this.clearAuthority(
              attempt.entry,
              attempt.abort.signal.aborted ? 'cancelled' : 'failed'
            )
          this.finish(attempt)
          throw error instanceof McpOAuthError
            ? error
            : new McpOAuthError(attempt.abort.signal.aborted ? 'cancelled' : 'authorization-failed')
        }
      })()
    )
  }
  signIn(token: string): Promise<AgentMcpOAuthSignInResult> {
    const attempt = this.consume(token, 'sign-in')
    return this.track(
      (async () => {
        let prepared = false
        try {
          await this.owner().list(attempt.abort.signal)
          this.assertCurrent(attempt)
          this.checkPublic(attempt.signInPlan)
          this.notify()
          await attempt.session!.beginSignIn(attempt.signInPlan!, attempt.abort.signal)
          this.assertCurrent(attempt)
          const preparation = await this.owner().prepareLaunch(
            attempt.serverId,
            attempt.abort.signal
          )
          this.assertCurrent(attempt)
          const entry = attempt.entry!
          entry.connectionReview = preparation.token
          entry.connectionTimer = setTimeout(
            () => {
              if (entry.connectionReview === preparation.token)
                this.owner_?.cancelLaunch(preparation.token)
            },
            Math.max(1, preparation.expiresAt - this.now())
          )
          this.finish(attempt)
          const status = await this.owner().list()
          if (
            this.clients.get(attempt.serverId) !== entry ||
            entry.session?.status().state !== 'connected'
          )
            throw new McpOAuthError('cancelled')
          prepared = true
          this.notify()
          return { status, preparation }
        } catch (error) {
          throw error instanceof McpOAuthError
            ? error
            : new McpOAuthError(attempt.abort.signal.aborted ? 'cancelled' : 'authorization-failed')
        } finally {
          if (!prepared && attempt.entry) await this.clearAuthority(attempt.entry, 'cancelled')
          this.finish(attempt)
        }
      })()
    )
  }
  private async clearAuthority(entry: ClientEntry, state: ClientEntry['state']): Promise<void> {
    clearTimeout(entry.connectionTimer)
    delete entry.connectionTimer
    delete entry.connectionReview
    const session = entry.session
    delete entry.session
    entry.revision = randomUUID()
    entry.state = state
    delete entry.message
    await (state === 'needs-sign-in' ? session?.requireSignIn() : session?.disconnect())
  }
  /** Authority is removed synchronously before awaiting callbacks, fetches or transport cleanup. */
  invalidate(serverId: string | undefined, reason: AgentMcpAuthorizationLifecycle): Promise<void> {
    if (reason === 'resumed') {
      this.closed = false
      return Promise.resolve()
    }
    if (reason === 'closed') this.closed = true
    const work: Promise<unknown>[] = []
    for (const [id, attempt] of this.attempts) {
      if ((serverId !== undefined && serverId !== id) || reason === 'connected') continue
      attempt.abort.abort()
      this.clearReview(attempt)
      if (attempt.registration) work.push(attempt.registration.cancelRegistration())
      if (attempt.session) work.push(attempt.session.disconnect())
      if (!attempt.running) this.attempts.delete(id)
    }
    for (const [id, entry] of this.clients) {
      if (serverId !== undefined && serverId !== id) continue
      if (reason === 'connected') {
        clearTimeout(entry.connectionTimer)
        delete entry.connectionTimer
        delete entry.connectionReview
        continue
      }
      const needsSignIn =
        reason === 'needs-sign-in' ||
        ((reason === 'connection-failed' || reason === 'launch-cancelled') &&
          (entry.state === 'needs-sign-in' || entry.session?.status().state === 'needs-sign-in'))
      work.push(this.clearAuthority(entry, needsSignIn ? 'needs-sign-in' : 'configured'))
      if (reason === 'configuration' || reason === 'closed') this.clients.delete(id)
    }
    this.notify()
    return this.track(Promise.all(work).then(() => undefined))
  }
  cancel(serverId: string): Promise<AgentMcpStatus> {
    return this.owner().disconnect(serverId)
  }
  status(server: AgentMcpHttpServerConfig): AgentMcpOAuthStatus {
    const entry = this.clients.get(server.id),
      attempt = this.attempts.get(server.id)
    const state =
      attempt?.registration?.status().state ??
      attempt?.session?.status().state ??
      entry?.session?.status().state ??
      entry?.state ??
      'unconfigured'
    const mapped: AgentMcpOAuthStatus['state'] =
      state === 'connected'
        ? 'authorized'
        : state === 'disconnected' || state === 'registered'
          ? 'configured'
          : state
    const result: AgentMcpOAuthStatus = {
      state: mapped,
      hasClient: !!entry,
      revision:
        attempt?.revision ??
        entry?.session?.status().revision ??
        entry?.revision ??
        this.anonymousRevision,
      ...(entry?.message ? { message: entry.message } : {})
    }
    this.owner_?.assertAllowed(result)
    return Object.freeze(result)
  }
  authorization(server: AgentMcpHttpServerConfig): {
    readonly revision: string
    readonly bearerToken?: string
  } {
    const entry = this.clients.get(server.id)
    if (
      !entry ||
      entry.endpoint !== server.endpoint ||
      entry.configRevision !== this.owner_?.authorizationContext().revision
    )
      return { revision: this.anonymousRevision }
    return entry.session?.authorizationSnapshot() ?? { revision: entry.revision }
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
