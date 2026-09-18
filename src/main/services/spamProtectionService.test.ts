import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageType, PermissionsBitField } from 'discord.js'
import type { Message } from 'discord.js'
import type { AppSettings } from '../types/types'
import { OpenRouterDecisionError, classifySpamWithOpenRouter } from './aiProviderService'
import { SpamProtectionService, SPAM_LIMITS } from './spamProtectionService'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

let nextId = 0
function message(
  options: {
    content?: string
    author?: string
    channel?: string
    guild?: string
    moderator?: bigint
    botPermission?: boolean
  } = {}
) {
  const member = { id: options.author || 'human' }
  const bot = { id: 'bot' }
  return {
    id: String(nextId++),
    content: options.content ?? 'hello',
    author: { id: member.id, bot: false },
    member,
    guildId: options.guild || 'server',
    guild: { ownerId: 'owner', members: { me: bot } },
    channelId: options.channel || 'channel',
    channel: {
      permissionsFor: vi.fn(
        (who) =>
          new PermissionsBitField(
            who === bot
              ? options.botPermission === false
                ? 0n
                : PermissionsBitField.Flags.ManageMessages
              : options.moderator || 0n
          )
      )
    },
    inGuild: () => true,
    type: MessageType.Default,
    delete: vi.fn().mockResolvedValue(undefined)
  } as unknown as Message
}

describe('SpamProtectionService', () => {
  let settings: AppSettings
  let classify: ReturnType<typeof vi.fn<typeof classifySpamWithOpenRouter>>
  let logger: {
    info: ReturnType<typeof vi.fn<(message: string) => void>>
    warning: ReturnType<typeof vi.fn<(message: string) => void>>
  }
  let service: SpamProtectionService
  beforeEach(() => {
    vi.useFakeTimers()
    settings = { spamProtectionEnabled: true, openrouterApiKey: 'test-key' } as AppSettings
    classify = vi.fn().mockResolvedValue({ probability: 0.1, model: 'typesafe/jev-1.13' })
    logger = { info: vi.fn(), warning: vi.fn() }
    service = new SpamProtectionService({ getSettings: () => settings, classify, logger })
    service.start()
  })
  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  it.each([0, 0.9499, 0.95, 1])('deletes only at the 95%% boundary (%s)', async (probability) => {
    classify.mockResolvedValue({ probability, model: 'typesafe/jev-1.13' })
    const incoming = message()
    expect(await service.check(incoming)).toBe(probability >= 0.95 ? 'blocked' : 'allow')
    expect(incoming.delete).toHaveBeenCalledTimes(probability >= 0.95 ? 1 : 0)
  })

  it.each([
    'disabled',
    'key',
    'dm',
    'bot',
    'webhook',
    'owner',
    'member',
    'system',
    'empty',
    'permission'
  ])('skips %s without API usage', async (kind) => {
    const incoming = message({ botPermission: kind !== 'permission' })
    if (kind === 'disabled') settings.spamProtectionEnabled = false
    if (kind === 'key') settings.openrouterApiKey = ''
    if (kind === 'dm') incoming.inGuild = (() => false) as typeof incoming.inGuild
    if (kind === 'bot') incoming.author.bot = true
    if (kind === 'webhook') incoming.webhookId = 'webhook'
    if (kind === 'owner') incoming.author.id = 'owner'
    if (kind === 'member') Object.assign(incoming, { member: null })
    if (kind === 'system') incoming.type = MessageType.UserJoin
    if (kind === 'empty') incoming.content = '  '
    expect(await service.check(incoming)).toBe('allow')
    expect(classify).not.toHaveBeenCalled()
  })

  it.each([
    PermissionsBitField.Flags.Administrator,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.ModerateMembers
  ])('exempts moderator permission %s', async (moderator) => {
    expect(await service.check(message({ moderator }))).toBe('allow')
    expect(classify).not.toHaveBeenCalled()
  })

  it('captures preceding history synchronously across channels, but isolates authors and servers', async () => {
    const pending = deferred<{ probability: number; model: string }>()
    classify.mockReturnValue(pending.promise)
    const first = service.check(message({ content: 'first', channel: 'one' }))
    const second = service.check(message({ content: 'second', channel: 'two' }))
    const otherAuthor = service.check(message({ author: 'other' }))
    const otherServer = service.check(message({ guild: 'other' }))
    expect(classify.mock.calls[1][1].recentMessages).toEqual([
      { text: 'first', ageMs: 0, sameChannel: false }
    ])
    expect(classify.mock.calls[2][1].recentMessages).toEqual([])
    expect(classify.mock.calls[3][1].recentMessages).toEqual([])
    pending.resolve({ probability: 0.1, model: 'jev' })
    await Promise.all([first, second, otherAuthor, otherServer])
  })

  it('bounds and expires history, and deletes only the incoming message', async () => {
    const originals: Message[] = []
    for (let i = 0; i < 12; i++) {
      const incoming = message({ content: 'x'.repeat(2000) })
      originals.push(incoming)
      await service.check(incoming)
    }
    expect(classify.mock.lastCall![1].recentMessages).toHaveLength(10)
    expect(classify.mock.lastCall![1].recentMessages[0].text).toHaveLength(1000)
    classify.mockResolvedValue({ probability: 0.99, model: 'jev' })
    await service.check(message())
    for (const original of originals) expect(original.delete).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SPAM_LIMITS.historyMs)
    await service.check(message())
    expect(classify.mock.lastCall![1].recentMessages).toEqual([])
  })

  it('evicts the oldest author when the history author cap is exceeded', async () => {
    for (let i = 0; i <= SPAM_LIMITS.historyAuthors; i++)
      await service.check(message({ author: `author-${i}` }))
    await service.check(message({ author: 'author-0' }))
    expect(classify.mock.lastCall![1].recentMessages).toEqual([])
  })

  it.each(['disable', 'key', 'disconnect', 'edit', 'delete'])(
    'invalidates pending work on %s, even if the provider ignores abort',
    async (action) => {
      const pending = deferred<{ probability: number; model: string }>()
      classify.mockReturnValue(pending.promise)
      const incoming = message()
      const result = service.check(incoming)
      if (action === 'disable' || action === 'key') {
        const previous = { ...settings }
        settings = {
          ...settings,
          ...(action === 'disable'
            ? { spamProtectionEnabled: false }
            : { openrouterApiKey: 'replacement' })
        }
        service.settingsChanged(settings, previous)
      } else if (action === 'disconnect') service.stop()
      else service.invalidate(incoming.id)
      expect(await result).toBe(action === 'disable' || action === 'key' ? 'allow' : 'cancelled')
      expect(classify.mock.calls[0][2].aborted).toBe(true)
      pending.resolve({ probability: 1, model: 'jev' })
      await Promise.resolve()
      expect(incoming.delete).not.toHaveBeenCalled()
    }
  )

  it('rechecks permissions after classification', async () => {
    const pending = deferred<{ probability: number; model: string }>()
    classify.mockReturnValue(pending.promise)
    const incoming = message()
    const result = service.check(incoming)
    vi.mocked(
      incoming.channel as unknown as { permissionsFor: ReturnType<typeof vi.fn> }
    ).permissionsFor.mockReturnValue(new PermissionsBitField(0n))
    pending.resolve({ probability: 1, model: 'jev' })
    expect(await result).toBe('allow')
    expect(incoming.delete).not.toHaveBeenCalled()
  })

  it.each([50013, 10008])(
    'suppresses commands if deletion fails with %s, without retrying',
    async (code) => {
      classify.mockResolvedValue({ probability: 1, model: 'jev' })
      const incoming = message()
      vi.mocked(incoming.delete).mockRejectedValue({ code })
      expect(await service.check(incoming)).toBe('blocked')
      await Promise.resolve()
      expect(incoming.delete).toHaveBeenCalledTimes(1)
      expect(logger.warning).toHaveBeenCalledTimes(code === 10008 ? 0 : 1)
    }
  )

  it('limits concurrency, skips overflow, and includes queue time in the deadline', async () => {
    classify.mockReturnValue(new Promise(() => {}))
    const results = Array.from({ length: 54 }, () => service.check(message()))
    expect(classify).toHaveBeenCalledTimes(4)
    expect(await service.check(message())).toBe('allow')
    await vi.advanceTimersByTimeAsync(3000)
    expect(await Promise.all(results)).toEqual(Array(54).fill('allow'))
    expect(classify.mock.calls.every((call) => call[2].aborted)).toBe(true)
  })

  it('backs off on 429 and resumes after Retry-After', async () => {
    classify.mockRejectedValueOnce(new OpenRouterDecisionError(429, 10_000))
    expect(await service.check(message())).toBe('allow')
    await service.check(message())
    expect(classify).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await service.check(message())
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it.each([401, 402, 403])('pauses on %s until settings change', async (status) => {
    classify.mockRejectedValueOnce(new OpenRouterDecisionError(status))
    await service.check(message())
    await vi.advanceTimersByTimeAsync(60_000)
    await service.check(message())
    expect(classify).toHaveBeenCalledTimes(1)
    service.settingsChanged(settings, settings)
    await service.check(message())
    expect(classify).toHaveBeenCalledTimes(2)
  })

  it('pauses after three failures, resumes, and never logs provider bodies', async () => {
    classify.mockRejectedValue(new Error('private body and test-key'))
    for (let i = 0; i < 4; i++) expect(await service.check(message())).toBe('allow')
    expect(classify).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    classify.mockResolvedValue({ probability: 0, model: 'jev' })
    await service.check(message())
    expect(classify).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(logger.warning.mock.calls)).not.toMatch(/private body|test-key/)
  })
})
