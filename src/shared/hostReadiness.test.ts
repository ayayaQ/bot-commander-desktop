import { describe, expect, it, vi } from 'vitest'
import { emptyPublicationState } from './interactionPublication'
import {
  readHostReadiness,
  unavailableHostReadiness,
  type HostReadinessSnapshot
} from './hostReadiness'

const now = Date.UTC(2026, 9, 5)
const secret = 'SENSITIVE-test-secret https://user:password@example.test/?token=SENSITIVE'

function snapshot(): HostReadinessSnapshot {
  return {
    connection: {
      attempt: 'never-attempted',
      failure: null,
      observedAt: null,
      servingReady: false,
      gatewayReady: false,
      guildCount: null
    },
    commandCount: 3,
    interactionCount: 2,
    localRegisteredCount: 1,
    publication: { state: emptyPublicationState(), observedAt: null }
  }
}

function project(change: (value: HostReadinessSnapshot) => void = () => {}) {
  const value = snapshot()
  change(value)
  return readHostReadiness(() => value, now)
}

describe('redacted local host readiness projection', () => {
  it('reports local observation, never-attempted login and unknown remote proof', () => {
    const result = project()
    expect(result).toMatchObject({
      schemaVersion: 1,
      observation: 'local-cache',
      observedAt: '2026-10-05T00:00:00.000Z',
      status: 'available',
      freshness: 'unknown',
      login: { state: 'never-attempted', failure: null, observedAt: null },
      connection: { state: 'disconnected', servingReady: false, cachedGuildCount: null },
      gateway: { state: 'not-ready', portalPermissions: 'unknown' },
      publication: {
        state: 'not-observed',
        operation: null,
        remoteRegistration: 'unknown',
        freshness: 'unknown',
        localRegisteredCount: 1
      }
    })
    expect(result.nextActions[0]).toMatchObject({ control: 'Login sidebar', action: 'connect' })
  })

  it.each(['pending', 'initializing'] as const)(
    'never equates gateway ready with serving-ready during %s',
    (attempt) => {
      const result = project((value) => {
        Object.assign(value.connection, { attempt, gatewayReady: true, observedAt: now - 1000 })
      })
      expect(result.login).toEqual({
        state: attempt,
        failure: null,
        observedAt: '2026-10-04T23:59:59.000Z'
      })
      expect(result.gateway.state).toBe('ready')
      expect(result.connection).toMatchObject({ state: 'connecting', servingReady: false })
      expect(result.nextActions[0].action).toBe('wait')
    }
  )

  it('requires the local serving latch and gateway, and truthfully reflects stale/recovery snapshots', () => {
    const value = snapshot()
    Object.assign(value.connection, {
      attempt: 'ready',
      servingReady: true,
      gatewayReady: true,
      guildCount: 4
    })
    expect(readHostReadiness(() => value, now).connection).toEqual({
      state: 'ready',
      servingReady: true,
      cachedGuildCount: 4
    })
    value.connection.gatewayReady = false
    const stale = readHostReadiness(() => value, now)
    expect(stale.connection).toEqual({ state: 'stale', servingReady: false, cachedGuildCount: 4 })
    expect(stale.nextActions[0].action).toBe('review-connection')
    value.connection.gatewayReady = true
    expect(readHostReadiness(() => value, now).connection.state).toBe('ready')
  })

  it('keeps serving readiness unknown when gateway observation is unknown', () => {
    const result = project((value) =>
      Object.assign(value.connection, {
        attempt: 'ready',
        servingReady: true,
        gatewayReady: null
      })
    )
    expect(result.connection).toMatchObject({ state: 'unknown', servingReady: null })
    expect(result.gateway.state).toBe('unknown')
  })

  it.each(['login-failed', 'state-load-failed'] as const)(
    'reports only the fixed current %s category',
    (failure) => {
      const result = project((value) =>
        Object.assign(value.connection, { attempt: 'failed', failure, observedAt: now })
      )
      expect(result.login).toEqual({
        state: 'failed',
        failure,
        observedAt: '2026-10-05T00:00:00.000Z'
      })
      expect(result.connection.state).toBe('disconnected')
      expect(result.nextActions[0].action).toBe('review-connection')
    }
  )

  it('reports explicit disconnect without inventing current remote publication proof', () => {
    const result = project((value) => {
      value.connection.attempt = 'disconnected'
      value.publication.state.completed = true
      value.publication.observedAt = now - 60_000
    })
    expect(result.connection.state).toBe('disconnected')
    expect(result.publication).toMatchObject({
      state: 'succeeded',
      observedAt: '2026-10-04T23:59:00.000Z',
      remoteRegistration: 'unknown',
      freshness: 'unknown'
    })
    expect(result.nextActions.at(-1)!.guidance).toContain(
      'past success are not current remote proof'
    )
  })

  it.each([
    { patch: { busy: true, pendingIds: ['secret-id'] }, state: 'running' },
    { patch: { completed: true }, state: 'succeeded' },
    { patch: { completed: true, staleIds: ['secret-id'] }, state: 'stale' },
    { patch: { completed: true, failedIds: ['secret-id'] }, state: 'failed' },
    { patch: { completed: true, error: { code: 'discord', detail: secret } }, state: 'failed' },
    {
      patch: {
        completed: true,
        targets: [{ guildId: secret, commandIds: [], error: { code: 'network', detail: secret } }]
      },
      state: 'failed'
    },
    {
      patch: {
        completed: true,
        targets: [
          { guildId: secret, commandIds: [], error: { code: 'network', detail: secret } },
          { guildId: secret, commandIds: [] }
        ]
      },
      state: 'partial-failure'
    }
  ])('projects publication $state with no raw failure or ID output', ({ patch, state }) => {
    const result = project((value) => Object.assign(value.publication.state, patch))
    expect(result.publication.state).toBe(state)
    expect(result.publication.remoteRegistration).toBe('unknown')
    expect(result.publication.freshness).toBe('unknown')
    expect(result.publication.failedTargetCount).toBe(
      patch.targets?.filter((target) => 'error' in target).length ?? 0
    )
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('secret-id')
  })

  it('counts every empty failed target even when failed IDs are empty and top-level failure is present', () => {
    const result = project((value) =>
      Object.assign(value.publication.state, {
        completed: true,
        error: { code: 'save-failed', detail: secret },
        failedIds: [],
        targets: [
          { guildId: secret, commandIds: [], error: { code: 'permissions', detail: secret } },
          { guildId: secret, commandIds: [], error: { code: 'discord', detail: secret } }
        ]
      })
    )
    expect(result.publication).toMatchObject({
      state: 'failed',
      failedCount: 0,
      failedTargetCount: 2,
      targetCount: 2
    })
  })

  it('projects only allowlisted keys and never touches secret-bearing extra fields or error details', () => {
    const value = snapshot()
    const trap = vi.fn(() => {
      throw new Error(secret)
    })
    for (const object of [value, value.connection, value.publication, value.publication.state]) {
      for (const key of ['token', 'cookies', 'name', 'id', 'url', 'stack', 'credentials'])
        Object.defineProperty(object, key, { get: trap })
    }
    value.publication.state.error = { code: 'discord' }
    Object.defineProperty(value.publication.state.error, 'detail', { get: trap })
    const result = readHostReadiness(() => value, now)
    expect(result.status).toBe('available')
    expect(trap).not.toHaveBeenCalled()
    expect(Object.keys(result)).toEqual([
      'schemaVersion',
      'observation',
      'observedAt',
      'status',
      'freshness',
      'login',
      'connection',
      'gateway',
      'resources',
      'publication',
      'nextActions'
    ])
    expect(Object.keys(result.publication)).toEqual([
      'state',
      'operation',
      'observedAt',
      'freshness',
      'remoteRegistration',
      'localRegisteredCount',
      'pendingCount',
      'failedCount',
      'failedTargetCount',
      'staleCount',
      'targetCount'
    ])
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each(['snapshot', 'connection', 'publication', 'error', 'target-error'])(
    'returns fixed unavailable output when a %s getter throws secrets',
    (location) => {
      const value = snapshot()
      const fail = () => {
        throw new Error(secret)
      }
      if (location === 'connection')
        Object.defineProperty(value.connection, 'gatewayReady', { get: fail })
      if (location === 'publication')
        Object.defineProperty(value.publication, 'state', { get: fail })
      if (location === 'error')
        Object.defineProperty(value.publication.state, 'error', { get: fail })
      if (location === 'target-error') {
        const target = { guildId: secret, commandIds: [] }
        Object.defineProperty(target, 'error', { get: fail })
        value.publication.state.targets = [target]
      }
      const result = readHostReadiness(location === 'snapshot' ? fail : () => value, now)
      expect(result).toEqual(unavailableHostReadiness(now))
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  )

  it('rejects unsafe enum/numeric/timestamp fields without string conversion', () => {
    const result = project((value) => {
      Object.assign(value.connection, {
        attempt: secret,
        failure: secret,
        observedAt: secret,
        guildCount: NaN,
        gatewayReady: secret
      })
      Object.assign(value, {
        commandCount: Infinity,
        interactionCount: -1,
        localRegisteredCount: 1e12
      })
      Object.assign(value.publication, { observedAt: secret })
      Object.assign(value.publication.state, { operation: secret })
    })
    expect(result.login).toEqual({ state: 'unknown', failure: null, observedAt: null })
    expect(result.resources).toEqual({ commandCount: null, interactionCount: null })
    expect(result.publication).toMatchObject({
      operation: null,
      observedAt: null,
      localRegisteredCount: 1e12
    })
    expect(result.gateway.state).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it.each([
    { busy: 'SENSITIVE-test-secret' },
    { completed: 'SENSITIVE-test-secret' },
    { pendingIds: { length: 12 } },
    { failedIds: 'secret' },
    { staleIds: null },
    { targets: { length: 5 } },
    { targets: [null] },
    { targets: [{ commandIds: 'secret' }] },
    { targets: [{ commandIds: [], error: 'secret' }] },
    { error: 'secret' }
  ])('fails closed for malformed publication observations %j', (patch) => {
    const value = snapshot()
    Object.assign(value.publication.state, patch)
    expect(readHostReadiness(() => value, now)).toEqual(unavailableHostReadiness(now))
  })

  it('captures allowlisted values once, so changing accessors cannot bypass validation', () => {
    const value = snapshot()
    let reads = 0
    Object.defineProperty(value.connection, 'attempt', {
      get: () => (++reads === 1 ? 'pending' : secret)
    })
    let operationReads = 0
    Object.defineProperty(value.publication.state, 'operation', {
      get: () => (++operationReads === 1 ? 'sync' : secret)
    })
    const result = readHostReadiness(() => value, now)
    expect(result.login.state).toBe('pending')
    expect(result.publication.operation).toBeNull()
    expect(reads).toBe(1)
    expect(operationReads).toBe(1)
  })
})
