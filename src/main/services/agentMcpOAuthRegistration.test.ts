// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Vitest fixture adaptation of ayayaQ/vivi-cli at 38978a34adf1ae16ea2e61cbe15f9d8b01e1065c.
// https://github.com/ayayaQ/vivi-cli/blob/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c/test/mcp-oauth-registration.test.mjs
import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { AuthorizationServerMetadata, FetchLike } from '@modelcontextprotocol/client'
import { McpOAuthRegistration } from './agentMcpOAuthRegistration'
import type { McpOAuthRegistrationSettings } from './agentMcpOAuthRegistration'
import { McpOAuthError } from './agentMcpOAuthCallback'

const endpoint = 'https://mcp.fixture.invalid/mcp',
  issuer = 'https://auth.fixture.invalid'
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none']
}
const settings = {
  issuer,
  redirectPort: 41873,
  redirectPath: '/oauth/callback',
  scopes: ['read'],
  clientName: 'Bot Commander Desktop fixture'
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const safeError = (code: McpOAuthError['code']) => (error: unknown) =>
  error instanceof McpOAuthError &&
  error.code === code &&
  !/fixture-secret|provider-error/.test(error.message)
async function fixtureCase(label: string, check: () => Promise<void>): Promise<void> {
  try {
    await check()
  } catch (error) {
    throw new Error(`Fixture case ${label} failed`, { cause: error })
  }
}
interface FixtureOptions {
  settings?: Partial<McpOAuthRegistrationSettings>
  timeoutMs?: number
  fetchFn?: (url: URL, init: Parameters<FetchLike>[1]) => Response | void | Promise<Response | void>
  resource?: Record<string, unknown>
  metadata?: Partial<AuthorizationServerMetadata>
  response?: (body: Record<string, unknown>) => Record<string, unknown>
}
function fixture(options: FixtureOptions = {}) {
  const calls: Array<{
      url: string
      method: string
      body: string
      signal?: AbortSignal | null
      redirect?: RequestRedirect
    }> = [],
    secrets: string[] = []
  let current = true
  const registration = new McpOAuthRegistration({
    endpoint,
    configRevision: 'fixture-config',
    ...settings,
    ...options.settings,
    timeoutMs: options.timeoutMs ?? 3000,
    registerSecrets: (values) => secrets.push(...values),
    configurationIsCurrent: () => current,
    fetchFn: async (input, init) => {
      const url = new URL(String(input)),
        method = init?.method ?? 'GET'
      calls.push({
        url: url.href,
        method,
        body: String(init?.body ?? ''),
        signal: init?.signal,
        redirect: init?.redirect
      })
      const injected = await options.fetchFn?.(url, init)
      if (injected) return injected
      if (
        url.origin === new URL(endpoint).origin &&
        url.pathname.startsWith('/.well-known/oauth-protected-resource')
      )
        return Response.json(
          options.resource ?? {
            resource: endpoint,
            authorization_servers: [issuer],
            bearer_methods_supported: ['header']
          }
        )
      if (url.origin === issuer && url.pathname.includes('/.well-known/'))
        return Response.json({ ...metadata, ...options.metadata })
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json(
          options.response
            ? options.response(body)
            : { ...body, client_id: 'fixture-public-client' },
          { status: 201 }
        )
      }
      return Response.json({}, { status: 404 })
    }
  })
  return {
    registration,
    calls,
    secrets,
    stale: () => {
      current = false
    }
  }
}

test('SDK-real DCR is one explicit POST of exact public metadata and fixed preregistered callback', async (t) => {
  const { registration, calls, secrets } = fixture({
    response: (body) => ({
      ...body,
      client_id: 'fixture-public-client',
      registration_access_token: 'fixture-secret-management',
      registration_client_uri: `${issuer}/manage/client`
    })
  })
  t.onTestFinished(() => registration.cancelRegistration())
  const plan = await registration.prepareRegistration()
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  assert.equal(plan.endpoint, endpoint)
  assert.equal(plan.issuer, issuer)
  assert.equal(plan.registrationEndpoint, metadata.registration_endpoint)
  assert.equal(plan.redirectUri, 'http://127.0.0.1:41873/oauth/callback')
  assert.deepEqual(plan.clientMetadata, {
    redirect_uris: [plan.redirectUri],
    application_type: 'native',
    client_name: 'Bot Commander Desktop fixture',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
    scope: 'read'
  })
  assert(Object.isFrozen(plan))
  assert(Object.isFrozen(plan.clientMetadata))
  assert(Object.isFrozen(plan.clientMetadata.redirect_uris))
  const client = await registration.beginRegistration(plan)
  assert.deepEqual(client, {
    id: 'fixture-public-client',
    issuer,
    redirectPort: settings.redirectPort,
    redirectPath: settings.redirectPath,
    scopes: ['read']
  })
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
  assert(secrets.includes('fixture-secret-management'))
  assert.equal(registration.status().state, 'registered')
})

test('registration result retains public launch settings only and cannot reuse an approval', async (t) => {
  const { registration, calls, secrets } = fixture({
    response: (body) => ({
      ...body,
      client_id: 'fixture-public-client',
      registration_access_token: 'fixture-secret-management'
    })
  })
  t.onTestFinished(() => registration.cancelRegistration())
  const plan = await registration.prepareRegistration(),
    client = await registration.beginRegistration(plan)
  assert.deepEqual(client, {
    id: 'fixture-public-client',
    issuer,
    redirectPort: settings.redirectPort,
    redirectPath: settings.redirectPath,
    scopes: ['read']
  })
  assert(Object.isFrozen(client))
  assert(Object.isFrozen(client.scopes))
  assert.equal(secrets.includes('fixture-secret-management'), true)
  assert(!JSON.stringify([client, registration.status(), plan]).includes('fixture-secret'))
  const post = calls.filter((call) => call.method === 'POST')
  assert.equal(post.length, 1)
  assert.equal(post[0].url, metadata.registration_endpoint)
  assert.equal(post[0].redirect, 'manual')
  const body = JSON.parse(post[0].body)
  assert.equal(body.client_secret, undefined)
  assert(!body.grant_types.includes('refresh_token'))
  assert.equal(body.scope, 'read')
  assert(!calls.some((call) => /\/token$|\/authorize$/.test(call.url)))
  await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
})

test('empty requested scopes omit scope and do not invent provider grants', async (t) => {
  const { registration, calls } = fixture({ settings: { scopes: [] } })
  t.onTestFinished(() => registration.cancelRegistration())
  const plan = await registration.prepareRegistration()
  assert.equal(Object.hasOwn(plan.clientMetadata, 'scope'), false)
  assert.deepEqual((await registration.beginRegistration(plan)).scopes, [])
  assert.equal(
    Object.hasOwn(JSON.parse(calls.find((call) => call.method === 'POST')!.body), 'scope'),
    false
  )
})

test('discovery must advertise a safe registration endpoint and compatible issuer/resource/PKCE/public client', async () => {
  const variants = [
    { metadata: { registration_endpoint: undefined } },
    { metadata: { issuer: 'https://other.invalid' } },
    { metadata: { registration_endpoint: 'http://auth.fixture.invalid/register' } },
    { metadata: { registration_endpoint: `${issuer}/register?secret=fixture-secret` } },
    { metadata: { authorization_endpoint: 'http://auth.fixture.invalid/authorize' } },
    { metadata: { token_endpoint: 'http://auth.fixture.invalid/token' } },
    { metadata: { code_challenge_methods_supported: ['plain'] } },
    { metadata: { response_types_supported: ['token'] } },
    { metadata: { grant_types_supported: ['refresh_token'] } },
    { metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic'] } },
    { resource: { resource: 'https://other.invalid/mcp', authorization_servers: [issuer] } },
    { resource: { resource: endpoint, authorization_servers: ['https://other.invalid'] } },
    {
      resource: {
        resource: endpoint,
        authorization_servers: [issuer],
        bearer_methods_supported: ['query']
      }
    }
  ]
  for (const [index, options] of variants.entries())
    await fixtureCase(`invalid discovery ${index}`, async () => {
      const { registration, calls } = fixture(options)
      await assert.rejects(
        registration.prepareRegistration(),
        safeError('client-registration-failed')
      )
      assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
      await registration.cancelRegistration()
    })
})

test('returned registration is rejected unless exact native public metadata is preserved', async () => {
  const variants = [
    { client_id: '' },
    { client_id: 'x'.repeat(1025) },
    { client_id: 'bad\nclient' },
    { client_secret: 'fixture-secret-client' },
    { client_secret: '' },
    { token_endpoint_auth_method: 'client_secret_basic' },
    { redirect_uris: ['http://127.0.0.1:41873/wrong'] },
    { redirect_uris: ['http://127.0.0.1:41873/oauth/callback', 'https://other.invalid'] },
    { grant_types: ['authorization_code', 'refresh_token'] },
    { response_types: ['token'] },
    { application_type: 'web' },
    { application_type: undefined },
    { client_name: undefined },
    { client_name: 'changed client' },
    { scope: undefined },
    { scope: 'read write' },
    { scope: 'write' },
    { issuer: 'https://wrong.invalid' }
  ]
  for (const [index, change] of variants.entries())
    await fixtureCase(`invalid response ${index}`, async () => {
      const { registration, calls, secrets } = fixture({
        response: (body) => ({ ...body, client_id: 'fixture-public-client', ...change })
      })
      const plan = await registration.prepareRegistration()
      await assert.rejects(
        registration.beginRegistration(plan),
        safeError('client-registration-uncertain')
      )
      assert.equal(registration.status().state, 'failed')
      assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
      if (change.client_secret) assert(secrets.includes(change.client_secret))
      await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
    })
})

test('plans are object-bound, epoch-bound and configuration-bound', async (t) => {
  const { registration, calls, stale } = fixture()
  t.onTestFinished(() => registration.cancelRegistration())
  const first = await registration.prepareRegistration()
  await assert.rejects(registration.beginRegistration({ ...first }), safeError('invalid-plan'))
  await registration.cancelRegistration()
  await assert.rejects(registration.beginRegistration(first), safeError('invalid-plan'))
  const second = await registration.prepareRegistration()
  stale()
  await assert.rejects(registration.beginRegistration(second), safeError('invalid-plan'))
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
})

test('concurrent preparation invalidates the older request before discovery', async () => {
  const { registration, calls } = fixture()
  const first = registration.prepareRegistration(),
    rejected = assert.rejects(first, safeError('invalid-plan'))
  const second = registration.prepareRegistration()
  await rejected
  await second
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  await registration.cancelRegistration()
})

test('concurrent begin claims one approval and sends only once', async () => {
  const gate = deferred(),
    entered = deferred()
  const { registration, calls } = fixture({
    fetchFn: async (_url, init) => {
      if (init?.method === 'POST') {
        entered.resolve()
        await gate.promise
      }
    }
  })
  const plan = await registration.prepareRegistration(),
    begun = registration.beginRegistration(plan)
  await entered.promise
  await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  gate.resolve()
  await begun
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
})

test('cancelled discovery ignores late results and sends nothing', async () => {
  const gate = deferred(),
    entered = deferred()
  const { registration, calls } = fixture({
    fetchFn: async () => {
      entered.resolve()
      await gate.promise
    }
  })
  const pending = registration.prepareRegistration(),
    rejected = assert.rejects(pending, safeError('client-registration-cancelled'))
  await entered.promise
  const before = registration.status().revision
  await registration.cancelRegistration()
  await rejected
  assert.notEqual(registration.status().revision, before)
  gate.resolve()
  await Promise.resolve()
  assert.equal(registration.status().state, 'cancelled')
  assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
})

test('sent POST cancellation and changed config cannot commit a late client and warn about uncertain service outcome', async () => {
  for (const kind of ['cancel', 'signal', 'config'])
    await fixtureCase(kind, async () => {
      const gate = deferred(),
        entered = deferred(),
        abort = new AbortController()
      const { registration, calls, stale } = fixture({
        fetchFn: async (_url, init) => {
          if (init?.method === 'POST') {
            entered.resolve()
            await gate.promise
          }
        }
      })
      const plan = await registration.prepareRegistration(),
        pending = registration.beginRegistration(plan, abort.signal)
      const rejected = assert.rejects(pending, safeError('client-registration-uncertain'))
      await entered.promise
      if (kind === 'cancel') await registration.cancelRegistration()
      if (kind === 'signal') abort.abort()
      if (kind === 'config') stale()
      gate.resolve()
      await rejected
      assert.notEqual(registration.status().state, 'registered')
      assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
    })
})

test('timeouts and aborted approval send no POST; sent timeout is uncertain', async () => {
  await fixtureCase('discovery timeout', async () => {
    const { registration, calls } = fixture({
      timeoutMs: 20,
      fetchFn: async () => new Promise(() => {})
    })
    await assert.rejects(
      registration.prepareRegistration(),
      safeError('client-registration-cancelled')
    )
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  })
  await fixtureCase('signal already aborted', async () => {
    const { registration, calls } = fixture(),
      plan = await registration.prepareRegistration(),
      abort = new AbortController()
    abort.abort()
    await assert.rejects(
      registration.beginRegistration(plan, abort.signal),
      safeError('client-registration-cancelled')
    )
    assert.equal(calls.filter((call) => call.method === 'POST').length, 0)
  })
  await fixtureCase('POST timeout', async () => {
    const { registration, calls } = fixture({
      timeoutMs: 20,
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') return new Promise(() => {})
      }
    })
    const plan = await registration.prepareRegistration()
    await assert.rejects(
      registration.beginRegistration(plan),
      safeError('client-registration-uncertain')
    )
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
  })
})

test('redirects, oversized responses, malformed JSON and provider errors cannot cause POST retries or leak errors', async () => {
  const responses = [
    () => new Response(null, { status: 307, headers: { Location: `${issuer}/register-again` } }),
    () =>
      new Response(null, { status: 308, headers: { Location: 'https://other.invalid/register' } }),
    () => new Response('x'.repeat(65537)),
    () => new Response('{'),
    () =>
      Response.json(
        {
          error: 'invalid_client_metadata',
          error_description: 'provider-error fixture-secret-error',
          client_secret: 'fixture-secret-error'
        },
        { status: 400 }
      )
  ]
  for (const [index, response] of responses.entries())
    await fixtureCase(`response ${index}`, async () => {
      const { registration, calls, secrets } = fixture({
        fetchFn: (_url, init) => (init?.method === 'POST' ? response() : undefined)
      })
      const plan = await registration.prepareRegistration()
      await assert.rejects(
        registration.beginRegistration(plan),
        safeError('client-registration-uncertain')
      )
      assert.equal(calls.filter((call) => call.method === 'POST').length, 1)
      if (index === 4) assert(secrets.includes('fixture-secret-error'))
    })
})

test('fixed callback and bounded public settings are required before discovery', () => {
  for (const change of [
    { redirectPort: 0 },
    { redirectPort: 65536 },
    { redirectPath: '//evil' },
    { redirectPath: '/callback?code=x' },
    { redirectPath: '/%2e' },
    { redirectPath: '/a/../b' },
    { clientName: '' },
    { clientName: '\nunsafe' },
    { clientName: 'x'.repeat(129) },
    { scopes: ['read', 'read'] },
    { scopes: ['bad scope'] },
    { issuer: 'http://auth.invalid' }
  ])
    assert.throws(() => fixture({ settings: change }))
})
