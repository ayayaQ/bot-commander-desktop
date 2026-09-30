import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events, GatewayIntentBits, IntentsBitField, type ClientOptions } from 'discord.js'

const mocks = vi.hoisted(() => ({
  options: [] as unknown[],
  on: vi.fn(),
  once: vi.fn(),
  login: vi.fn(),
  destroy: vi.fn(),
  error: vi.fn()
}))
vi.mock('discord.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('discord.js')>()),
  Client: class {
    constructor(options: unknown) {
      mocks.options.push(options)
    }
    on = mocks.on
    once = mocks.once
    login = mocks.login
    destroy = mocks.destroy
  }
}))
vi.mock('electron', () => ({
  session: { defaultSession: { cookies: { set: vi.fn().mockResolvedValue(undefined) } } }
}))
vi.mock('./interactionService', () => ({
  findInteractionByCommandName: vi.fn(),
  findInteractionByButtonId: vi.fn()
}))
vi.mock('../utils/virtual', () => ({
  getBotStateContext: vi.fn(),
  loadBotState: vi.fn(),
  saveBotState: vi.fn()
}))
vi.mock('./statusService', () => ({ getBotStatus: vi.fn() }))
vi.mock('./stringInfo', () => ({
  contextForMessageEvent: vi.fn(),
  contextForReactionEvent: vi.fn(),
  contextForInteractionEvent: vi.fn(),
  stringInfoAdd: vi.fn()
}))
vi.mock('../utils/stats', () => ({ getStatsInstance: vi.fn() }))
vi.mock('./cooldownManager', () => ({ getCooldownManager: vi.fn() }))
vi.mock('../utils/rendererConsole', () => ({ rendererConsole: { error: mocks.error, info: vi.fn() } }))

import { Connect, Disconnect, getClient } from './botService'

const reply = vi.fn()
const event = { reply } as unknown as Electron.IpcMainEvent

beforeEach(() => {
  vi.clearAllMocks()
  mocks.options.length = 0
  mocks.login.mockResolvedValue('test-token')
})
afterEach(() => Disconnect(event))

describe('Discord connection wiring', () => {
  it('passes the event intents to the actual client constructor', () => {
    Connect(event, 'test-token')
    const options = mocks.options[0] as ClientOptions
    const intents = new IntentsBitField(options.intents)
    for (const [name, intent] of [
      [Events.GuildBanAdd, GatewayIntentBits.GuildModeration],
      [Events.GuildMemberAdd, GatewayIntentBits.GuildMembers],
      [Events.GuildMemberRemove, GatewayIntentBits.GuildMembers],
      [Events.MessageCreate, GatewayIntentBits.GuildMessages],
      [Events.MessageReactionAdd, GatewayIntentBits.GuildMessageReactions]
    ] as const) {
      expect(mocks.on).toHaveBeenCalledWith(name, expect.any(Function))
      expect(intents.has(intent)).toBe(true)
    }
    expect(mocks.login).toHaveBeenCalledExactlyOnceWith('test-token')
  })

  it('reports actionable disallowed-intent errors, cleans up, and permits retry', async () => {
    mocks.login.mockRejectedValueOnce(new Error('Used disallowed intents'))
    Connect(event, 'test-token')
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith('connect-error', expect.any(String)))
    expect(reply.mock.calls[0][1]).toContain('Server Members Intent and Message Content Intent')
    expect(mocks.error).toHaveBeenCalledWith(reply.mock.calls[0][1])
    expect(mocks.destroy).toHaveBeenCalledOnce()
    expect(getClient()).toBeNull()
    Connect(event, 'test-token')
    expect(mocks.login).toHaveBeenCalledTimes(2)
    expect(getClient()).not.toBeNull()
  })

  it('keeps authentication errors distinct from intent configuration errors', async () => {
    mocks.login.mockRejectedValueOnce(new Error('An invalid token was provided.'))
    Connect(event, 'test-token')
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith(
        'connect-error',
        'Login failed: An invalid token was provided.'
      )
    )
    expect(getClient()).toBeNull()
  })
})
