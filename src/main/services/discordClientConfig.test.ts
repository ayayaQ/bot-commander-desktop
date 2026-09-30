import { describe, expect, it } from 'vitest'
import { Events, GatewayIntentBits, IntentsBitField, Partials } from 'discord.js'
import { createDiscordClientOptions, formatDiscordLoginError } from './discordClientConfig'

describe('Discord Gateway configuration', () => {
  const eventIntents = [
    [Events.GuildMemberAdd, GatewayIntentBits.GuildMembers],
    [Events.GuildMemberRemove, GatewayIntentBits.GuildMembers],
    [Events.GuildBanAdd, GatewayIntentBits.GuildModeration],
    [Events.MessageCreate, GatewayIntentBits.GuildMessages],
    [Events.MessageCreate, GatewayIntentBits.DirectMessages],
    [Events.MessageReactionAdd, GatewayIntentBits.GuildMessageReactions]
  ] as const

  it.each(eventIntents)('subscribes to the intent for %s (%s)', (_event, intent) => {
    expect(new IntentsBitField(createDiscordClientOptions().intents).has(intent)).toBe(true)
  })

  it('preserves content access and partials without adding unused privileged intents', () => {
    const options = createDiscordClientOptions()
    expect(new IntentsBitField(options.intents).bitfield).toBe(
      new IntentsBitField(
        [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMembers,
          GatewayIntentBits.GuildModeration,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.GuildMessageReactions
        ]
      ).bitfield
    )
    expect(options.partials).toEqual([Partials.Channel, Partials.Message, Partials.Reaction])
  })
})

describe('Discord login errors', () => {
  it.each([new Error('Used disallowed intents'), { code: 4014 }, { code: '4014' }])(
    'explains both required privileged intents for %j',
    (error) => {
      const message = formatDiscordLoginError(error)
      expect(message).toContain('Server Members Intent and Message Content Intent')
      expect(message).toContain('Discord Developer Portal')
      expect(message).toContain('approval if required')
      expect(message).toContain('try Login again')
    }
  )

  it.each([
    [new Error('Used invalid intents'), 'Used invalid intents'],
    [{ code: 4013, message: 'Invalid intent bits' }, 'Invalid intent bits'],
    [
      { code: 'TokenInvalid', message: 'An invalid token was provided.' },
      'An invalid token was provided.'
    ],
    [new Error('Connection timed out'), 'Connection timed out'],
    ['Network unavailable', 'Network unavailable'],
    [null, 'null']
  ])('preserves unrelated failures instead of blaming portal toggles: %j', (error, message) => {
    expect(formatDiscordLoginError(error)).toBe(`Login failed: ${message}`)
  })
})
