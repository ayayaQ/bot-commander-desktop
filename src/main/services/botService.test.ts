import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Client,
  Events,
  GatewayIntentBits,
  IntentsBitField,
  Partials,
  type ClientOptions
} from 'discord.js'
import { DISCORD_DISALLOWED_INTENTS_ERROR } from '../../shared/discordSetup'

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  setCookie: vi.fn(),
  loadBotState: vi.fn(),
  saveBotState: vi.fn(),
  consoleError: vi.fn(),
  consoleInfo: vi.fn(),
  consoleSuccess: vi.fn(),
  consoleEvent: vi.fn(),
  stats: {
    updateUserCount: vi.fn(),
    updateServerCount: vi.fn(),
    updateCommandCount: vi.fn(),
    incrementMessagesReceived: vi.fn()
  }
}))

vi.mock('discord.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('discord.js')>()),
  Client: vi.fn(function (options: ClientOptions) {
    return mocks.createClient(options)
  })
}))
vi.mock('electron', () => ({
  session: { defaultSession: { cookies: { set: mocks.setCookie } } }
}))
vi.mock('../utils/virtual', () => ({
  loadBotState: mocks.loadBotState,
  saveBotState: mocks.saveBotState,
  getBotStateContext: vi.fn()
}))
vi.mock('./stringInfo', () => ({
  contextForMessageEvent: vi.fn(),
  contextForReactionEvent: vi.fn(),
  contextForInteractionEvent: vi.fn(),
  stringInfoAdd: vi.fn()
}))
vi.mock('../utils/rendererConsole', () => ({
  rendererConsole: {
    error: mocks.consoleError,
    info: mocks.consoleInfo,
    success: mocks.consoleSuccess,
    event: mocks.consoleEvent
  }
}))
vi.mock('../utils/stats', () => ({ getStatsInstance: () => mocks.stats }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

class FakeClient {
  listeners = new Map<string, ((...args: unknown[]) => unknown)[]>()
  pendingLogin = deferred<string>()
  login = vi.fn(() => this.pendingLogin.promise)
  destroy = vi.fn(async () => {})
  user = { username: 'test-bot', avatarURL: () => 'test-avatar', setPresence: vi.fn() }
  users = { cache: { size: 2 } }
  guilds = { cache: { size: 1 } }

  on(event: string, listener: (...args: unknown[]) => unknown) {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
    return this
  }

  once(event: string, listener: (...args: unknown[]) => unknown) {
    return this.on(event, listener)
  }

  async ready() {
    const ready = this.emit(Events.ClientReady)
    this.pendingLogin.resolve('test-token')
    await ready
  }

  async emit(event: string, ...args: unknown[]) {
    await Promise.all((this.listeners.get(event) ?? []).map((listener) => listener(...args)))
  }
}

async function flushLogin() {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function ipcEvent() {
  return { reply: vi.fn() } as unknown as Electron.IpcMainEvent
}

describe('botService Connect', () => {
  let clients: FakeClient[]

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.loadBotState.mockResolvedValue(undefined)
    clients = []
    mocks.createClient.mockImplementation(() => {
      const client = new FakeClient()
      clients.push(client)
      return client
    })
  })

  it('uses moderation and all existing intents/partials in the actual login path', async () => {
    const { Connect } = await import('./botService')
    Connect(ipcEvent(), 'test-token')

    const options = vi.mocked(Client).mock.calls[0][0]!
    expect(new IntentsBitField(options.intents).bitfield).toBe(
      new IntentsBitField([
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessageReactions
      ]).bitfield
    )
    expect(options.partials).toEqual([Partials.Channel, Partials.Message, Partials.Reaction])
    expect(clients[0].listeners.has(Events.GuildBanAdd)).toBe(true)
    expect(clients[0].listeners.has(Events.GuildMemberAdd)).toBe(true)
    expect(clients[0].listeners.has(Events.GuildMemberRemove)).toBe(true)
    expect(clients[0].login).toHaveBeenCalledWith('test-token')
  })

  it.each([
    new Error('Used disallowed intents'),
    { code: 4014, message: 'Gateway closed' },
    { code: '4014', message: 'Gateway closed' }
  ])('reports useful privileged-intent guidance and cleans up on %j', async (error) => {
    const { Connect, getClient } = await import('./botService')
    const event = ipcEvent()
    Connect(event, 'test-token')
    clients[0].pendingLogin.reject(error)
    await flushLogin()

    expect(event.reply).toHaveBeenCalledWith('connect-error', DISCORD_DISALLOWED_INTENTS_ERROR)
    expect(mocks.consoleError).toHaveBeenCalledWith(DISCORD_DISALLOWED_INTENTS_ERROR)
    expect(clients[0].destroy).toHaveBeenCalledOnce()
    expect(getClient()).toBeNull()
  })

  it.each([
    new Error('An invalid token was provided.'),
    { code: 4013, message: 'Used invalid intents' }
  ])('keeps the original details of unrelated login errors %j', async (error) => {
    const { Connect } = await import('./botService')
    const event = ipcEvent()
    Connect(event, 'test-token')
    clients[0].pendingLogin.reject(error)
    await flushLogin()

    expect(event.reply).toHaveBeenCalledWith('connect-error', `Login failed: ${error.message}`)
  })

  it('allows retry after failure and reports success from the new client', async () => {
    const { Connect, getClient } = await import('./botService')
    const event = ipcEvent()
    Connect(event, 'test-token')
    clients[0].pendingLogin.reject(new Error('Used disallowed intents'))
    await flushLogin()
    vi.mocked(event.reply).mockClear()

    Connect(event, 'test-token')
    await clients[1].ready()
    expect(getClient()).toBe(clients[1])
    expect(mocks.loadBotState).toHaveBeenCalledOnce()
    expect(event.reply).toHaveBeenCalledExactlyOnceWith('connect', {
      user: 'test-bot',
      avatar: 'test-avatar'
    })
  })

  it('ignores a stale failure after a repeated pending login', async () => {
    const { Connect, getClient } = await import('./botService')
    const oldEvent = ipcEvent()
    const newEvent = ipcEvent()
    Connect(oldEvent, 'old-test-token')
    Connect(newEvent, 'new-test-token')
    expect(clients[0].destroy).not.toHaveBeenCalled()

    clients[0].pendingLogin.reject(new Error('Used disallowed intents'))
    await flushLogin()
    expect(getClient()).toBe(clients[1])
    expect(clients[0].destroy).toHaveBeenCalledOnce()
    expect(clients[1].destroy).not.toHaveBeenCalled()
    expect(oldEvent.reply).not.toHaveBeenCalled()
    expect(newEvent.reply).not.toHaveBeenCalled()
  })

  it('ignores ready events from a replaced pending client', async () => {
    const { Connect, getClient } = await import('./botService')
    const oldEvent = ipcEvent()
    const newEvent = ipcEvent()
    Connect(oldEvent, 'old-test-token')
    Connect(newEvent, 'new-test-token')
    await clients[0].ready()
    await flushLogin()

    expect(getClient()).toBe(clients[1])
    expect(mocks.loadBotState).not.toHaveBeenCalled()
    expect(oldEvent.reply).not.toHaveBeenCalled()
    expect(clients[0].destroy).toHaveBeenCalledOnce()
    await clients[1].ready()
    expect(newEvent.reply).toHaveBeenCalledExactlyOnceWith('connect', {
      user: 'test-bot',
      avatar: 'test-avatar'
    })
  })

  it('does not report connected if disconnected while ready initialization is pending', async () => {
    const loading = deferred<void>()
    mocks.loadBotState.mockReturnValue(loading.promise)
    const { Connect, Disconnect, getClient } = await import('./botService')
    const event = ipcEvent()
    Connect(event, 'test-token')
    const ready = clients[0].ready()
    Disconnect(event)
    loading.resolve(undefined)
    await ready

    expect(getClient()).toBeNull()
    expect(event.reply).toHaveBeenCalledExactlyOnceWith('disconnect')
  })

  it('ignores login rejection after an explicit disconnect', async () => {
    const { Connect, Disconnect } = await import('./botService')
    const event = ipcEvent()
    Connect(event, 'test-token')
    Disconnect(event)
    clients[0].pendingLogin.reject(new Error('Used disallowed intents'))
    await flushLogin()

    expect(event.reply).toHaveBeenCalledExactlyOnceWith('disconnect')
    expect(clients[0].destroy).toHaveBeenCalledOnce()
    expect(mocks.consoleError).not.toHaveBeenCalled()
  })

  it('quarantines every obsolete event before accessing its data or bot actions', async () => {
    const { Connect } = await import('./botService')
    Connect(ipcEvent(), 'old-test-token')
    Connect(ipcEvent(), 'new-test-token')
    await clients[1].ready()

    for (const event of [
      Events.MessageCreate,
      Events.GuildMemberAdd,
      Events.GuildMemberRemove,
      Events.GuildBanAdd,
      Events.MessageReactionAdd,
      Events.InteractionCreate
    ]) {
      // No payload is safe only when the obsolete listener returns immediately.
      await clients[0].emit(event)
    }

    expect(mocks.stats.incrementMessagesReceived).not.toHaveBeenCalled()
    expect(mocks.consoleEvent).not.toHaveBeenCalled()
    await clients[0].ready()
    await flushLogin()
    expect(clients[0].destroy).toHaveBeenCalledOnce()
  })

  it('does not run actions before state initialization and still handles current events', async () => {
    const loading = deferred<void>()
    mocks.loadBotState.mockReturnValue(loading.promise)
    const { Connect } = await import('./botService')
    Connect(ipcEvent(), 'test-token')
    const ready = clients[0].ready()
    await clients[0].emit(Events.MessageCreate)
    expect(mocks.stats.incrementMessagesReceived).not.toHaveBeenCalled()
    loading.resolve(undefined)
    await ready

    await clients[0].emit(Events.MessageCreate, {
      author: { bot: true }
    })
    expect(mocks.stats.incrementMessagesReceived).toHaveBeenCalledOnce()
  })

  it('invalidates pending state restoration when a newer login replaces its owner', async () => {
    const loading = deferred<void>()
    mocks.loadBotState.mockReturnValueOnce(loading.promise)
    const { Connect } = await import('./botService')
    const oldEvent = ipcEvent()
    Connect(oldEvent, 'old-test-token')
    const oldReady = clients[0].ready()
    const shouldApply = mocks.loadBotState.mock.calls[0][0] as () => boolean
    expect(shouldApply()).toBe(true)

    Connect(ipcEvent(), 'new-test-token')
    expect(shouldApply()).toBe(false)
    await clients[0].emit(Events.MessageCreate)
    loading.resolve(undefined)
    await oldReady
    expect(oldEvent.reply).not.toHaveBeenCalled()
    expect(mocks.stats.incrementMessagesReceived).not.toHaveBeenCalled()
  })
})
