import { describe, expect, it, vi } from 'vitest'
import { Client, Events, GatewayIntentBits, IntentsBitField, Partials } from 'discord.js'
import { DISCORD_DISALLOWED_INTENTS_ERROR } from '../../shared/discordSetup'
import {
  DiscordLoginLifetime,
  formatDiscordLoginError,
  getDiscordClientOptions
} from './discordGateway'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Use the installed discord.js Client and WebSocketManager. Only Discord REST
// and the socket strategy are stubbed, so these tests cannot use live networks.
function offlineClient() {
  const gateway = deferred<object>()
  const connecting = deferred<void>()
  const connectStarted = deferred<void>()
  const transportActive = deferred<void>()
  const connectSettled = deferred<void>()
  let active = false
  const transport = {
    spawn: vi.fn(async () => {}),
    connect: vi.fn(async () => {
      connectStarted.resolve(undefined)
      await connecting.promise
      active = true
      transportActive.resolve(undefined)
      await connectSettled.promise
    }),
    destroy: vi.fn(async () => {
      active = false
    }),
    send: vi.fn(),
    fetchStatus: vi.fn()
  }
  const client = new Client({
    ...getDiscordClientOptions(),
    ws: { buildStrategy: () => transport }
  })
  const fetchGateway = vi.spyOn(client.rest, 'get').mockImplementation(() => gateway.promise)
  const releaseGateway = () =>
    gateway.resolve({
      url: 'wss://offline.invalid',
      shards: 1,
      session_start_limit: {
        total: 100,
        remaining: 100,
        reset_after: 1000,
        max_concurrency: 1
      }
    })
  return {
    client,
    transport,
    fetchGateway,
    releaseGateway,
    connecting,
    connectStarted,
    transportActive,
    connectSettled,
    finishConnect: () => {
      connecting.resolve(undefined)
      connectSettled.resolve(undefined)
    },
    isActive: () => active
  }
}

describe('Discord login lifetime with the real client library', () => {
  it('cleans up a cancelled login after delayed gateway discovery without blocking cancellation', async () => {
    const offline = offlineClient()
    const onCleanupError = vi.fn()
    const lifetime = new DiscordLoginLifetime(offline.client, onCleanupError)
    const login = lifetime.login('offline-test-token')
    expect(lifetime.cancel()).toBeUndefined()
    expect(offline.transport.destroy).not.toHaveBeenCalled()

    offline.releaseGateway()
    await offline.connectStarted.promise
    offline.finishConnect()
    await login

    expect(offline.fetchGateway).toHaveBeenCalledOnce()
    expect(offline.transport.spawn).toHaveBeenCalledOnce()
    expect(offline.transport.connect).toHaveBeenCalledOnce()
    expect(offline.isActive()).toBe(false)
    expect(offline.client.token).toBeNull()
    expect(onCleanupError).not.toHaveBeenCalled()
  })

  it('cleans up cancellation while connect is pending, even if the transport becomes active later', async () => {
    const offline = offlineClient()
    const lifetime = new DiscordLoginLifetime(offline.client, vi.fn())
    const login = lifetime.login('offline-test-token')
    offline.releaseGateway()
    await offline.connectStarted.promise
    offline.transport.destroy.mockClear()

    lifetime.cancel()
    expect(offline.transport.destroy).not.toHaveBeenCalled()
    offline.finishConnect()
    await login

    expect(offline.transport.destroy).toHaveBeenCalledOnce()
    expect(offline.isActive()).toBe(false)
  })

  it('also cleans up a late ready event without waiting for login settlement', async () => {
    const offline = offlineClient()
    const lifetime = new DiscordLoginLifetime(offline.client, vi.fn())
    const login = lifetime.login('offline-test-token')
    offline.releaseGateway()
    await offline.connectStarted.promise
    lifetime.cancel()
    offline.transport.destroy.mockClear()

    offline.connecting.resolve(undefined)
    await offline.transportActive.promise
    offline.client.emit(Events.ClientReady, offline.client as Client<true>)
    expect(offline.transport.destroy).toHaveBeenCalledOnce()
    expect(offline.isActive()).toBe(false)
    offline.connectSettled.resolve(undefined)
    await login
    expect(offline.isActive()).toBe(false)
  })

  it('keeps an owned successful login active until explicitly cancelled', async () => {
    const offline = offlineClient()
    const lifetime = new DiscordLoginLifetime(offline.client, vi.fn())
    const login = lifetime.login('offline-test-token')
    offline.releaseGateway()
    offline.finishConnect()
    await login
    expect(offline.isActive()).toBe(true)

    lifetime.cancel()
    await vi.waitFor(() => expect(offline.isActive()).toBe(false))
  })

  it('observes cleanup failures instead of leaving rejected destruction promises unhandled', async () => {
    const offline = offlineClient()
    const onCleanupError = vi.fn()
    const lifetime = new DiscordLoginLifetime(offline.client, onCleanupError)
    const login = lifetime.login('offline-test-token')
    offline.releaseGateway()
    offline.finishConnect()
    await login
    const failure = new Error('offline cleanup failed')
    vi.spyOn(offline.client, 'destroy').mockRejectedValueOnce(failure)
    lifetime.cancel()
    await vi.waitFor(() => expect(onCleanupError).toHaveBeenCalledExactlyOnceWith(failure))
    await offline.client.destroy()
  })
})

describe('Discord Gateway configuration', () => {
  it('adds ban events while retaining every existing intent and partial', () => {
    const options = getDiscordClientOptions()
    const intents = new IntentsBitField(options.intents)
    expect(options.intents).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions
    ])
    expect(intents.has(GatewayIntentBits.GuildModeration)).toBe(true)
    expect(intents.has(GatewayIntentBits.GuildPresences)).toBe(false)
    expect(options.partials).toEqual([Partials.Channel, Partials.Message, Partials.Reaction])
  })

  it('returns independent options for each client', () => {
    const first = getDiscordClientOptions()
    const second = getDiscordClientOptions()
    expect(first).not.toBe(second)
    expect(first.intents).not.toBe(second.intents)
    expect(first.partials).not.toBe(second.partials)
  })
})

describe('Discord login errors', () => {
  it.each([
    { code: 4014, message: 'Gateway closed' },
    { code: '4014', message: 'Gateway closed' },
    { code: 'DisallowedIntents', message: 'Gateway closed' },
    { code: 'DISALLOWED_INTENTS', message: 'Gateway closed' },
    { name: 'DisallowedIntents', message: 'Gateway closed' },
    new Error('Used disallowed intents'),
    'Used disallowed intents',
    new Error('Privileged intent provided is not enabled or whitelisted.')
  ])('provides actionable setup instructions for %j', (error) => {
    expect(formatDiscordLoginError(error)).toBe(DISCORD_DISALLOWED_INTENTS_ERROR)
    expect(formatDiscordLoginError(error)).toContain(
      'Server Members Intent and Message Content Intent'
    )
    expect(formatDiscordLoginError(error)).toContain('save your changes')
    expect(formatDiscordLoginError(error)).toContain('approval')
  })

  it.each([
    [new Error('An invalid token was provided.'), 'Login failed: An invalid token was provided.'],
    [{ code: 4013, message: 'Used invalid intents' }, 'Login failed: Used invalid intents'],
    [{ code: '4013', message: 'Used invalid intents' }, 'Login failed: Used invalid intents'],
    [{ code: 4013, message: 'Used disallowed intents' }, 'Login failed: Used disallowed intents'],
    [
      new Error('getaddrinfo ENOTFOUND discord.com'),
      'Login failed: getaddrinfo ENOTFOUND discord.com'
    ],
    ['Network connection failed', 'Login failed: Network connection failed'],
    [null, 'Login failed: null']
  ])('preserves unrelated errors for %j', (error, expected) => {
    expect(formatDiscordLoginError(error)).toBe(expected)
  })
})
