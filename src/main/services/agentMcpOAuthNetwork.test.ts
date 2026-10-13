// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ayayaQ
// Vitest fixture adaptation of ayayaQ/vivi-cli at 38978a34adf1ae16ea2e61cbe15f9d8b01e1065c.
// https://github.com/ayayaQ/vivi-cli/blob/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c/test/mcp-oauth-registration.test.mjs
import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { FetchLike } from '@modelcontextprotocol/client'
import { McpOAuthError } from './agentMcpOAuthCallback'
import { createMcpOAuthFetch } from './agentMcpOAuthNetwork'

const issuer = 'https://auth.fixture.invalid'
const metadata = { registration_endpoint: `${issuer}/register` }
const safeError = (code: McpOAuthError['code']) => (error: unknown) =>
  error instanceof McpOAuthError &&
  error.code === code &&
  !/fixture-secret|provider-error/.test(error.message)

test('OAuth network seam consumes one POST, rejects unapproved endpoints and respects Request abort', async () => {
  const calls: Array<[string, Parameters<FetchLike>[1]]> = [],
    abort = new AbortController()
  const fetchFn = createMcpOAuthFetch({
    fetchFn: async (input, init) => {
      calls.push([String(input), init])
      return Response.json({})
    },
    signal: abort.signal,
    origins: [issuer],
    assertCurrent: () => {},
    postEndpoint: () => metadata.registration_endpoint,
    registerSecrets: () => {}
  })
  await assert.rejects(
    fetchFn(`${issuer}/token`, { method: 'POST' }),
    safeError('authorization-failed')
  )
  await assert.rejects(fetchFn('https://other.invalid'), safeError('authorization-failed'))
  // SDK FetchLike exposes string/URL, but this seam also respects native Request signals.
  const requestFetch = fetchFn as typeof fetch
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(
    requestFetch(
      new Request(metadata.registration_endpoint, { method: 'POST', signal: stopped.signal })
    ),
    safeError('cancelled')
  )
  await fetchFn(metadata.registration_endpoint, { method: 'POST' })
  await assert.rejects(
    fetchFn(metadata.registration_endpoint, { method: 'POST' }),
    safeError('authorization-failed')
  )
  assert.equal(calls.length, 1)
})
