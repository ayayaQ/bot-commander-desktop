// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Vitest fixture adaptation of ayayaQ/vivi-cli at 38978a34adf1ae16ea2e61cbe15f9d8b01e1065c.
// https://github.com/ayayaQ/vivi-cli/blob/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c/test/mcp-oauth.test.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { request } from 'node:http'
import { test } from 'vitest'
import type { TestContext } from 'vitest'
import { McpOAuthCallback, McpOAuthError } from './agentMcpOAuthCallback'
import type { McpOAuthCallbackOptions } from './agentMcpOAuthCallback'

const issuer = 'https://auth.fixture.invalid'
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
async function callbackFixture(t: TestContext, extra: Partial<McpOAuthCallbackOptions> = {}) {
  const abort = new AbortController(),
    secrets: string[] = []
  const callback = await McpOAuthCallback.listen({
    state: 'fixture-secret-state',
    issuer,
    requireIssuer: true,
    port: 0,
    signal: abort.signal,
    isActive: () => true,
    registerSecrets: (values) => secrets.push(...values),
    ...extra
  })
  t.onTestFinished(() => callback.close())
  const valid = new URL(callback.redirectUrl)
  valid.search = new URLSearchParams({
    state: 'fixture-secret-state',
    code: 'fixture-secret-code',
    iss: issuer
  }).toString()
  return { callback, valid, abort, secrets }
}

test('callback rejects malformed paths, state, issuer, duplicate params and request methods before exchange', async (t) => {
  const { callback, valid, secrets } = await callbackFixture(t)
  const variants: Array<(url: URL) => void> = [
    (url) => url.searchParams.delete('state'),
    (url) => url.searchParams.set('state', 'wrong'),
    (url) => url.searchParams.delete('iss'),
    (url) => url.searchParams.set('iss', 'https://wrong.invalid'),
    (url) => url.searchParams.append('state', 'fixture-secret-state'),
    (url) => url.searchParams.append('code', 'other'),
    (url) => url.searchParams.append('iss', issuer),
    (url) => {
      url.pathname += '/other'
    },
    (url) => url.searchParams.set('code', 'unsafe\ncode'),
    (url) => url.searchParams.set('error', 'access_denied')
  ]
  for (const change of variants) {
    const url = new URL(valid)
    change(url)
    const response = await fetch(url)
    assert.equal(response.status, 400)
    assert(!/fixture-secret|wrong.invalid/.test(await response.text()))
  }
  assert.equal((await fetch(valid, { method: 'POST' })).status, 400)
  assert.equal(
    await new Promise((resolve, reject) => {
      const call = request(valid, { headers: { Host: 'other.invalid' } }, (response) => {
        response.resume()
        resolve(response.statusCode)
      })
      call.once('error', reject)
      call.end()
    }),
    400
  )
  assert.equal(secrets.length, 0)
  assert.equal((await fetch(valid)).status, 200)
  assert.equal((await callback.result).code, 'fixture-secret-code')
  assert.equal((await fetch(valid)).status, 400)
  assert.deepEqual(secrets, ['fixture-secret-code'])
  await callback.close()
  await portAvailable(valid)
})

test('error callbacks validate issuer/state and expose only fixed safe errors', async (t) => {
  const { callback, valid } = await callbackFixture(t)
  valid.searchParams.delete('code')
  valid.searchParams.set('error', 'access_denied')
  valid.searchParams.set('error_description', 'fixture-secret-description')
  valid.searchParams.set('iss', 'https://wrong.invalid')
  assert.equal((await fetch(valid)).status, 400)
  valid.searchParams.set('iss', issuer)
  assert.equal((await fetch(valid)).status, 200)
  await assert.rejects(callback.result, codeError('authorization-denied'))
})

test('optional iss may be omitted only when metadata does not require it', async (t) => {
  const { callback, valid } = await callbackFixture(t, { requireIssuer: false })
  valid.searchParams.delete('iss')
  assert.equal((await fetch(valid)).status, 200)
  assert.equal((await callback.result).iss, undefined)
})

test('callback port conflict and abort release all owned listeners', async (t) => {
  const blocker = createServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  t.onTestFinished(() => new Promise<void>((resolve) => blocker.close(() => resolve())))
  const abort = new AbortController()
  await assert.rejects(
    McpOAuthCallback.listen({
      state: 'state',
      issuer,
      requireIssuer: true,
      port: (blocker.address() as AddressInfo).port,
      signal: abort.signal,
      isActive: () => true,
      registerSecrets: () => {}
    }),
    codeError('callback-unavailable')
  )
  const { callback, valid, abort: cancel } = await callbackFixture(t)
  cancel.abort()
  await assert.rejects(callback.result, codeError('cancelled'))
  await callback.close()
  await portAvailable(valid)
})

test('malformed raw callback URL is rejected without crashing the owned server', async (t) => {
  const { callback, valid } = await callbackFixture(t)
  for (const path of ['/\\', '/%ZZ', '//other.invalid/path']) {
    const status = await new Promise((resolve, reject) => {
      const call = request(
        { hostname: valid.hostname, port: valid.port, path, headers: { Host: valid.host } },
        (response) => {
          response.resume()
          resolve(response.statusCode)
        }
      )
      call.once('error', reject)
      call.end()
    })
    assert.equal(status, 400)
  }
  assert.equal((await fetch(valid)).status, 200)
  assert.equal((await callback.result).code, 'fixture-secret-code')
})

test('immediate listener startup cancellation releases the configured port', async () => {
  const temporary = createServer()
  await new Promise<void>((resolve) => temporary.listen(0, '127.0.0.1', resolve))
  const port = (temporary.address() as AddressInfo).port
  await new Promise((resolve) => temporary.close(resolve))
  for (let i = 0; i < 10; i++) {
    const abort = new AbortController()
    const listening = McpOAuthCallback.listen({
      state: 'fixture-secret-state',
      issuer,
      requireIssuer: true,
      port,
      signal: abort.signal,
      isActive: () => true,
      registerSecrets: () => {}
    })
    abort.abort()
    await assert.rejects(listening, codeError('cancelled'))
    await portAvailable(new URL(`http://127.0.0.1:${port}/`))
  }
})
