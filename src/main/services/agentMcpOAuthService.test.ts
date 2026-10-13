// SPDX-License-Identifier: Apache-2.0
// Ordinary offline host fixtures. Logical HTTPS is injected; only the owned loopback callback is real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike, JSONRPCMessage } from '@modelcontextprotocol/client'
import type { AgentMcpHttpServerConfig } from '../../shared/agentMcpTypes'
import type { AgentMcpOAuthPublicClient } from '../../shared/agentMcpOAuthTypes'
import { McpConfigStore } from './agentMcpConfig'
import { AgentMcpService, type AgentMcpInvocationOutcome } from './agentMcpService'
import { AgentMcpOAuthService } from './agentMcpOAuthService'
import { reopenAtomicWrites } from './atomicPersistence'
import { resumeAgentPersistence } from './agentPersistenceLifecycle'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused-offline-oauth-host-state' },
  shell: { openExternal: vi.fn(() => Promise.reject(new Error('External browser disabled'))) }
}))

const ENDPOINT = 'https://mcp.host-fixture.invalid/mcp'
const ISSUER = 'https://auth.host-fixture.invalid'
const TOKEN = 'offline-host-fixture-session-token'
const REFRESH = 'offline-host-fixture-refresh-token'
const CODE = 'offline-host-fixture-authorization-code'
const MANAGEMENT = 'offline-host-fixture-management-token'
const CLIENT_ID = 'offline-host-public-client'
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true
}
const SERVER: AgentMcpHttpServerConfig = {
  transport: 'http',
  id: 'remote',
  label: 'Owned offline OAuth host fixture',
  endpoint: ENDPOINT,
  protocol: '2026-07-28',
  allowLoopbackHttp: false
}
const signal = () => new AbortController().signal

function gate<T = void>() {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture port')
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return address.port
}
async function portAvailable(port: number): Promise<void> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
function callback(url: URL, denied = false): URL {
  const result = new URL(url.searchParams.get('redirect_uri')!)
  result.searchParams.set('state', url.searchParams.get('state')!)
  result.searchParams.set('iss', ISSUER)
  result.searchParams.set(denied ? 'error' : 'code', denied ? 'access_denied' : CODE)
  return result
}
function localGet(url: URL): Promise<{ status: number; body: string }> {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('Fixture can request only its own loopback callback')
  return new Promise((resolve, reject) => {
    const outgoing = request(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (part) => (body += part))
      response.on('end', () => resolve({ status: response.statusCode!, body }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}
interface WireCall {
  readonly url: string
  readonly method: string
  readonly body: string
  readonly headers: Headers
  readonly signal?: AbortSignal | null
}
interface FixtureOptions {
  readonly scopes?: readonly string[]
  readonly timeoutMs?: number
  readonly tokenExpiresIn?: number
  readonly oauthEffect?: (call: WireCall) => Promise<Response | undefined> | Response | undefined
  readonly mcpEffect?: (
    message: JSONRPCMessage,
    call: WireCall
  ) => Promise<Response | undefined> | Response | undefined
  readonly browser?: (url: URL, signal: AbortSignal) => Promise<void>
}
const subjects: Array<{ directory: string; service: AgentMcpService }> = []

async function fixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-agent-mcp-oauth-host-'))
  const store = new McpConfigStore(join(directory, 'private'))
  const oauthCalls: WireCall[] = []
  const mcpCalls: Array<WireCall & { message: JSONRPCMessage }> = []
  const browserCalls: Array<{ url: URL; signal: AbortSignal }> = []
  const browserOpened = gate<URL>()
  const publicStatuses: unknown[] = []
  let now = 1000
  const oauthFetch: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    expect(url.protocol).toBe('https:')
    expect([new URL(ENDPOINT).origin, ISSUER]).toContain(url.origin)
    const call: WireCall = {
      url: url.href,
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
      headers: new Headers(init?.headers),
      signal: init?.signal
    }
    expect(init?.redirect).toBe('manual')
    expect(call.headers.has('authorization')).toBe(false)
    oauthCalls.push(call)
    const injected = await options.oauthEffect?.(call)
    if (injected) return injected
    if (
      url.origin === new URL(ENDPOINT).origin &&
      url.pathname.startsWith('/.well-known/oauth-protected-resource')
    )
      return Response.json({
        resource: ENDPOINT,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
        scopes_supported: ['provider-suggested-scope']
      })
    if (url.origin === ISSUER && url.pathname.includes('/.well-known/'))
      return Response.json({ ...METADATA, scopes_supported: ['provider-suggested-scope'] })
    if (url.href === METADATA.registration_endpoint && call.method === 'POST')
      return Response.json(
        {
          ...JSON.parse(call.body),
          client_id: CLIENT_ID,
          registration_access_token: MANAGEMENT,
          registration_client_uri: `${ISSUER}/manage/client`
        },
        { status: 201 }
      )
    if (url.href === METADATA.token_endpoint && call.method === 'POST')
      return Response.json({
        access_token: TOKEN,
        refresh_token: REFRESH,
        token_type: 'Bearer',
        expires_in: options.tokenExpiresIn ?? 3600
      })
    throw new Error(`Unrecognized offline OAuth fixture request: ${url.origin}${url.pathname}`)
  }
  const httpFetch: FetchLike = async (input, init) => {
    expect(String(input)).toBe(ENDPOINT)
    expect(init?.method).toBe('POST')
    expect(init?.redirect).toBe('manual')
    const message: JSONRPCMessage = JSON.parse(String(init?.body))
    const call = {
      url: String(input),
      method: init!.method!,
      body: String(init?.body),
      headers: new Headers(init?.headers),
      signal: init?.signal,
      message
    }
    mcpCalls.push(call)
    const injected = await options.mcpEffect?.(message, call)
    if (injected) return injected
    if (!('method' in message)) throw new Error('Expected offline MCP request')
    if (!('id' in message)) return new Response(null, { status: 202 })
    let result: Record<string, unknown>
    if (message.method === 'server/discover')
      result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
    else if (message.method === 'tools/list')
      result = {
        tools: [{ name: 'echo', inputSchema: { type: 'object', additionalProperties: false } }]
      }
    else if (message.method === 'tools/call')
      result = { content: [{ type: 'text', text: 'Offline confirmed result' }] }
    else throw new Error('Unsupported offline MCP fixture method')
    return Response.json({
      jsonrpc: '2.0',
      id: message.id,
      result: { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
    })
  }
  const oauth = new AgentMcpOAuthService({
    fetchFn: oauthFetch,
    now: () => now,
    timeoutMs: options.timeoutMs ?? 3000,
    openBrowser: async (url, current) => {
      browserCalls.push({ url: new URL(url), signal: current })
      browserOpened.release(url)
      if (options.browser) return options.browser(url, current)
      expect((await localGet(callback(url))).status).toBe(200)
    }
  })
  const service = new AgentMcpService({
    store,
    env: {},
    now: () => now,
    privacyRevision: () => 'offline-host-privacy',
    httpFetch,
    httpAuthorization: (server) => oauth.authorization(server),
    httpAuthorizationInvalidated: (id, reason, revision) => oauth.invalidate(id, reason, revision),
    httpOAuthStatus: (server) => oauth.status(server),
    drainAuthorization: () => oauth.drain()
  })
  oauth.bind(service)
  service.onStatusChanged((status) => publicStatuses.push(status))
  const secretCalls = vi.spyOn(service, 'addSecrets')
  subjects.push({ directory, service })
  const client: AgentMcpOAuthPublicClient = {
    id: CLIENT_ID,
    issuer: ISSUER,
    redirectPort: await freePort(),
    redirectPath: '/oauth/host-callback',
    scopes: options.scopes ?? ['read', 'files:list']
  }
  await service.configure(SERVER)
  return {
    directory,
    store,
    service,
    oauth,
    client,
    oauthCalls,
    mcpCalls,
    browserCalls,
    browserOpened,
    publicStatuses,
    secretCalls,
    tick(milliseconds: number) {
      now += milliseconds
    },
    settings: () => ({
      issuer: client.issuer,
      redirectPort: client.redirectPort,
      redirectPath: client.redirectPath,
      scopes: [...client.scopes],
      clientName: 'Bot Commander Desktop offline host fixture'
    }),
    async authorize() {
      await oauth.configureClient(SERVER.id, client)
      return oauth.signIn((await oauth.prepareSignIn(SERVER.id)).token)
    },
    async prepareOperation() {
      const [snapshot] = await service.captureCatalogs(signal())
      const entry = snapshot.categories.tools.entries[0]
      return service.prepareOperation(snapshot, entry, 'tools', {
        id: 'offline-oauth-operation',
        name: entry.alias,
        arguments: {}
      })
    }
  }
}

beforeEach(() => {
  resumeAgentPersistence()
  reopenAtomicWrites()
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('Live network disabled in host fixture')
  )
})
afterEach(async () => {
  try {
    for (const subject of subjects.splice(0)) {
      await subject.service.close()
      await rm(subject.directory, { recursive: true, force: true })
    }
  } finally {
    vi.restoreAllMocks()
  }
})

describe('explicit desktop OAuth host approval boundaries', () => {
  it('saving, listing, client setup and ordinary launch review perform no external I/O', async () => {
    const subject = await fixture()
    expect((await subject.service.list()).servers[0].oauth).toMatchObject({
      state: 'unconfigured',
      hasClient: false
    })
    await subject.oauth.configureClient(SERVER.id, subject.client)
    expect((await subject.service.list()).servers[0].oauth).toMatchObject({
      state: 'configured',
      hasClient: true
    })
    expect(await subject.service.captureCatalogs(signal())).toEqual([])
    const launch = await subject.service.prepareLaunch(SERVER.id)
    subject.service.cancelLaunch(launch.token)
    expect(subject.oauthCalls).toEqual([])
    expect(subject.mcpCalls).toEqual([])
    expect(subject.browserCalls).toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it.each([{ scopes: ['read', 'files:list'] }, { scopes: [] }])(
    'registers exact public metadata once with exact scopes %j, then requires separate sign-in and Start',
    async ({ scopes }) => {
      const subject = await fixture({ scopes })
      const settings = subject.settings()
      const registration = await subject.oauth.prepareRegistration(SERVER.id, settings)
      expect(registration.kind).toBe('registration')
      expect(registration.disclosure).toContain('Sign-in and MCP connection each require separate')
      expect(subject.oauthCalls.every((call) => call.method === 'GET')).toBe(true)
      expect(subject.browserCalls).toEqual([])
      expect(subject.mcpCalls).toEqual([])
      expect(() => subject.oauth.signIn(registration.token)).toThrowError(
        expect.objectContaining({ code: 'invalid-plan' })
      )
      settings.scopes.push('late-added-scope')
      const copied = {
        ...registration,
        kind: 'sign-in',
        serverId: 'other',
        configRevision: 'invented',
        disclosure: 'Different metadata does not alter the exact private registration plan'
      }
      await subject.oauth.register(copied.token)
      expect(() => subject.oauth.register(registration.token)).toThrowError(
        expect.objectContaining({ code: 'invalid-plan' })
      )
      const posts = subject.oauthCalls.filter((call) => call.method === 'POST')
      expect(posts).toHaveLength(1)
      expect(posts[0].url).toBe(METADATA.registration_endpoint)
      const body = JSON.parse(posts[0].body)
      expect(body).toEqual({
        redirect_uris: [
          `http://127.0.0.1:${subject.client.redirectPort}${subject.client.redirectPath}`
        ],
        application_type: 'native',
        client_name: settings.clientName,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
        ...(scopes.length ? { scope: scopes.join(' ') } : {})
      })
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      const signIn = await subject.oauth.prepareSignIn(SERVER.id)
      expect(signIn.token).not.toBe(registration.token)
      expect(signIn.disclosure).toContain(`Requested scopes: ${JSON.stringify(scopes)}`)
      expect(subject.browserCalls).toEqual([])
      expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toHaveLength(1)
      expect(() => subject.oauth.register(signIn.token)).toThrowError(
        expect.objectContaining({ code: 'invalid-plan' })
      )
      await expect(subject.service.start(signIn.token)).rejects.toThrow('unavailable')
      const result = await subject.oauth.signIn(signIn.token)
      expect(() => subject.oauth.signIn(signIn.token)).toThrowError(
        expect.objectContaining({ code: 'invalid-plan' })
      )
      expect(result.status.servers[0].oauth?.state).toBe('authorized')
      expect(result.preparation.token).not.toBe(signIn.token)
      expect(result.preparation.disclosure).toContain('fresh connection approval')
      expect(subject.browserCalls).toHaveLength(1)
      expect(subject.browserCalls[0].url.searchParams.get('scope')).toBe(
        scopes.length ? scopes.join(' ') : null
      )
      expect(subject.mcpCalls).toEqual([])
      expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toHaveLength(2)
      expect(subject.oauth.authorization(SERVER).bearerToken).toBe(TOKEN)
      const epoch = subject.oauth.authorization(SERVER).revision
      expect((await subject.service.start(result.preparation.token)).started).toBe(true)
      expect(subject.oauth.authorization(SERVER).revision).toBe(epoch)
      expect(subject.oauth.authorization(SERVER).bearerToken).toBe(TOKEN)
      expect(
        subject.mcpCalls.map((call) => 'method' in call.message && call.message.method)
      ).toEqual(['server/discover', 'tools/list'])
      expect(
        subject.mcpCalls.every((call) => call.headers.get('authorization') === `Bearer ${TOKEN}`)
      ).toBe(true)
      expect(subject.mcpCalls.every((call) => !call.headers.has('last-event-id'))).toBe(true)
    }
  )

  it('rejects credential-bearing client settings and captures public settings before asynchronous setup', async () => {
    const subject = await fixture()
    await expect(
      subject.oauth.configureClient(SERVER.id, {
        ...subject.client,
        access_token: TOKEN
      } as AgentMcpOAuthPublicClient)
    ).rejects.toMatchObject({ code: 'authorization-failed' })
    const captured = { ...subject.client, scopes: [...subject.client.scopes] }
    const installing = subject.oauth.configureClient(SERVER.id, captured)
    captured.id = 'changed-after-click'
    captured.scopes.push('late-added-scope')
    await installing
    const review = await subject.oauth.prepareSignIn(SERVER.id)
    expect(review.disclosure).toContain(`Client ID: ${JSON.stringify(CLIENT_ID)}`)
    expect(review.disclosure).toContain(
      `Requested scopes: ${JSON.stringify(subject.client.scopes)}`
    )
    expect(subject.browserCalls).toEqual([])
    expect(subject.mcpCalls).toEqual([])
    expect(subject.oauthCalls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('public reviews, status events, persisted configuration and a restarted host contain no session secrets', async () => {
    const subject = await fixture()
    const registered = await subject.oauth.prepareRegistration(SERVER.id, subject.settings())
    await subject.oauth.register(registered.token)
    const review = await subject.oauth.prepareSignIn(SERVER.id)
    const result = await subject.oauth.signIn(review.token)
    const values = subject.secretCalls.mock.calls.flatMap(([secrets]) => [...secrets])
    const tokenBody = new URLSearchParams(
      subject.oauthCalls.find((call) => call.url === METADATA.token_endpoint)!.body
    )
    for (const secret of [
      MANAGEMENT,
      TOKEN,
      REFRESH,
      CODE,
      subject.browserCalls[0].url.searchParams.get('state')!,
      tokenBody.get('code_verifier')!
    ]) {
      expect(values).toContain(secret)
      expect(JSON.stringify([registered, review, result, subject.publicStatuses])).not.toContain(
        secret
      )
      await expect(subject.service.configure({ ...SERVER, label: secret })).rejects.toThrow()
    }
    const files = await readdir(subject.store.directory)
    for (const file of files) {
      const persisted = await readFile(join(subject.store.directory, file), 'utf8')
      for (const secret of [...values, CLIENT_ID, ISSUER]) expect(persisted).not.toContain(secret)
    }
    await subject.service.close()
    expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
    const freshOAuth = new AgentMcpOAuthService()
    const freshService = new AgentMcpService({
      store: new McpConfigStore(subject.store.directory),
      env: {},
      httpAuthorization: (server) => freshOAuth.authorization(server),
      httpAuthorizationInvalidated: (id, reason, revision) =>
        freshOAuth.invalidate(id, reason, revision),
      httpOAuthStatus: (server) => freshOAuth.status(server),
      drainAuthorization: () => freshOAuth.drain()
    })
    freshOAuth.bind(freshService)
    subjects.push({ directory: subject.directory, service: freshService })
    expect((await freshService.list()).servers[0]).toMatchObject({
      state: 'disabled',
      oauth: { state: 'unconfigured', hasClient: false }
    })
    await expect(freshOAuth.prepareSignIn(SERVER.id)).rejects.toThrow('public OAuth client')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('OAuth lifecycle ownership and cancellation', () => {
  it('claims registration and sign-in reviews before awaits and never repeats a consumed POST or browser open', async () => {
    const registrationHeld = gate()
    const postEntered = gate()
    const subject = await fixture({
      oauthEffect: async (call) => {
        if (call.url === METADATA.registration_endpoint) {
          postEntered.release()
          await registrationHeld.promise
        }
      },
      browser: async () => {}
    })
    const registration = await subject.oauth.prepareRegistration(SERVER.id, subject.settings())
    expect(() => subject.oauth.prepareRegistration(SERVER.id, subject.settings())).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    const submitted = subject.oauth.register(registration.token)
    await postEntered.promise
    expect(() => subject.oauth.register(registration.token)).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    registrationHeld.release()
    await submitted
    const review = await subject.oauth.prepareSignIn(SERVER.id)
    expect(() => subject.oauth.prepareSignIn(SERVER.id)).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    const signingIn = subject.oauth.signIn(review.token)
    const settled = signingIn.catch((error: unknown) => error)
    await subject.browserOpened.promise
    expect(() => subject.oauth.signIn(review.token)).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    await subject.oauth.cancel(SERVER.id)
    expect(await settled).toMatchObject({ code: 'cancelled' })
    expect(
      subject.oauthCalls.filter((call) => call.url === METADATA.registration_endpoint)
    ).toHaveLength(1)
    expect(subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)).toHaveLength(
      0
    )
    expect(subject.browserCalls).toHaveLength(1)
    expect(subject.mcpCalls).toEqual([])
    await portAvailable(subject.client.redirectPort)
  })

  it.each([
    'cancel',
    'disconnect',
    'navigation',
    'pause',
    'shutdown',
    'configuration',
    'remove'
  ] as const)(
    '%s closes a pending owned callback, revokes authority synchronously and rejects late completion',
    async (action) => {
      const subject = await fixture({ browser: async () => {} })
      await subject.oauth.configureClient(SERVER.id, subject.client)
      const review = await subject.oauth.prepareSignIn(SERVER.id)
      const signingIn = subject.oauth.signIn(review.token)
      const settled = signingIn.catch((error: unknown) => error)
      const browserUrl = await subject.browserOpened.promise
      let cleanup: Promise<unknown> = Promise.resolve()
      if (action === 'cancel') cleanup = subject.oauth.cancel(SERVER.id)
      if (action === 'disconnect') cleanup = subject.service.disconnect(SERVER.id)
      if (action === 'navigation') subject.service.cancelPendingLaunches()
      if (action === 'pause') subject.service.pause()
      if (action === 'shutdown') cleanup = subject.service.close()
      if (action === 'configuration')
        cleanup = subject.service.configure({ ...SERVER, label: 'Changed' })
      if (action === 'remove') cleanup = subject.service.remove(SERVER.id)
      if (!['configuration', 'remove'].includes(action))
        expect(subject.browserCalls[0].signal.aborted).toBe(true)
      await cleanup
      expect(await settled).toMatchObject({ code: 'cancelled' })
      await subject.oauth.drain()
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      expect(() => subject.oauth.signIn(review.token)).toThrowError(
        expect.objectContaining({ code: 'invalid-plan' })
      )
      await expect(localGet(callback(browserUrl))).rejects.toThrow()
      await portAvailable(subject.client.redirectPort)
      expect(subject.mcpCalls).toEqual([])
      expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toEqual([])
      if (action === 'pause') {
        subject.service.resume()
        const resumed = (await subject.service.list()).servers[0].oauth!
        expect(resumed.hasClient).toBe(true)
        expect(['configured', 'cancelled']).toContain(resumed.state)
        await subject.oauth.prepareSignIn(SERVER.id)
        expect(subject.browserCalls).toHaveLength(1)
        expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      }
      if (['configuration', 'shutdown', 'remove'].includes(action))
        expect(subject.oauth.status(SERVER).hasClient).toBe(false)
    }
  )

  it.each(['registration', 'token-exchange'] as const)(
    'disconnect during an approved %s POST cannot install a late successful result or replay',
    async (kind) => {
      const entered = gate<AbortSignal>()
      const released = gate()
      const target =
        kind === 'registration' ? METADATA.registration_endpoint : METADATA.token_endpoint
      const subject = await fixture({
        oauthEffect: async (call) => {
          if (call.url !== target) return
          entered.release(call.signal!)
          await released.promise
        }
      })
      let task: Promise<unknown>
      if (kind === 'registration')
        task = subject.oauth.register(
          (await subject.oauth.prepareRegistration(SERVER.id, subject.settings())).token
        )
      else {
        await subject.oauth.configureClient(SERVER.id, subject.client)
        task = subject.oauth.signIn((await subject.oauth.prepareSignIn(SERVER.id)).token)
      }
      const settled = task.catch((error: unknown) => error)
      const fetchSignal = await entered.promise
      await subject.service.disconnect(SERVER.id)
      expect(fetchSignal.aborted).toBe(true)
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      released.release()
      expect(await settled).toMatchObject({
        code: kind === 'registration' ? 'client-registration-uncertain' : 'cancelled'
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      await subject.oauth.drain()
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      expect(subject.oauth.status(SERVER).hasClient).toBe(kind !== 'registration')
      expect(subject.oauthCalls.filter((call) => call.url === target)).toHaveLength(1)
      expect(subject.mcpCalls).toEqual([])
      await portAvailable(subject.client.redirectPort)
    }
  )

  it.each(['complete', 'cancel'] as const)(
    'keeps same-server ownership through the final post-grant status check when terminal action is %s',
    async (action) => {
      const subject = await fixture()
      const entered = gate()
      const released = gate()
      const originalList = subject.service.list.bind(subject.service)
      let held = false
      vi.spyOn(subject.service, 'list').mockImplementation(async (current) => {
        if (!held && subject.oauth.authorization(SERVER).bearerToken) {
          held = true
          entered.release()
          await released.promise
        }
        return originalList(current)
      })
      await subject.oauth.configureClient(SERVER.id, subject.client)
      const review = await subject.oauth.prepareSignIn(SERVER.id)
      const signingIn = subject.oauth.signIn(review.token)
      const settled = signingIn.catch((error: unknown) => error)
      await entered.promise
      const oldEpoch = subject.oauth.authorization(SERVER).revision
      expect(() => subject.oauth.prepareSignIn(SERVER.id)).toThrowError(
        expect.objectContaining({ code: 'invalid-plan' })
      )
      if (action === 'cancel') {
        await subject.service.disconnect(SERVER.id)
        expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
        expect(() => subject.oauth.prepareSignIn(SERVER.id)).toThrowError(
          expect.objectContaining({ code: 'invalid-plan' })
        )
      }
      released.release()
      const result = await settled
      if (action === 'cancel') expect(result).toMatchObject({ code: 'cancelled' })
      else {
        expect(result).toHaveProperty('preparation.token')
        expect(subject.oauth.authorization(SERVER).revision).toBe(oldEpoch)
        await subject.service.disconnect(SERVER.id)
      }
      const fresh = await subject.oauth.prepareSignIn(SERVER.id)
      const current = await subject.oauth.signIn(fresh.token)
      const newEpoch = subject.oauth.authorization(SERVER).revision
      expect(newEpoch).not.toBe(oldEpoch)
      expect(subject.oauth.authorization(SERVER).bearerToken).toBe(TOKEN)
      expect((await subject.service.start(current.preparation.token)).started).toBe(true)
      expect(subject.oauth.authorization(SERVER).revision).toBe(newEpoch)
      expect(subject.browserCalls).toHaveLength(2)
      expect(
        subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)
      ).toHaveLength(2)
    }
  )

  it.each(['disconnect', 'navigation', 'pause', 'shutdown', 'configuration', 'remove'] as const)(
    '%s after a grant revokes it and the unconsumed connection review',
    async (action) => {
      const subject = await fixture()
      const { preparation } = await subject.authorize()
      expect(subject.oauth.authorization(SERVER).bearerToken).toBe(TOKEN)
      let cleanup: Promise<unknown> = Promise.resolve()
      if (action === 'disconnect') cleanup = subject.service.disconnect(SERVER.id)
      if (action === 'navigation') subject.service.cancelPendingLaunches()
      if (action === 'pause') subject.service.pause()
      if (action === 'shutdown') cleanup = subject.service.close()
      if (action === 'configuration')
        cleanup = subject.service.configure({ ...SERVER, label: 'Changed' })
      if (action === 'remove') cleanup = subject.service.remove(SERVER.id)
      if (!['configuration', 'remove'].includes(action))
        expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      await cleanup
      await subject.oauth.drain()
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      await expect(subject.service.start(preparation.token)).rejects.toThrow()
      expect(subject.mcpCalls).toEqual([])
      expect(subject.browserCalls).toHaveLength(1)
      expect(
        subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)
      ).toHaveLength(1)
    }
  )

  it.each(['registration', 'sign-in'] as const)(
    'late configuration during %s discovery cannot install a review or send a POST',
    async (kind) => {
      const entered = gate<AbortSignal>()
      const released = gate()
      const subject = await fixture({
        oauthEffect: async (call) => {
          entered.release(call.signal!)
          await released.promise
        }
      })
      if (kind === 'sign-in') await subject.oauth.configureClient(SERVER.id, subject.client)
      const pending =
        kind === 'registration'
          ? subject.oauth.prepareRegistration(SERVER.id, subject.settings())
          : subject.oauth.prepareSignIn(SERVER.id)
      const settled = pending.catch((error: unknown) => error)
      const fetchSignal = await entered.promise
      await subject.store.save(
        [{ ...SERVER, label: 'Changed outside host' }],
        (await subject.store.load()).revision
      )
      await subject.service.list()
      expect(fetchSignal.aborted).toBe(true)
      released.release()
      expect(await settled).toMatchObject({
        code: kind === 'registration' ? 'client-registration-cancelled' : 'cancelled'
      })
      expect(subject.oauth.status(SERVER).hasClient).toBe(false)
      expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toEqual([])
      expect(subject.browserCalls).toEqual([])
      expect(subject.mcpCalls).toEqual([])
    }
  )

  it('cancelled and expired OAuth reviews cannot start registration or sign-in', async () => {
    const subject = await fixture()
    const cancelled = await subject.oauth.prepareRegistration(SERVER.id, subject.settings())
    await subject.oauth.cancel(SERVER.id)
    expect(() => subject.oauth.register(cancelled.token)).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    const expired = await subject.oauth.prepareRegistration(SERVER.id, subject.settings())
    subject.tick(120001)
    expect(() => subject.oauth.register(expired.token)).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    await subject.oauth.cancel(SERVER.id)
    await subject.oauth.configureClient(SERVER.id, subject.client)
    const signIn = await subject.oauth.prepareSignIn(SERVER.id)
    subject.tick(120001)
    expect(() => subject.oauth.signIn(signIn.token)).toThrowError(
      expect.objectContaining({ code: 'invalid-plan' })
    )
    expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toEqual([])
    expect(subject.browserCalls).toEqual([])
    expect(subject.mcpCalls).toEqual([])
  })

  it.each(['cancel', 'expired', 'failed'] as const)(
    '%s fresh connection approval removes the successful grant without sending an unapproved MCP request',
    async (mode) => {
      const subject = await fixture({
        mcpEffect: mode === 'failed' ? () => new Response(null, { status: 500 }) : undefined
      })
      const { preparation } = await subject.authorize()
      const epoch = subject.oauth.authorization(SERVER).revision
      if (mode === 'cancel') subject.service.cancelLaunch(preparation.token)
      if (mode === 'expired') subject.tick(120001)
      if (mode === 'failed')
        expect((await subject.service.start(preparation.token)).started).toBe(false)
      else await expect(subject.service.start(preparation.token)).rejects.toThrow()
      await subject.oauth.drain()
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      expect(subject.oauth.authorization(SERVER).revision).not.toBe(epoch)
      expect(subject.mcpCalls).toHaveLength(mode === 'failed' ? 1 : 0)
      expect(subject.browserCalls).toHaveLength(1)
      expect(
        subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)
      ).toHaveLength(1)
    }
  )

  it.each(['denied', 'browser-failed', 'timeout', 'token-failed'] as const)(
    '%s sign-in removes authority and the callback, with no connection review or replay',
    async (mode) => {
      const subject = await fixture({
        timeoutMs: mode === 'timeout' ? 50 : 3000,
        browser: async (url) => {
          if (mode === 'browser-failed') throw new Error('Untrusted browser fixture diagnostic')
          if (mode === 'timeout') return
          await localGet(callback(url, mode === 'denied'))
        },
        oauthEffect: (call) =>
          mode === 'token-failed' && call.url === METADATA.token_endpoint
            ? Response.json({ error: 'invalid_grant', error_description: TOKEN }, { status: 400 })
            : undefined
      })
      await subject.oauth.configureClient(SERVER.id, subject.client)
      const review = await subject.oauth.prepareSignIn(SERVER.id)
      await expect(subject.oauth.signIn(review.token)).rejects.toMatchObject({
        code:
          mode === 'denied'
            ? 'authorization-denied'
            : mode === 'timeout'
              ? 'timeout'
              : 'authorization-failed'
      })
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      expect(subject.mcpCalls).toEqual([])
      expect(subject.browserCalls).toHaveLength(1)
      expect(
        subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)
      ).toHaveLength(mode === 'token-failed' ? 1 : 0)
      await portAvailable(subject.client.redirectPort)
    }
  )
})

describe('session-only HTTP authorization failures', () => {
  it.each(['disconnect', 'prepare-replacement'] as const)(
    'a delayed connected notification after %s cannot report stale success or revoke replacement authority',
    async (action) => {
      const subject = await fixture()
      const { preparation } = await subject.authorize()
      const oldEpoch = subject.oauth.authorization(SERVER).revision
      const entered = gate<string | undefined>()
      const released = gate()
      const originalInvalidate = subject.oauth.invalidate.bind(subject.oauth)
      let held = false
      vi.spyOn(subject.oauth, 'invalidate').mockImplementation((id, reason, revision) => {
        if (!held && reason === 'connected') {
          held = true
          entered.release(revision)
          return released.promise.then(() => originalInvalidate(id, reason, revision))
        }
        return originalInvalidate(id, reason, revision)
      })
      const startup = subject.service.start(preparation.token)
      expect(await entered.promise).toBe(oldEpoch)
      expect((await subject.service.list()).servers[0].state).toBe('connected')
      let replacement: Awaited<ReturnType<AgentMcpOAuthService['prepareSignIn']>> | undefined
      let replacementEpoch: string | undefined
      if (action === 'disconnect') await subject.service.disconnect(SERVER.id)
      else {
        replacement = await subject.oauth.prepareSignIn(SERVER.id)
        replacementEpoch = subject.oauth.authorization(SERVER).revision
        expect(replacementEpoch).not.toBe(oldEpoch)
      }
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      released.release()
      const result = await startup
      expect(result.started).toBe(false)
      expect(result.status.servers[0].state).toBe('disabled')
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      if (replacement) {
        expect(subject.oauth.authorization(SERVER).revision).toBe(replacementEpoch)
        expect(subject.oauth.status(SERVER).state).toBe('prepared')
        const fresh = await subject.oauth.signIn(replacement.token)
        const grantedEpoch = subject.oauth.authorization(SERVER).revision
        expect((await subject.service.start(fresh.preparation.token)).started).toBe(true)
        expect(subject.oauth.authorization(SERVER)).toEqual({
          revision: grantedEpoch,
          bearerToken: TOKEN
        })
        expect((await subject.service.list()).servers[0].state).toBe('connected')
        expect(subject.mcpCalls).toHaveLength(4)
      } else expect(subject.mcpCalls).toHaveLength(2)
    }
  )

  it('failure of the final public status projection immediately cancels its owned launch and grant', async () => {
    const subject = await fixture()
    await subject.oauth.configureClient(SERVER.id, subject.client)
    const review = await subject.oauth.prepareSignIn(SERVER.id)
    const prepareLaunch = vi.spyOn(subject.service, 'prepareLaunch')
    const cancelLaunch = vi.spyOn(subject.service, 'cancelLaunch')
    vi.spyOn(subject.service, 'statusSnapshot').mockImplementationOnce(() => {
      throw new Error('Offline public status projection unavailable')
    })
    await expect(subject.oauth.signIn(review.token)).rejects.toMatchObject({
      code: 'authorization-failed'
    })
    expect(prepareLaunch).toHaveBeenCalledOnce()
    const preparation = await prepareLaunch.mock.results[0].value
    expect(cancelLaunch).toHaveBeenCalledExactlyOnceWith(preparation.token)
    expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
    expect(subject.oauth.status(SERVER).hasClient).toBe(true)
    await expect(subject.service.start(preparation.token)).rejects.toThrow('unavailable')
    expect(subject.mcpCalls).toEqual([])
    expect(subject.browserCalls).toHaveLength(1)
    expect(subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)).toHaveLength(
      1
    )
    const fresh = await subject.oauth.prepareSignIn(SERVER.id)
    expect(fresh.token).not.toBe(review.token)
    expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
    expect(subject.browserCalls).toHaveLength(1)
  })

  it.each([401, 403])(
    'HTTP %i at startup requires sign-in and clears the grant without auth or MCP replay',
    async (status) => {
      const subject = await fixture({
        mcpEffect: () =>
          new Response(null, {
            status,
            headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="invented"' }
          })
      })
      const { preparation } = await subject.authorize()
      expect((await subject.service.start(preparation.token)).started).toBe(false)
      expect((await subject.service.list()).servers[0].oauth?.state).toBe('needs-sign-in')
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      expect(subject.mcpCalls).toHaveLength(1)
      expect(subject.browserCalls).toHaveLength(1)
      expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toHaveLength(1)
    }
  )

  it.each([401, 403])(
    'HTTP %i after an approved operation clears credentials and never repeats the exact request',
    async (status) => {
      const subject = await fixture({
        mcpEffect: (message) =>
          'method' in message && message.method === 'tools/call'
            ? new Response(null, { status })
            : undefined
      })
      const { preparation } = await subject.authorize()
      expect((await subject.service.start(preparation.token)).started).toBe(true)
      const operation = await subject.prepareOperation()
      const hooks = {
        beforeSend: vi.fn(async () => {}),
        settle: vi.fn(async (_outcome: AgentMcpInvocationOutcome) => {})
      }
      const result = await subject.service.invoke(operation, signal(), () => {}, hooks)
      expect(result).toMatchObject({ requestSent: true, doNotRetry: true })
      expect(hooks.beforeSend).toHaveBeenCalledOnce()
      expect(hooks.settle).toHaveBeenCalledOnce()
      expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
      expect((await subject.service.list()).servers[0].oauth?.state).toBe('needs-sign-in')
      expect((await subject.service.invoke(operation, signal(), () => {}, hooks)).requestSent).toBe(
        false
      )
      expect(
        subject.mcpCalls.filter(
          (call) => 'method' in call.message && call.message.method === 'tools/call'
        )
      ).toHaveLength(1)
      expect(subject.browserCalls).toHaveLength(1)
      expect(subject.oauthCalls.filter((call) => call.method === 'POST')).toHaveLength(1)
    }
  )

  it('session token expiry advances authority and disables the old connection without refreshing', async () => {
    const subject = await fixture({ tokenExpiresIn: 1 })
    const { preparation } = await subject.authorize()
    expect((await subject.service.start(preparation.token)).started).toBe(true)
    const epoch = subject.oauth.authorization(SERVER).revision
    const operation = await subject.prepareOperation()
    subject.tick(1001)
    expect(subject.oauth.authorization(SERVER).bearerToken).toBeUndefined()
    expect(subject.oauth.authorization(SERVER).revision).not.toBe(epoch)
    expect((await subject.service.list()).servers[0].oauth?.state).toBe('needs-sign-in')
    const result = await subject.service.invoke(operation, signal(), () => {}, {
      beforeSend: async () => {},
      settle: async () => {}
    })
    expect(result.requestSent).toBe(false)
    expect(subject.mcpCalls).toHaveLength(2)
    expect(subject.oauthCalls.filter((call) => call.url === METADATA.token_endpoint)).toHaveLength(
      1
    )
    expect(subject.browserCalls).toHaveLength(1)
  })
})
