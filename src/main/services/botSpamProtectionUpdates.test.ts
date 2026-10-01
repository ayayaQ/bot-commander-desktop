import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Events, MessageType, PermissionsBitField } from 'discord.js'
import type { Message } from 'discord.js'

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('discord.js', async (original) => ({
  ...(await original<typeof import('discord.js')>()),
  Client: class {
    user = { username: 'test', avatarURL: () => '', setPresence: vi.fn() }
    users = { cache: new Map() }
    guilds = { cache: new Map() }
    on(event: string, listener: (...args: unknown[]) => unknown) {
      mocks.handlers.set(event, listener)
    }
    once(event: string, listener: (...args: unknown[]) => unknown) {
      this.on(event, listener)
    }
    login() {
      return Promise.resolve('test')
    }
    async destroy() {}
  }
}))
vi.mock('electron', () => ({ session: { defaultSession: { cookies: { set: vi.fn() } } } }))
vi.mock('../utils/virtual', () => ({
  getBotStateContext: vi.fn(),
  loadBotState: vi.fn(),
  saveBotState: vi.fn()
}))
vi.mock('./interactionService', () => ({
  findInteractionByCommandName: vi.fn(),
  findInteractionByButtonId: vi.fn()
}))
vi.mock('./statusService', () => ({ getBotStatus: () => ({ status: 'Online', activity: 'None' }) }))
vi.mock('./stringInfo', () => ({
  contextForMessageEvent: vi.fn(),
  contextForReactionEvent: vi.fn(),
  contextForInteractionEvent: vi.fn(),
  stringInfoAdd: vi.fn()
}))
vi.mock('../utils/rendererConsole', () => ({
  rendererConsole: {
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    event: vi.fn()
  }
}))
vi.mock('./settingsService', () => ({
  getSettings: () => ({ spamProtectionEnabled: true, openrouterApiKey: 'synthetic-key' }),
  onSettingsChanged: vi.fn()
}))
vi.mock('./aiProviderService', async (original) => ({
  ...(await original<typeof import('./aiProviderService')>()),
  classifySpamWithOpenRouter: mocks.classify
}))

function incomingMessage() {
  const member = { id: 'human' }
  const me = { id: 'bot' }
  return {
    id: 'message',
    content: 'synthetic spam https://example.invalid/claim',
    author: { id: 'human', bot: false },
    member,
    guildId: 'server',
    guild: { ownerId: 'owner', members: { me } },
    channelId: 'channel',
    channel: {
      permissionsFor: (who: unknown) =>
        new PermissionsBitField(who === me ? PermissionsBitField.Flags.ManageMessages : 0n)
    },
    inGuild: () => true,
    type: MessageType.Default,
    embeds: [],
    editedTimestamp: null,
    delete: vi.fn().mockResolvedValue(undefined)
  } as unknown as Message
}

async function flushMessages() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('bot moderation message updates', () => {
  let bot: typeof import('./botService')
  let resolve: (value: { probability: number; model: string }) => void
  let incoming: Message
  const event = { reply: vi.fn() } as unknown as Electron.IpcMainEvent

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.resetModules()
    vi.clearAllMocks()
    mocks.handlers.clear()
    mocks.classify.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    bot = await import('./botService')
    bot.Connect(event, 'synthetic-token')
    await mocks.handlers.get(Events.ClientReady)!()
    incoming = incomingMessage()
    mocks.handlers.get(Events.MessageCreate)!(incoming)
    expect(mocks.classify).toHaveBeenCalledTimes(1)
  })

  afterEach(() => {
    bot.Disconnect(event)
    vi.useRealTimers()
  })

  it.each(['preview', 'partial-old', 'partial-new', 'timestamp-only'])(
    'still deletes flagged content after a %s update',
    async (kind) => {
      const old = kind === 'partial-old' ? { id: incoming.id, content: null } : incoming
      const updated =
        kind === 'partial-new'
          ? { id: incoming.id, content: null }
          : {
              ...incoming,
              embeds: [{ title: 'link preview' }],
              editedTimestamp: kind === 'timestamp-only' ? Date.now() : null
            }
      mocks.handlers.get(Events.MessageUpdate)!(old, updated)
      expect(mocks.classify.mock.calls[0][2].aborted).toBe(false)
      resolve({ probability: 1, model: 'jev' })
      await flushMessages()
      expect(incoming.delete).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['content', 'empty', 'partial-old', 'partial-new', 'in-place'])(
    'cancels an actual %s edit even when the provider ignores abort',
    async (kind) => {
      const old = kind === 'partial-old' ? { id: incoming.id, content: null } : { ...incoming }
      const content = kind === 'empty' ? '' : 'edited content'
      const updated =
        kind === 'partial-new'
          ? { id: incoming.id, content, author: null }
          : kind === 'in-place'
            ? Object.assign(incoming, { content })
            : { ...incoming, content }
      mocks.handlers.get(Events.MessageUpdate)!(old, updated)
      expect(mocks.classify.mock.calls[0][2].aborted).toBe(true)
      resolve({ probability: 1, model: 'jev' })
      await flushMessages()
      expect(incoming.delete).not.toHaveBeenCalled()
    }
  )

  it.each(['individual', 'bulk'])('still cancels a %s deletion', async (kind) => {
    if (kind === 'individual')
      mocks.handlers.get(Events.MessageDelete)!({ id: incoming.id, content: null })
    else mocks.handlers.get(Events.MessageBulkDelete)!(new Map([[incoming.id, {}]]))
    expect(mocks.classify.mock.calls[0][2].aborted).toBe(true)
    resolve({ probability: 1, model: 'jev' })
    await flushMessages()
    expect(incoming.delete).not.toHaveBeenCalled()
  })
})
