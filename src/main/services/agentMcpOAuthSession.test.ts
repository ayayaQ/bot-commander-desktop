// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Vitest fixture adaptation of ayayaQ/vivi-cli at 38978a34adf1ae16ea2e61cbe15f9d8b01e1065c.
// https://github.com/ayayaQ/vivi-cli/blob/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c/test/mcp-oauth.test.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { test } from 'vitest'
import type { AuthorizationServerMetadata, FetchLike } from '@modelcontextprotocol/client'
import { McpOAuthSession, McpOAuthError } from './agentMcpOAuthSession'
import type { McpOAuthSessionOptions } from './agentMcpOAuthSession'

const endpoint = 'https://mcp.fixture.invalid/mcp',
  issuer = 'https://auth.fixture.invalid'
const deferred = <T = void>() => {
  let resolve!: (value?: T) => void
  const promise = new Promise<T>((done) => {
    resolve = (value) => done(value!)
  })
  return { promise, resolve }
}
const json = (value: unknown, status = 200) => Response.json(value, { status })
const codeError = (code: McpOAuthError['code']) => (error: unknown) =>
  error instanceof McpOAuthError && error.code === code && !/fixture-secret/.test(error.message)
async function portAvailable(url: URL): Promise<void> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number(url.port), '127.0.0.1', resolve)
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true
}
const callbackUrl = (url: URL) => {
  const callback = new URL(url.searchParams.get('redirect_uri')!)
  callback.searchParams.set('state', url.searchParams.get('state')!)
  callback.searchParams.set('code', 'fixture-secret-code')
  callback.searchParams.set('iss', issuer)
  return callback
}
interface FixtureOptions {
  client?: Partial<NonNullable<McpOAuthSessionOptions['client']>> | null
  fetchFn?: (url: URL, init: Parameters<FetchLike>[1]) => Response | void | Promise<Response | void>
  resource?: Record<string, unknown>
  metadata?: Partial<AuthorizationServerMetadata>
  tokens?: Record<string, unknown>
  timeoutMs?: number
  openBrowser?: McpOAuthSessionOptions['openBrowser']
}
function fixture(options: FixtureOptions = {}) {
  const calls: Array<{ url: string; method: string; body: string; signal?: AbortSignal | null }> =
      [],
    secrets: string[] = [],
    browserUrls: URL[] = []
  let current = true,
    now = 1000
  const fetchFn: FetchLike = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET'
    calls.push({ url: url.href, method, body: String(init?.body ?? ''), signal: init?.signal })
    if (options.fetchFn) {
      const result = await options.fetchFn(url, init)
      if (result) return result
    }
    if (
      url.origin === new URL(endpoint).origin &&
      url.pathname.startsWith('/.well-known/oauth-protected-resource')
    )
      return json(options.resource ?? { resource: endpoint, authorization_servers: [issuer] })
    if (url.origin === issuer && url.pathname.includes('/.well-known/'))
      return json({ ...metadata, ...options.metadata })
    if (url.href === metadata.token_endpoint && method === 'POST')
      return json(
        options.tokens ?? {
          access_token: 'fixture-secret-token',
          refresh_token: 'fixture-secret-refresh',
          token_type: 'Bearer',
          expires_in: 60
        }
      )
    return json({}, 404)
  }
  const session = new McpOAuthSession({
    endpoint,
    configRevision: 'fixture-revision',
    client:
      options.client === null
        ? undefined
        : { id: 'fixture-public-client', issuer, redirectPort: 0, ...options.client },
    scopes: ['read'],
    fetchFn,
    registerSecrets: (values) => secrets.push(...values),
    configurationIsCurrent: () => current,
    now: () => now,
    timeoutMs: options.timeoutMs ?? 5000,
    openBrowser: async (url, signal) => {
      browserUrls.push(url)
      if (options.openBrowser) return options.openBrowser(url, signal)
      const response = await fetch(callbackUrl(url))
      assert.equal(response.status, 200)
      assert.equal(
        await response.text(),
        'MCP sign-in received. You can return to Bot Commander Desktop.'
      )
    }
  })
  return {
    session,
    calls,
    secrets,
    browserUrls,
    stale: () => {
      current = false
    },
    tick: (value: number) => {
      now += value
    }
  }
}

test('explicit preregistered sign-in uses SDK S256/resource/scope and a real owned callback', async (t) => {
  const { session, calls, secrets, browserUrls } = fixture()
  t.onTestFinished(() => session.disconnect())
  assert.deepEqual(Object.keys(session.bearerProvider()), ['token'])
  const before = session.authorizationSnapshot().revision
  const plan = await session.prepareSignIn()
  assert.equal(session.status().state, 'prepared')
  assert.equal(browserUrls.length, 0)
  assert.equal(plan.registration, 'pre-registered-public-client')
  assert.deepEqual(plan.scopes, ['read'])
  assert.equal(plan.authorizationEndpoint, metadata.authorization_endpoint)
  assert.equal(plan.clientId, 'fixture-public-client')
  assert.equal(plan.redirectPort, 0)
  assert.equal(plan.redirectPath, undefined)
  assert(Object.isFrozen(plan))
  assert(Object.isFrozen(plan.scopes))
  await session.beginSignIn(plan)
  const url = browserUrls[0],
    body = new URLSearchParams(calls.find((call) => call.method === 'POST')!.body)
  assert.equal(url.searchParams.get('resource'), endpoint)
  assert.equal(body.get('resource'), endpoint)
  assert.equal(url.searchParams.get('scope'), 'read')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('grant_type'), null)
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('client_id'), 'fixture-public-client')
  assert.equal(body.get('client_secret'), null)
  assert.equal(body.get('code'), 'fixture-secret-code')
  assert.equal(
    createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
    url.searchParams.get('code_challenge')
  )
  assert.equal(secrets.includes(url.searchParams.get('state')!), true)
  assert.equal(secrets.includes(body.get('code_verifier')!), true)
  for (const secret of ['fixture-secret-code', 'fixture-secret-token', 'fixture-secret-refresh'])
    assert(secrets.includes(secret))
  assert.equal(session.status().state, 'connected')
  assert.notEqual(session.authorizationSnapshot().revision, before)
  assert.equal(await session.bearerProvider().token(), 'fixture-secret-token')
  assert(!JSON.stringify([plan, session.status()]).includes('fixture-secret'))
  assert(!calls.some((call) => /register/.test(call.url)))
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
  await portAvailable(new URL(url.searchParams.get('redirect_uri')!))
  const oldProvider = session.bearerProvider(),
    oldRevision = session.authorizationSnapshot().revision
  await session.disconnect()
  assert.equal(await oldProvider.token(), undefined)
  assert.notEqual(session.authorizationSnapshot().revision, oldRevision)
})

test('preregistration, validated issuer, secure endpoints, public client and S256 are required before browser opening', async (t) => {
  const variants = [
    { client: null },
    { metadata: { issuer: 'https://wrong.invalid' } },
    { metadata: { authorization_endpoint: 'http://auth.fixture.invalid/authorize' } },
    { metadata: { token_endpoint: 'http://auth.fixture.invalid/token' } },
    { metadata: { code_challenge_methods_supported: ['plain'] } },
    { metadata: { code_challenge_methods_supported: undefined } },
    { metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic'] } },
    { resource: { resource: 'https://other.invalid', authorization_servers: [issuer] } },
    { resource: { resource: endpoint, authorization_servers: ['https://wrong.invalid'] } }
  ]
  for (const options of variants) {
    const { session, calls, browserUrls } = fixture(options)
    t.onTestFinished(() => session.disconnect())
    await assert.rejects(
      session.prepareSignIn(),
      codeError(options.client === null ? 'client-registration-required' : 'authorization-failed')
    )
    assert.equal(browserUrls.length, 0)
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  }
  for (const endpoint of [
    'http://mcp.invalid',
    'https://user:secret@mcp.invalid',
    'https://mcp.invalid?token=secret',
    'https://mcp.invalid/#fragment'
  ])
    assert.throws(
      () =>
        new McpOAuthSession({
          endpoint,
          configRevision: 'fixture',
          scopes: [],
          fetchFn: async () => json({}),
          openBrowser: async () => {},
          registerSecrets: () => {},
          configurationIsCurrent: () => true
        }),
      codeError('authorization-failed')
    )
})

test('copied/stale plans and configuration changes invalidate sign-in and tokens', async (t) => {
  const value = fixture()
  t.onTestFinished(() => value.session.disconnect())
  const first = await value.session.prepareSignIn()
  await assert.rejects(value.session.beginSignIn({ ...first }), codeError('invalid-plan'))
  const second = await value.session.prepareSignIn()
  await assert.rejects(value.session.beginSignIn(first), codeError('invalid-plan'))
  value.stale()
  await assert.rejects(value.session.beginSignIn(second), codeError('invalid-plan'))
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
  assert.equal(value.browserUrls.length, 0)
})

test('expired session token advances auth epoch and requires explicit sign-in, without refresh', async (t) => {
  const value = fixture()
  t.onTestFinished(() => value.session.disconnect())
  await value.session.beginSignIn(await value.session.prepareSignIn())
  const provider = value.session.bearerProvider(),
    before = value.session.authorizationSnapshot().revision
  value.tick(60_000)
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
  assert.notEqual(value.session.authorizationSnapshot().revision, before)
  assert.equal(value.session.status().state, 'needs-sign-in')
  assert.equal(await provider.token(), undefined)
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1)
})

test('cancel during discovery aborts fetch and stale completion cannot install a plan', async (t) => {
  const started = deferred<AbortSignal>(),
    release = deferred()
  const value = fixture({
    fetchFn: async (_url, init) => {
      started.resolve(init!.signal!)
      await release.promise
      return json({})
    }
  })
  t.onTestFinished(() => value.session.disconnect())
  const preparation = value.session.prepareSignIn()
  const signal = await started.promise
  await value.session.cancelSignIn()
  assert(signal.aborted)
  await assert.rejects(preparation, codeError('cancelled'))
  release.resolve()
  assert.equal(value.session.status().state, 'cancelled')
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
})

test('cancel/disconnect during token exchange reject stale tokens and close callback port', async (t) => {
  for (const action of ['cancelSignIn', 'disconnect'] as const) {
    const started = deferred<AbortSignal>(),
      release = deferred()
    const value = fixture({
      fetchFn: async (url, init) => {
        if (url.href === metadata.token_endpoint) {
          started.resolve(init!.signal!)
          await release.promise
          return json({ access_token: 'fixture-secret-late', token_type: 'Bearer' })
        }
        return undefined
      }
    })
    t.onTestFinished(() => value.session.disconnect())
    const signing = value.session.beginSignIn(await value.session.prepareSignIn()),
      signal = await started.promise
    await value.session[action]()
    assert(signal.aborted)
    await assert.rejects(signing, codeError('cancelled'))
    release.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
    await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')!))
  }
})

test('browser failure, callback timeout, external abort and token failures leave no credential or listener', async (t) => {
  for (const options of [
    {
      openBrowser: async () => {
        throw new Error('fixture-secret-browser')
      }
    },
    { openBrowser: async () => {}, timeoutMs: 30 },
    { tokens: { access_token: 'fixture-secret-token', token_type: 'DPoP' } },
    {
      fetchFn: async (url: URL) =>
        url.href === metadata.token_endpoint
          ? json({ error: 'invalid_grant', error_description: 'fixture-secret-server' }, 400)
          : undefined
    }
  ]) {
    const value = fixture(options)
    t.onTestFinished(() => value.session.disconnect())
    await assert.rejects(
      value.session.beginSignIn(await value.session.prepareSignIn()),
      codeError(options.timeoutMs ? 'timeout' : 'authorization-failed')
    )
    assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
    if (value.browserUrls[0])
      await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')!))
    assert(value.calls.filter((call) => call.method === 'POST').length <= 1)
  }
  const opened = deferred<URL>(),
    value = fixture({
      openBrowser: async (url: URL) => {
        opened.resolve(url)
        await new Promise(() => {})
      }
    })
  t.onTestFinished(() => value.session.disconnect())
  const abort = new AbortController(),
    signing = value.session.beginSignIn(await value.session.prepareSignIn(), abort.signal),
    url = await opened.promise
  abort.abort()
  await assert.rejects(signing, codeError('cancelled'))
  await portAvailable(new URL(url.searchParams.get('redirect_uri')!))
})

test('metadata/token response bytes and redirects are bounded and errors never echo provider text', async (t) => {
  for (const fetchFn of [
    async () => new Response('fixture-secret-' + 'x'.repeat(70_000)),
    async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://wrong.invalid/fixture-secret' }
      })
  ]) {
    const value = fixture({ fetchFn })
    t.onTestFinished(() => value.session.disconnect())
    await assert.rejects(value.session.prepareSignIn(), codeError('authorization-failed'))
    assert.equal(value.browserUrls.length, 0)
    assert(value.calls.every((call) => !/wrong.invalid/.test(call.url)))
  }
})

test('one prepared plan permits only one concurrent beginSignIn', async (t) => {
  const opened = deferred<URL>(),
    resume = deferred()
  const value = fixture({
    openBrowser: async (url: URL) => {
      opened.resolve(url)
      await resume.promise
      await fetch(callbackUrl(url))
    }
  })
  t.onTestFinished(() => value.session.disconnect())
  const plan = await value.session.prepareSignIn(),
    first = value.session.beginSignIn(plan)
  await assert.rejects(value.session.beginSignIn(plan), codeError('invalid-plan'))
  await opened.promise
  assert.equal(value.browserUrls.length, 1)
  resume.resolve()
  await first
  assert.equal(value.session.status().state, 'connected')
  await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')!))
})

test('valid token endpoint default ports and hostname case use canonical fetch identity', async (t) => {
  for (const token_endpoint of [
    'https://auth.fixture.invalid:443/token',
    'https://AUTH.fixture.invalid/token'
  ]) {
    const value = fixture({ metadata: { token_endpoint } })
    t.onTestFinished(() => value.session.disconnect())
    await value.session.beginSignIn(await value.session.prepareSignIn())
    assert.equal(value.session.status().state, 'connected')
    assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1)
  }
})

test('preregistered exact redirect path is bound through browser callback and code exchange', async (t) => {
  const redirectPath = '/registered/vivi-callback'
  const value = fixture({
    client: { redirectPath },
    fetchFn: async (url, init) => {
      if (url.href === metadata.token_endpoint) {
        const body = new URLSearchParams(String(init?.body ?? ''))
        assert.equal(new URL(body.get('redirect_uri')!).pathname, redirectPath)
      }
    }
  })
  t.onTestFinished(() => value.session.disconnect())
  for (let i = 0; i < 2; i++) {
    const plan = await value.session.prepareSignIn()
    assert.equal(plan.redirectPath, redirectPath)
    await value.session.beginSignIn(plan)
    assert.equal(
      new URL(value.browserUrls[i].searchParams.get('redirect_uri')!).pathname,
      redirectPath
    )
    assert.equal(value.session.status().state, 'connected')
  }
  assert.notEqual(
    value.browserUrls[0].searchParams.get('state')!,
    value.browserUrls[1].searchParams.get('state')!
  )
  for (const redirectPath of [
    '//other.invalid/path',
    '/path?query',
    '/path#fragment',
    '/a/../callback',
    '/%2e%2e/callback',
    '/a\\b',
    '/a//b'
  ])
    assert.throws(() => fixture({ client: { redirectPath } }), codeError('authorization-failed'))
})

test('configuration changes during exchange prevent a late token commit without explicit disconnect', async (t) => {
  const started = deferred<AbortSignal>(),
    release = deferred()
  const value = fixture({
    fetchFn: async (url: URL) => {
      if (url.href === metadata.token_endpoint) {
        started.resolve()
        await release.promise
        return json({ access_token: 'fixture-secret-late', token_type: 'Bearer' })
      }
      return undefined
    }
  })
  t.onTestFinished(() => value.session.disconnect())
  const signing = value.session.beginSignIn(await value.session.prepareSignIn())
  await started.promise
  value.stale()
  release.resolve()
  await assert.rejects(signing, codeError('cancelled'))
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
  await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')!))
})

test('operation denial revokes credentials synchronously and needs an explicit new sign-in', async (t) => {
  const value = fixture()
  t.onTestFinished(() => value.session.disconnect())
  await value.session.beginSignIn(await value.session.prepareSignIn())
  const provider = value.session.bearerProvider(),
    revision = value.session.authorizationSnapshot().revision
  const closing = value.session.requireSignIn()
  assert.equal(value.session.status().state, 'needs-sign-in')
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
  assert.notEqual(value.session.authorizationSnapshot().revision, revision)
  await closing
  assert.equal(await provider.token(), undefined)
  assert.equal(value.browserUrls.length, 1)
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 1)
})

test('requireSignIn cancels an active flow and awaits callback listener release', async (t) => {
  const opened = deferred<URL>(),
    value = fixture({
      openBrowser: async (url: URL) => {
        opened.resolve(url)
      }
    })
  t.onTestFinished(() => value.session.disconnect())
  const signing = value.session.beginSignIn(await value.session.prepareSignIn())
  const rejection = assert.rejects(signing, codeError('cancelled'))
  const url = await opened.promise,
    closing = value.session.requireSignIn()
  assert.equal(value.session.status().state, 'needs-sign-in')
  await closing
  await rejection
  assert.equal(value.session.status().state, 'needs-sign-in')
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
  await portAvailable(new URL(url.searchParams.get('redirect_uri')!))
  assert.equal(value.calls.filter((call) => call.method === 'POST').length, 0)
})
