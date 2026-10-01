import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BCFDCommand } from '../types/types'
import { Events } from 'discord.js'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  invalidate: vi.fn(),
  invalidateEdit: vi.fn(),
  settingsChanged: vi.fn(),
  log: vi.fn(),
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
    info: mocks.log,
    warning: mocks.log,
    error: mocks.log,
    success: mocks.log,
    event: mocks.log
  }
}))
vi.mock('./spamProtectionService', () => ({
  SpamProtectionService: class {
    check = mocks.check
    start = mocks.start
    stop = mocks.stop
    invalidate = mocks.invalidate
    invalidateEdit = mocks.invalidateEdit
    settingsChanged = mocks.settingsChanged
  }
}))

describe('bot message moderation integration', () => {
  let bot: typeof import('./botService')
  const event = { reply: vi.fn() } as unknown as Electron.IpcMainEvent
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    mocks.handlers.clear()
    bot = await import('./botService')
    bot.Connect(event, 'synthetic-token')
    await mocks.handlers.get(Events.ClientReady)!()
    bot.setCommands({
      bcfdCommands: [{ id: 'command', type: 0, command: '!test' } as BCFDCommand],
      bcfdSlashCommands: []
    })
    mocks.log.mockClear()
  })
  afterEach(() => bot.Disconnect(event))

  it.each(['allow', 'blocked', 'cancelled'])(
    'runs commands only after an allow verdict (%s)',
    async (result) => {
      let resolve!: (value: string) => void
      mocks.check.mockReturnValue(
        new Promise((done) => {
          resolve = done
        })
      )
      mocks.handlers.get(Events.MessageCreate)!({
        id: 'message',
        content: '!test',
        author: { bot: false },
        channel: {}
      })
      expect(mocks.log).not.toHaveBeenCalledWith('Executing command: "!test"')
      resolve(result)
      // Flush the asynchronous command path without a network or Electron process.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      if (result === 'allow') expect(mocks.log).toHaveBeenCalledWith('Executing command: "!test"')
      else expect(mocks.log).not.toHaveBeenCalledWith('Executing command: "!test"')
    }
  )

  it('forwards edits, individual deletions, bulk deletions, settings changes and disconnects', async () => {
    mocks.handlers.get(Events.MessageUpdate)!({}, { id: 'edited', content: 'changed' })
    mocks.handlers.get(Events.MessageDelete)!({ id: 'deleted' })
    mocks.handlers.get(Events.MessageBulkDelete)!(new Map([['bulk', {}]]))
    expect(mocks.invalidateEdit).toHaveBeenCalledWith('edited', 'changed')
    expect(mocks.invalidate.mock.calls).toEqual([['deleted'], ['bulk']])
    const { getSettings, setSettings } = await import('./settingsService')
    setSettings({ ...getSettings(), spamProtectionEnabled: true })
    expect(mocks.settingsChanged).toHaveBeenCalled()
    bot.Disconnect(event)
    expect(mocks.stop).toHaveBeenCalled()
  })
})
