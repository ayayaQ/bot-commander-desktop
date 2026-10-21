import type { RuntimeGuild } from './ports'
import type { BCFDContext, BCFDFunction, FunctionRegistry } from './types'
import type { RuntimeServices } from './services'
import { ChannelType, PermissionsBitField, OAuth2Scopes } from './constants'
const channelTypeMap: Record<string, number> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
  announcement: ChannelType.GuildAnnouncement,
  stage: ChannelType.GuildStageVoice,
  forum: ChannelType.GuildForum
}

const channelTypeReverseMap: Record<number, string> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media'
}

function parseChannelType(type: string): number | null {
  return channelTypeMap[type.toLowerCase().trim()] ?? null
}

function channelTypeToString(type: number): string {
  return channelTypeReverseMap[type] ?? 'unknown'
}

async function resolveChannel(guild: RuntimeGuild, channelID: string) {
  const id = channelID.trim()
  return guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null))
}

function discordTimestampFromMillis(timestamp?: number | null): string {
  return timestamp == null ? '' : `<t:${Math.floor(timestamp / 1000)}>`
}

const BOOLEAN_VALUES = new Map<string, boolean>([
  ['true', true],
  ['false', false]
])

function parseBooleanValue(value: string): boolean | null {
  return BOOLEAN_VALUES.get(value.trim().toLowerCase()) ?? null
}

function formatCalculatedNumber(value: number): string {
  if (!Number.isFinite(value)) throw new Error('result must be finite')
  return value.toString()
}

class MathExpressionParser {
  private position = 0
  private depth = 0

  constructor(private readonly source: string) {}

  parse(): number {
    if (this.source.length > 512) throw new Error('expression is too long')
    const value = this.parseAdditive()
    this.skipWhitespace()
    if (this.position !== this.source.length)
      throw new Error(`unexpected token at position ${this.position + 1}`)
    return value
  }

  private parseAdditive(): number {
    let value = this.parseMultiplicative()
    while (true) {
      this.skipWhitespace()
      if (this.consume('+')) value += this.parseMultiplicative()
      else if (this.consume('-')) value -= this.parseMultiplicative()
      else return value
    }
  }

  private parseMultiplicative(): number {
    let value = this.parseUnary()
    while (true) {
      this.skipWhitespace()
      if (this.source.startsWith('**', this.position)) return value
      if (this.consume('*')) value *= this.parseUnary()
      else if (this.consume('/')) {
        const divisor = this.parseUnary()
        if (divisor === 0) throw new Error('division by zero')
        value /= divisor
      } else if (this.consume('%')) {
        const divisor = this.parseUnary()
        if (divisor === 0) throw new Error('division by zero')
        value %= divisor
      } else return value
    }
  }

  private parseUnary(): number {
    this.skipWhitespace()
    if (this.consume('+')) return this.parseUnary()
    if (this.consume('-')) return -this.parseUnary()
    return this.parsePower()
  }

  private parsePower(): number {
    const base = this.parsePrimary()
    this.skipWhitespace()
    if (!this.source.startsWith('**', this.position)) return base
    this.position += 2
    return Math.pow(base, this.parseUnary())
  }

  private parsePrimary(): number {
    this.skipWhitespace()
    if (this.consume('(')) {
      this.depth++
      if (this.depth > 64) throw new Error('expression nesting is too deep')
      const value = this.parseAdditive()
      this.skipWhitespace()
      if (!this.consume(')')) throw new Error('missing closing parenthesis')
      this.depth--
      return value
    }

    const start = this.position
    let sawDigit = false
    while (this.position < this.source.length && /[0-9]/.test(this.source[this.position])) {
      sawDigit = true
      this.position++
    }
    if (this.source[this.position] === '.') {
      this.position++
      while (this.position < this.source.length && /[0-9]/.test(this.source[this.position])) {
        sawDigit = true
        this.position++
      }
    }
    if (!sawDigit) throw new Error(`expected a number at position ${start + 1}`)
    return Number(this.source.slice(start, this.position))
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && /\s/u.test(this.source[this.position]))
      this.position++
  }

  private consume(value: string): boolean {
    if (!this.source.startsWith(value, this.position)) return false
    this.position += value.length
    return true
  }
}

function parseRoleColor(value: string): number | null {
  const trimmed = value.trim()
  const hex = trimmed.replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16)
  if (!/^\d+$/.test(trimmed)) return null
  const numeric = Number(trimmed)
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0xffffff ? numeric : null
}

// ============================================================================
// Function Registry - All built-in functions
// ============================================================================

export function createFunctionRegistry(host: RuntimeServices): FunctionRegistry {
  const registry = new Map<string, BCFDFunction>()

  // --------------------------------------------------------------------------
  // User Context Functions
  // --------------------------------------------------------------------------
  registry.set('namePlain', (_args, ctx) => ctx.user?.displayName ?? '')
  registry.set('name', (_args, ctx) => (ctx.user ? `<@${ctx.user.id}>` : ''))
  registry.set(
    'avatar',
    (_args, ctx) => ctx.user?.avatarURL({}) ?? ctx.user?.defaultAvatarURL ?? ''
  )
  registry.set('discriminator', (_args, ctx) => ctx.user?.discriminator ?? '')
  registry.set('tag', (_args, ctx) => ctx.user?.tag ?? '')
  const userID: BCFDFunction = (_args, ctx) => ctx.user?.id ?? ''
  registry.set('ID', userID)
  registry.set('id', userID) // Legacy desktop alias
  registry.set('isBot', (_args, ctx) => ctx.user?.bot.toString() ?? '')
  registry.set('globalName', (_args, ctx) => ctx.user?.globalName ?? '')
  registry.set('timeCreated', (_args, ctx) =>
    ctx.user ? new Date(ctx.user.createdTimestamp).toLocaleString() : ''
  )
  registry.set('timeCreatedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.user?.createdTimestamp)
  )
  const defaultAvatar: BCFDFunction = (_args, ctx) => ctx.user?.defaultAvatarURL ?? ''
  registry.set('defaultAvatar', defaultAvatar)
  registry.set('defaultavatar', defaultAvatar) // Legacy desktop alias
  registry.set('serversSharedWithBot', (_args, ctx) => host.mutualGuildCount(ctx, ctx.user))

  // --------------------------------------------------------------------------
  // Member Context Functions
  // --------------------------------------------------------------------------
  registry.set('memberIsOwner', (_args, ctx) =>
    (ctx.member?.guild.ownerId === ctx.member?.id).toString()
  )
  registry.set('memberEffectiveName', (_args, ctx) => ctx.member?.displayName ?? '')
  registry.set('memberNickname', (_args, ctx) => ctx.member?.nickname ?? '')
  registry.set('memberID', (_args, ctx) => ctx.member?.id ?? '')
  registry.set('memberHasTimeJoined', (_args, ctx) =>
    ctx.member ? (ctx.member.joinedTimestamp != null).toString() : ''
  )
  registry.set('memberTimeJoined', (_args, ctx) =>
    ctx.member?.joinedTimestamp != null ? new Date(ctx.member.joinedTimestamp).toLocaleString() : ''
  )
  registry.set('memberTimeJoinedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.member?.joinedTimestamp)
  )
  registry.set(
    'memberEffectiveAvatar',
    (_args, ctx) => ctx.member?.displayAvatarURL({}) ?? ctx.member?.user.defaultAvatarURL ?? ''
  )
  registry.set('memberEffectiveTag', (_args, ctx) => ctx.member?.user.tag ?? '')
  registry.set('memberEffectiveID', (_args, ctx) => ctx.member?.user.id ?? '')
  registry.set('memberEffectiveTimeCreated', (_args, ctx) =>
    ctx.member ? new Date(ctx.member.user.createdTimestamp).toLocaleString() : ''
  )
  registry.set('memberEffectiveTimeCreatedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.member?.user.createdTimestamp)
  )
  registry.set(
    'memberEffectiveDefaultAvatar',
    (_args, ctx) => ctx.member?.user.defaultAvatarURL ?? ''
  )
  registry.set('memberTimeBoosted', (_args, ctx) =>
    ctx.member?.premiumSinceTimestamp != null
      ? new Date(ctx.member.premiumSinceTimestamp).toLocaleString()
      : ''
  )
  registry.set('memberTimeBoostedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.member?.premiumSinceTimestamp)
  )
  registry.set('memberHasBoosted', (_args, ctx) =>
    (ctx.member?.premiumSinceTimestamp != null).toString()
  )
  registry.set('memberColor', (_args, ctx) => ctx.member?.displayHexColor ?? '')
  registry.set(
    'memberRoles',
    (_args, ctx) => ctx.member?.roles.cache.map((r) => r.name).join(', ') ?? ''
  )
  registry.set('memberRoleCount', (_args, ctx) => ctx.member?.roles.cache.size.toString() ?? '0')

  // --------------------------------------------------------------------------
  // Client/Bot Context Functions
  // --------------------------------------------------------------------------
  registry.set('ping', (_args, ctx) => ctx.client?.ws.ping.toString() ?? '')
  registry.set(
    'inviteURL',
    (_args, ctx) =>
      ctx.client?.generateInvite({
        scopes: [OAuth2Scopes.Bot],
        permissions: [PermissionsBitField.Flags.Administrator]
      }) ?? ''
  )
  registry.set('serverCount', (_args, ctx) => ctx.client?.guilds.cache.size.toString() ?? '')
  registry.set('allMemberCount', (_args, ctx) => ctx.client?.users.cache.size.toString() ?? '')
  registry.set(
    'botAvatar',
    (_args, ctx) => ctx.client?.user?.avatarURL({}) ?? ctx.client?.user?.defaultAvatarURL ?? ''
  )
  registry.set('botName', (_args, ctx) => `<@${ctx.client?.user?.id ?? ''}>`)
  registry.set('botNamePlain', (_args, ctx) => ctx.client?.user?.displayName ?? '')
  registry.set('botID', (_args, ctx) => ctx.client?.user?.id ?? '')
  registry.set('botTimeCreated', (_args, ctx) =>
    new Date(ctx.client?.user?.createdTimestamp ?? 0).toLocaleString()
  )
  registry.set('botTimeCreatedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.client?.user?.createdTimestamp)
  )
  registry.set('botDefaultAvatar', (_args, ctx) => ctx.client?.user?.defaultAvatarURL ?? '')
  registry.set('botDiscriminator', (_args, ctx) => ctx.client?.user?.discriminator ?? '')
  registry.set('botTag', (_args, ctx) => ctx.client?.user?.tag ?? '')

  // --------------------------------------------------------------------------
  // Guild Context Functions
  // --------------------------------------------------------------------------
  registry.set('server', (_args, ctx) => ctx.guild?.name ?? '')
  registry.set('serverIcon', (_args, ctx) => ctx.guild?.iconURL({}) ?? '')
  registry.set('serverBanner', (_args, ctx) => ctx.guild?.bannerURL({}) ?? '')
  registry.set('serverDescription', (_args, ctx) => ctx.guild?.description ?? '')
  registry.set('serverSplash', (_args, ctx) => ctx.guild?.splashURL({}) ?? '')
  registry.set('serverCreateTime', (_args, ctx) =>
    new Date(ctx.guild?.createdTimestamp ?? 0).toLocaleString()
  )
  registry.set('serverCreateTimeDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.guild?.createdTimestamp)
  )
  registry.set('memberCount', (_args, ctx) => ctx.guild?.memberCount.toString() ?? '')
  registry.set('serverID', (_args, ctx) => ctx.guild?.id ?? '')
  registry.set('serverOwner', async (_args, ctx) => {
    if (!ctx.guild) return ''
    const owner = await ctx.guild.fetchOwner().catch(() => null)
    return owner ? `<@${owner.id}>` : ''
  })
  registry.set('serverOwnerPlain', async (_args, ctx) => {
    if (!ctx.guild) return ''
    const owner = await ctx.guild.fetchOwner().catch(() => null)
    return owner?.user.displayName ?? ''
  })
  registry.set(
    'serverBoostCount',
    (_args, ctx) => ctx.guild?.premiumSubscriptionCount?.toString() ?? '0'
  )
  registry.set('serverBoostTier', (_args, ctx) => ctx.guild?.premiumTier.toString() ?? '0')
  registry.set('serverVanityCode', (_args, ctx) => ctx.guild?.vanityURLCode ?? '')

  // --------------------------------------------------------------------------
  // Channel Context Functions
  // --------------------------------------------------------------------------
  registry.set('channel', (_args, ctx) => ctx.textChannel?.name ?? '')
  registry.set('channelID', (_args, ctx) => ctx.textChannel?.id ?? '')
  registry.set('channelCreateDate', (_args, ctx) =>
    new Date(ctx.textChannel?.createdTimestamp ?? 0).toLocaleString()
  )
  registry.set('channelCreateDateDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.textChannel?.createdTimestamp)
  )
  registry.set('channelAsMention', (_args, ctx) => `<#${ctx.textChannel?.id ?? ''}>`)
  registry.set('channelTopic', (_args, ctx) => {
    const ch = ctx.textChannel
    return ch && 'topic' in ch ? (ch.topic ?? '') : ''
  })
  registry.set('channelIsNSFW', (_args, ctx) => {
    const ch = ctx.textChannel
    return ch && 'nsfw' in ch ? (ch.nsfw ?? false).toString() : 'false'
  })

  // --------------------------------------------------------------------------
  // Channel Management Functions
  // --------------------------------------------------------------------------

  // $createChannel(name, type) - create a new channel, returns its ID
  registry.set('createChannel', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: createChannel requires a guild context]'
    const name = args[0]?.trim()
    if (!name) return '[BCFD Error: createChannel requires a channel name]'
    const typeStr = args[1]?.trim() || 'text'
    const channelType = parseChannelType(typeStr)
    if (channelType === null) return `[BCFD Error: createChannel invalid type "${typeStr}"]`
    try {
      const channel = await ctx.guild.channels.create({ name, type: channelType })
      return channel.id
    } catch (e) {
      return `[BCFD Error: createChannel failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $createPrivateChannel(name, type) - create a private channel for the caller, returns its ID
  registry.set('createPrivateChannel', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: createPrivateChannel requires a guild context]'
    if (!ctx.user) return '[BCFD Error: createPrivateChannel requires a user context]'
    const name = args[0]?.trim()
    if (!name) return '[BCFD Error: createPrivateChannel requires a channel name]'
    const typeStr = args[1]?.trim() || 'text'
    const channelType = parseChannelType(typeStr)
    if (channelType === null) return `[BCFD Error: createPrivateChannel invalid type "${typeStr}"]`
    try {
      const channel = await ctx.guild.channels.create({
        name,
        type: channelType,
        permissionOverwrites: [
          {
            id: ctx.guild.roles.everyone.id,
            deny: [PermissionsBitField.Flags.ViewChannel]
          },
          {
            id: ctx.user.id,
            allow: [PermissionsBitField.Flags.ViewChannel]
          }
        ]
      })
      return channel.id
    } catch (e) {
      return `[BCFD Error: createPrivateChannel failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $createChannelIn(name, type, categoryID) - create a channel under a category
  registry.set('createChannelIn', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: createChannelIn requires a guild context]'
    const name = args[0]?.trim()
    if (!name) return '[BCFD Error: createChannelIn requires a channel name]'
    const typeStr = args[1]?.trim() || 'text'
    const channelType = parseChannelType(typeStr)
    if (channelType === null) return `[BCFD Error: createChannelIn invalid type "${typeStr}"]`
    const categoryID = args[2]?.trim()
    if (!categoryID) return '[BCFD Error: createChannelIn requires a category ID]'
    try {
      const channel = await ctx.guild.channels.create({
        name,
        type: channelType,
        parent: categoryID
      })
      return channel.id
    } catch (e) {
      return `[BCFD Error: createChannelIn failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $cloneChannel(channelID) - clone an existing channel, returns new channel ID
  registry.set('cloneChannel', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: cloneChannel requires a guild context]'
    const channelID = args[0]?.trim()
    if (!channelID) return '[BCFD Error: cloneChannel requires a channel ID]'
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return `[BCFD Error: cloneChannel channel not found]`
      if (!('clone' in channel))
        return '[BCFD Error: cloneChannel not supported on this channel type]'
      const cloned = await channel.clone!()
      return cloned.id
    } catch (e) {
      return `[BCFD Error: cloneChannel failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $deleteChannel(channelID, reason) - delete a channel
  registry.set('deleteChannel', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: deleteChannel requires a guild context]'
    const channelID = args[0]?.trim()
    if (!channelID) return '[BCFD Error: deleteChannel requires a channel ID]'
    const reason = args[1]?.trim() || undefined
    try {
      await ctx.guild.channels.delete(channelID, reason)
      return 'true'
    } catch (e) {
      return `[BCFD Error: deleteChannel failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $setChannelName(channelID, name) - rename a channel
  registry.set('setChannelName', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: setChannelName requires a guild context]'
    const channelID = args[0]?.trim()
    const name = args[1]?.trim()
    if (!channelID || !name) return '[BCFD Error: setChannelName requires a channel ID and name]'
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: setChannelName channel not found]'
      await channel.setName!(name)
      return 'true'
    } catch (e) {
      return `[BCFD Error: setChannelName failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $setChannelTopic(channelID, topic) - set a channel's topic
  registry.set('setChannelTopic', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: setChannelTopic requires a guild context]'
    const channelID = args[0]?.trim()
    const topic = args[1] ?? ''
    if (!channelID) return '[BCFD Error: setChannelTopic requires a channel ID]'
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: setChannelTopic channel not found]'
      if (!('setTopic' in channel))
        return '[BCFD Error: setChannelTopic not supported on this channel type]'
      await channel.setTopic!(topic)
      return 'true'
    } catch (e) {
      return `[BCFD Error: setChannelTopic failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $setChannelNSFW(channelID, enabled) - toggle NSFW flag
  registry.set('setChannelNSFW', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: setChannelNSFW requires a guild context]'
    const channelID = args[0]?.trim()
    const enabled = args[1]?.trim()
    if (!channelID || !enabled)
      return '[BCFD Error: setChannelNSFW requires a channel ID and true/false]'
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: setChannelNSFW channel not found]'
      if (!('setNSFW' in channel))
        return '[BCFD Error: setChannelNSFW not supported on this channel type]'
      await channel.setNSFW!(enabled === 'true')
      return 'true'
    } catch (e) {
      return `[BCFD Error: setChannelNSFW failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $setChannelSlowmode(channelID, seconds) - set slowmode (0-21600)
  registry.set('setChannelSlowmode', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: setChannelSlowmode requires a guild context]'
    const channelID = args[0]?.trim()
    const seconds = parseInt(args[1]?.trim() ?? '', 10)
    if (!channelID) return '[BCFD Error: setChannelSlowmode requires a channel ID]'
    if (isNaN(seconds) || seconds < 0 || seconds > 21600)
      return '[BCFD Error: setChannelSlowmode seconds must be 0-21600]'
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: setChannelSlowmode channel not found]'
      if (!('setRateLimitPerUser' in channel))
        return '[BCFD Error: setChannelSlowmode not supported on this channel type]'
      await channel.setRateLimitPerUser!(seconds)
      return 'true'
    } catch (e) {
      return `[BCFD Error: setChannelSlowmode failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $setChannelPosition(channelID, position) - set channel position
  registry.set('setChannelPosition', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: setChannelPosition requires a guild context]'
    const channelID = args[0]?.trim()
    const position = parseInt(args[1]?.trim() ?? '', 10)
    if (!channelID) return '[BCFD Error: setChannelPosition requires a channel ID]'
    if (isNaN(position)) return '[BCFD Error: setChannelPosition requires a numeric position]'
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: setChannelPosition channel not found]'
      if (!('setPosition' in channel))
        return '[BCFD Error: setChannelPosition not supported on this channel type]'
      await channel.setPosition!(position)
      return 'true'
    } catch (e) {
      return `[BCFD Error: setChannelPosition failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $setChannelParent(channelID, categoryID) - move channel to a category (empty = remove)
  registry.set('setChannelParent', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: setChannelParent requires a guild context]'
    const channelID = args[0]?.trim()
    if (!channelID) return '[BCFD Error: setChannelParent requires a channel ID]'
    const categoryID = args[1]?.trim() || null
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: setChannelParent channel not found]'
      if (!('setParent' in channel))
        return '[BCFD Error: setChannelParent not supported on this channel type]'
      await channel.setParent!(categoryID)
      return 'true'
    } catch (e) {
      return `[BCFD Error: setChannelParent failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $findChannel(name) - find a channel by name (case-insensitive), returns ID
  registry.set('findChannel', (_args, ctx) => {
    if (!ctx.guild) return ''
    const name = _args[0]?.trim().toLowerCase()
    if (!name) return ''
    const channel = ctx.guild.channels.cache.find((c) => (c.name ?? '').toLowerCase() === name)
    return channel?.id ?? ''
  })

  // $getChannelName(channelID) - get a channel's name by ID
  registry.set('getChannelName', (_args, ctx) => {
    if (!ctx.guild) return ''
    const channelID = _args[0]?.trim()
    if (!channelID) return ''
    return ctx.guild.channels.cache.get(channelID)?.name ?? ''
  })

  // $getChannelType(channelID) - get a channel's type as a friendly string
  registry.set('getChannelType', (_args, ctx) => {
    if (!ctx.guild) return ''
    const channelID = _args[0]?.trim()
    if (!channelID) return ''
    const channel = ctx.guild.channels.cache.get(channelID)
    if (!channel) return ''
    return channelTypeToString(channel.type)
  })

  // $getChannelParent(channelID) - get a channel's parent category ID
  registry.set('getChannelParent', (_args, ctx) => {
    if (!ctx.guild) return ''
    const channelID = _args[0]?.trim()
    if (!channelID) return ''
    return ctx.guild.channels.cache.get(channelID)?.parentId ?? ''
  })

  registry.set('channelExists', (args, ctx) => {
    const channelID = args[0]?.trim()
    return (!!channelID && !!ctx.client?.channels.cache.has(channelID)).toString()
  })

  registry.set('channelPosition', (args, ctx) => {
    const channelID = args[0]?.trim() || ctx.textChannel?.id
    if (!channelID || !ctx.guild) return ''
    const channel = ctx.guild.channels.cache.get(channelID)
    return channel && 'rawPosition' in channel ? ((channel.rawPosition ?? 0) + 1).toString() : ''
  })

  registry.set('getSlowmode', (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: getSlowmode requires a guild context]'
    const channelID = args[0]?.trim()
    if (!channelID) return '[BCFD Error: getSlowmode requires a channel ID]'
    const channel = ctx.guild.channels.cache.get(channelID)
    if (!channel) return '[BCFD Error: getSlowmode channel not found]'
    if (!('rateLimitPerUser' in channel))
      return '[BCFD Error: getSlowmode not supported on this channel type]'
    return String(channel.rateLimitPerUser ?? 0)
  })

  // $channelCount - total number of channels in the guild
  registry.set('channelCount', (_args, ctx) => ctx.guild?.channels.cache.size.toString() ?? '0')

  // $listChannels(type) - comma-separated list of channel names, optionally filtered by type
  registry.set('listChannels', (_args, ctx) => {
    if (!ctx.guild) return ''
    const typeStr = _args[0]?.trim().toLowerCase()
    const channelType = typeStr ? parseChannelType(typeStr) : null
    const channels = ctx.guild.channels.cache.filter(
      (c) => channelType === null || c.type === channelType
    )
    return channels.map((c) => c.name).join(', ')
  })

  // $listChannelIDs(type) - comma-separated list of channel IDs, optionally filtered by type
  registry.set('listChannelIDs', (_args, ctx) => {
    if (!ctx.guild) return ''
    const typeStr = _args[0]?.trim().toLowerCase()
    const channelType = typeStr ? parseChannelType(typeStr) : null
    const channels = ctx.guild.channels.cache.filter(
      (c) => channelType === null || c.type === channelType
    )
    return channels.map((c) => c.id).join(', ')
  })

  // $lockChannel(channelID, roleID) - deny SendMessages for a role (default @everyone)
  registry.set('lockChannel', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: lockChannel requires a guild context]'
    const channelID = args[0]?.trim()
    if (!channelID) return '[BCFD Error: lockChannel requires a channel ID]'
    const roleID = args[1]?.trim() || ctx.guild.id
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: lockChannel channel not found]'
      if (!('permissionOverwrites' in channel))
        return '[BCFD Error: lockChannel not supported on this channel type]'
      await channel.permissionOverwrites!.edit(roleID, { SendMessages: false })
      return 'true'
    } catch (e) {
      return `[BCFD Error: lockChannel failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $unlockChannel(channelID, roleID) - reset SendMessages for a role (default @everyone)
  registry.set('unlockChannel', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: unlockChannel requires a guild context]'
    const channelID = args[0]?.trim()
    if (!channelID) return '[BCFD Error: unlockChannel requires a channel ID]'
    const roleID = args[1]?.trim() || ctx.guild.id
    try {
      const channel = await resolveChannel(ctx.guild, channelID)
      if (!channel) return '[BCFD Error: unlockChannel channel not found]'
      if (!('permissionOverwrites' in channel))
        return '[BCFD Error: unlockChannel not supported on this channel type]'
      await channel.permissionOverwrites!.edit(roleID, { SendMessages: null })
      return 'true'
    } catch (e) {
      return `[BCFD Error: unlockChannel failed: ${e instanceof Error ? e.message : 'Unknown error'}]`
    }
  })

  // $channelMention(channelID) - format a channel ID as a mention
  registry.set('channelMention', (args) => {
    const channelID = args[0]?.trim()
    if (!channelID) return ''
    return `<#${channelID}>`
  })

  // --------------------------------------------------------------------------
  // Role Functions
  // --------------------------------------------------------------------------

  const orderedRoles = (ctx: BCFDContext) =>
    ctx.guild
      ? Array.from(ctx.guild.roles.cache.values()).sort(
          (left, right) => right.rawPosition - left.rawPosition
        )
      : []

  const findRole = (query: string, ctx: BCFDContext) => {
    if (!ctx.guild) return undefined
    const trimmed = query.trim()
    const roleID = trimmed.match(/^<@&(\d+)>$/)?.[1] ?? (/^\d+$/.test(trimmed) ? trimmed : '')
    if (roleID) return ctx.guild.roles.cache.get(roleID)
    const lowered = trimmed.toLowerCase()
    return ctx.guild.roles.cache.find((role) => role.name.toLowerCase() === lowered)
  }

  registry.set('roleCount', (_args, ctx) => ctx.guild?.roles.cache.size.toString() ?? '0')
  registry.set('roleExists', (args, ctx) => (!!findRole(args[0] ?? '', ctx)).toString())
  registry.set('findRole', (args, ctx) => findRole(args[0] ?? '', ctx)?.id ?? '')
  registry.set('roleName', (args, ctx) => findRole(args[0] ?? '', ctx)?.name ?? '')
  registry.set('roleNames', (_args, ctx) =>
    orderedRoles(ctx)
      .map((role) => role.name)
      .join(', ')
  )
  registry.set('getRoleColor', (args, ctx) => {
    const role = findRole(args[0] ?? '', ctx)
    return role ? role.color.toString(16).padStart(6, '0').toUpperCase() : ''
  })
  registry.set('rolePosition', (args, ctx) => {
    const role = findRole(args[0] ?? '', ctx)
    if (!role) return ''
    const position = orderedRoles(ctx).findIndex((candidate) => candidate.id === role.id)
    return position < 0 ? '' : (position + 1).toString()
  })
  registry.set('hasRole', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: hasRole requires a guild context]'
    const userID = args[0]?.trim()
    const role = findRole(args[1] ?? '', ctx)
    if (!userID || !role) return 'false'
    const member = await ctx.guild.members.fetch(userID).catch(() => null)
    if (!member) return 'false'
    return (role.id === ctx.guild.id || member.roles.cache.has(role.id)).toString()
  })
  registry.set('userRoles', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: userRoles requires a guild context]'
    const userID = args[0]?.trim()
    if (!userID) return '[BCFD Error: userRoles requires a user ID]'
    const member = await ctx.guild.members.fetch(userID).catch(() => null)
    if (!member) return ''
    return Array.from(member.roles.cache.values())
      .filter((role) => role.id !== ctx.guild!.id)
      .sort((left, right) => right.rawPosition - left.rawPosition)
      .map((role) => role.name)
      .join(', ')
  })
  registry.set('roleGrant', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: roleGrant requires a guild context]'
    if (!ctx.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles))
      return '[BCFD Error: roleGrant requires Manage Roles permission]'
    const userID = args[0]?.trim()
    if (!userID || args.length < 2)
      return '[BCFD Error: roleGrant requires a user ID and signed role IDs]'
    const member = await ctx.guild.members.fetch(userID).catch(() => null)
    if (!member) return '[BCFD Error: roleGrant member not found]'
    if (!member.manageable) return '[BCFD Error: roleGrant member is not manageable]'

    const additions: string[] = []
    const removals: string[] = []
    const seen = new Set<string>()
    for (const operation of args.slice(1)) {
      const trimmed = operation.trim()
      const match = trimmed.match(/^([+-])(\d+)$/)
      if (!match) return '[BCFD Error: roleGrant roles must use +roleID or -roleID]'
      const [, sign, roleID] = match
      if (seen.has(roleID)) return '[BCFD Error: roleGrant contains a duplicate role ID]'
      seen.add(roleID)
      const role = ctx.guild.roles.cache.get(roleID)
      if (!role) return `[BCFD Error: roleGrant role ${roleID} not found]`
      if (role.id === ctx.guild.id || role.managed || !role.editable)
        return `[BCFD Error: roleGrant role ${roleID} is not manageable]`
      if (sign === '+') additions.push(roleID)
      else removals.push(roleID)
    }

    try {
      if (additions.length > 0) await member.roles.add(additions)
      if (removals.length > 0) await member.roles.remove(removals)
      return 'true'
    } catch (error) {
      return `[BCFD Error: roleGrant failed: ${error instanceof Error ? error.message : 'Unknown error'}]`
    }
  })
  registry.set('createRole', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: createRole requires a guild context]'
    if (!ctx.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles))
      return '[BCFD Error: createRole requires Manage Roles permission]'
    const name = args[0]?.trim() ?? ''
    if (name.length < 1 || name.length > 100)
      return '[BCFD Error: createRole name must be 1-100 characters]'
    const color = parseRoleColor(args[1] ?? '')
    if (color === null) return '[BCFD Error: createRole requires a valid color]'
    const hoist = args[2] == null || args[2].trim() === '' ? false : parseBooleanValue(args[2])
    const mentionable =
      args[3] == null || args[3].trim() === '' ? false : parseBooleanValue(args[3])
    if (hoist === null || mentionable === null)
      return '[BCFD Error: createRole hoisted and mentionable must be boolean values]'
    try {
      const role = await ctx.guild.roles.create({ name, color, hoist, mentionable })
      return role.id
    } catch (error) {
      return `[BCFD Error: createRole failed: ${error instanceof Error ? error.message : 'Unknown error'}]`
    }
  })
  registry.set('deleteRole', async (args, ctx) => {
    if (!ctx.guild) return '[BCFD Error: deleteRole requires a guild context]'
    if (!ctx.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles))
      return '[BCFD Error: deleteRole requires Manage Roles permission]'
    const role = findRole(args[0] ?? '', ctx)
    if (!role) return '[BCFD Error: deleteRole role not found]'
    if (role.id === ctx.guild.id || role.managed || !role.editable)
      return '[BCFD Error: deleteRole role is not manageable]'
    try {
      await role.delete()
      return 'true'
    } catch (error) {
      return `[BCFD Error: deleteRole failed: ${error instanceof Error ? error.message : 'Unknown error'}]`
    }
  })

  // --------------------------------------------------------------------------
  // Mentioned User Context Functions
  // --------------------------------------------------------------------------
  registry.set('mentionedName', (_args, ctx) => `<@${ctx.mentionedUser?.id ?? ''}>`)
  registry.set('mentionedID', (_args, ctx) => ctx.mentionedUser?.id ?? '')
  registry.set('mentionedTag', (_args, ctx) => ctx.mentionedUser?.tag ?? '')
  registry.set('mentionedDiscriminator', (_args, ctx) => ctx.mentionedUser?.discriminator ?? '')
  registry.set(
    'mentionedAvatar',
    (_args, ctx) => ctx.mentionedUser?.avatarURL({}) ?? ctx.mentionedUser?.defaultAvatarURL ?? ''
  )
  registry.set('mentionedTimeCreated', (_args, ctx) =>
    new Date(ctx.mentionedUser?.createdTimestamp ?? 0).toLocaleString()
  )
  registry.set('mentionedTimeCreatedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.mentionedUser?.createdTimestamp)
  )
  registry.set('mentionedNamePlain', (_args, ctx) => ctx.mentionedUser?.displayName ?? '')
  registry.set('mentionedDefaultAvatar', (_args, ctx) => ctx.mentionedUser?.defaultAvatarURL ?? '')
  registry.set('mentionedIsBot', (_args, ctx) => ctx.mentionedUser?.bot.toString() ?? '')
  registry.set('mentionedGlobalName', (_args, ctx) => ctx.mentionedUser?.globalName ?? '')
  registry.set('mentionedServersSharedWithBot', (_args, ctx) =>
    host.mutualGuildCount(ctx, ctx.mentionedUser)
  )

  // --------------------------------------------------------------------------
  // Mentioned Member Context Functions
  // --------------------------------------------------------------------------
  registry.set('mentionedMemberIsOwner', (_args, ctx) =>
    (ctx.mentionedMember?.guild.ownerId === ctx.mentionedMember?.id).toString()
  )
  registry.set(
    'mentionedMemberEffectiveName',
    (_args, ctx) => ctx.mentionedMember?.displayName ?? ''
  )
  registry.set('mentionedMemberNickname', (_args, ctx) => ctx.mentionedMember?.nickname ?? '')
  registry.set('mentionedMemberID', (_args, ctx) => ctx.mentionedMember?.id ?? '')
  registry.set('mentionedMemberHasTimeJoined', (_args, ctx) =>
    ctx.mentionedMember ? (ctx.mentionedMember.joinedTimestamp != null).toString() : ''
  )
  registry.set('mentionedMemberTimeJoined', (_args, ctx) =>
    ctx.mentionedMember?.joinedTimestamp != null
      ? new Date(ctx.mentionedMember.joinedTimestamp).toLocaleString()
      : ''
  )
  registry.set('mentionedMemberTimeJoinedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.mentionedMember?.joinedTimestamp)
  )
  registry.set(
    'mentionedMemberEffectiveAvatar',
    (_args, ctx) =>
      ctx.mentionedMember?.displayAvatarURL({}) ?? ctx.mentionedMember?.user.defaultAvatarURL ?? ''
  )
  registry.set('mentionedMemberEffectiveTag', (_args, ctx) => ctx.mentionedMember?.user.tag ?? '')
  registry.set('mentionedMemberEffectiveID', (_args, ctx) => ctx.mentionedMember?.user.id ?? '')
  registry.set('mentionedMemberEffectiveTimeCreated', (_args, ctx) =>
    ctx.mentionedMember ? new Date(ctx.mentionedMember.user.createdTimestamp).toLocaleString() : ''
  )
  registry.set('mentionedMemberEffectiveTimeCreatedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.mentionedMember?.user.createdTimestamp)
  )
  registry.set(
    'mentionedMemberEffectiveDefaultAvatar',
    (_args, ctx) => ctx.mentionedMember?.user.defaultAvatarURL ?? ''
  )
  registry.set('mentionedMemberTimeBoosted', (_args, ctx) =>
    ctx.mentionedMember?.premiumSinceTimestamp != null
      ? new Date(ctx.mentionedMember.premiumSinceTimestamp).toLocaleString()
      : ''
  )
  registry.set('mentionedMemberTimeBoostedDiscord', (_args, ctx) =>
    discordTimestampFromMillis(ctx.mentionedMember?.premiumSinceTimestamp)
  )
  registry.set('mentionedMemberHasBoosted', (_args, ctx) =>
    (ctx.mentionedMember?.premiumSinceTimestamp != null).toString()
  )
  registry.set('mentionedMemberColor', (_args, ctx) => ctx.mentionedMember?.displayHexColor ?? '')
  registry.set(
    'mentionedMemberRoles',
    (_args, ctx) => ctx.mentionedMember?.roles.cache.map((r) => r.name).join(', ') ?? ''
  )
  registry.set(
    'mentionedMemberRoleCount',
    (_args, ctx) => ctx.mentionedMember?.roles.cache.size.toString() ?? '0'
  )

  // --------------------------------------------------------------------------
  // General/Utility Functions
  // --------------------------------------------------------------------------
  registry.set('randomInt', () => Math.floor(host.random() * 100).toString())
  registry.set('randomFloat', () => host.random().toString())
  registry.set('randomBoolean', () => (host.random() > 0.5).toString())
  registry.set('commandCount', () => host.commandCount().toString())
  registry.set('deleteMessage', (args, ctx) => host.deleteMessage(args, ctx))
  registry.set('date', () => new Date(host.now()).toLocaleString())
  registry.set('dateDiscord', () => discordTimestampFromMillis(host.now()))
  registry.set('day', () => new Date(host.now()).getDate().toString())
  registry.set('month', () => (new Date(host.now()).getMonth() + 1).toString())
  registry.set('year', () => new Date(host.now()).getFullYear().toString())
  registry.set('getTimestamp', (args) => {
    const unit = args[0]?.trim().toLowerCase() || 's'
    const now = host.now()
    if (unit === 's') return Math.floor(now / 1000).toString()
    if (unit === 'ms') return now.toString()
    if (unit === 'ns') return (BigInt(now) * 1000000n).toString()
    return '[BCFD Error: getTimestamp unit must be s, ms, or ns]'
  })
  const hour: BCFDFunction = () => {
    const h = new Date(host.now()).getHours()
    return (h < 10 ? '0' : '') + h.toString()
  }
  registry.set('hour', hour)
  registry.set('hours', hour) // Legacy desktop alias
  const minute: BCFDFunction = () => {
    const m = new Date(host.now()).getMinutes()
    return (m < 10 ? '0' : '') + m.toString()
  }
  registry.set('minute', minute)
  registry.set('minutes', minute) // Legacy desktop alias
  const second: BCFDFunction = () => {
    const s = new Date(host.now()).getSeconds()
    return (s < 10 ? '0' : '') + s.toString()
  }
  registry.set('second', second)
  registry.set('seconds', second) // Legacy desktop alias
  registry.set('message', (_args, ctx) => ctx.messageEvent?.content ?? '')
  registry.set(
    'messageAfterCommand',
    (_args, ctx) =>
      ctx.messageEvent?.content.substring(ctx.command?.command.length ?? 0).trim() ?? ''
  )
  registry.set('argsCount', (_args, ctx) => {
    const after = ctx.messageEvent?.content.substring(ctx.command?.command.length ?? 0).trim() ?? ''
    const args = after.split(' ').filter((s) => s.length > 0)
    return args.length.toString()
  })
  registry.set('wordCount', (args) => {
    const text = args[0]?.trim() ?? ''
    return text === '' ? '0' : text.split(/\s+/u).length.toString()
  })

  // --------------------------------------------------------------------------
  // Functions with Arguments
  // --------------------------------------------------------------------------

  // $random{option1|option2|option3} - picks one randomly
  registry.set('random', (args) => {
    if (args.length === 0) return ''
    return args[Math.floor(host.random() * args.length)]
  })

  // $rollnum(min, max) - random integer in range
  registry.set('rollnum', (args) => {
    const min = parseInt(args[0] ?? '0', 10)
    const max = parseInt(args[1] ?? '100', 10)
    if (isNaN(min) || isNaN(max)) return '[BCFD Error: rollnum requires numeric arguments]'
    return (Math.floor(host.random() * (max - min + 1)) + min).toString()
  })

  // $sum(n1, n2, ...) or $sum{n1|n2|...} - sum of numbers
  registry.set('sum', (args) => {
    let total = 0
    for (const arg of args) {
      const num = parseFloat(arg)
      if (isNaN(num)) {
        return '[BCFD Error: sum requires numeric arguments]'
      }
      total += num
    }
    return total.toString()
  })

  // --------------------------------------------------------------------------
  // Math Functions
  // --------------------------------------------------------------------------

  registry.set('calculate', (args) => {
    const expression = args[0]?.trim() ?? ''
    if (!expression) return '[BCFD Error: calculate requires an expression]'
    try {
      return formatCalculatedNumber(new MathExpressionParser(expression).parse())
    } catch (error) {
      return `[BCFD Error: calculate ${error instanceof Error ? error.message : 'failed'}]`
    }
  })

  // $sub(a, b) - subtraction
  registry.set('sub', (args) => {
    const a = parseFloat(args[0] ?? '')
    const b = parseFloat(args[1] ?? '')
    if (isNaN(a) || isNaN(b)) return '[BCFD Error: sub requires numeric arguments]'
    return (a - b).toString()
  })

  // $mul(n1, n2, ...) or $mul{n1|n2|...} - multiply all numbers
  registry.set('mul', (args) => {
    let total = 1
    for (const arg of args) {
      const num = parseFloat(arg)
      if (isNaN(num)) {
        return '[BCFD Error: mul requires numeric arguments]'
      }
      total *= num
    }
    return total.toString()
  })

  // $div(a, b) - division
  registry.set('div', (args) => {
    const a = parseFloat(args[0] ?? '')
    const b = parseFloat(args[1] ?? '')
    if (isNaN(a) || isNaN(b)) return '[BCFD Error: div requires numeric arguments]'
    if (b === 0) return '[BCFD Error: division by zero]'
    return (a / b).toString()
  })

  // $mod(a, b) - modulo
  registry.set('mod', (args) => {
    const a = parseFloat(args[0] ?? '')
    const b = parseFloat(args[1] ?? '')
    if (isNaN(a) || isNaN(b)) return '[BCFD Error: mod requires numeric arguments]'
    if (b === 0) return '[BCFD Error: division by zero]'
    return (a % b).toString()
  })

  // $round(n) or $round(n, decimals) - round to nearest integer or to N decimal places
  registry.set('round', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: round requires a numeric argument]'
    const decimals = parseInt(args[1]?.trim() ?? '0', 10) || 0
    const factor = Math.pow(10, decimals)
    return (Math.round(n * factor) / factor).toString()
  })

  // $floor(n) - round down
  registry.set('floor', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: floor requires a numeric argument]'
    return Math.floor(n).toString()
  })

  // $ceil(n) - round up
  registry.set('ceil', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: ceil requires a numeric argument]'
    return Math.ceil(n).toString()
  })

  // $abs(n) - absolute value
  registry.set('abs', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: abs requires a numeric argument]'
    return Math.abs(n).toString()
  })

  // $toFixed(n, decimals) - format number to fixed decimal places
  registry.set('toFixed', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: toFixed requires a numeric argument]'
    const decimals = Math.max(0, Math.min(parseInt(args[1]?.trim() ?? '2', 10) || 2, 20))
    return n.toFixed(decimals)
  })

  // $min(n1, n2, ...) or $min{n1|n2|...} - minimum value
  registry.set('min', (args) => {
    const nums = args.map((a) => parseFloat(a))
    if (nums.length === 0 || nums.some(isNaN)) return '[BCFD Error: min requires numeric arguments]'
    return Math.min(...nums).toString()
  })

  // $max(n1, n2, ...) or $max{n1|n2|...} - maximum value
  registry.set('max', (args) => {
    const nums = args.map((a) => parseFloat(a))
    if (nums.length === 0 || nums.some(isNaN)) return '[BCFD Error: max requires numeric arguments]'
    return Math.max(...nums).toString()
  })

  // $clamp(n, min, max) - clamp value between min and max
  registry.set('clamp', (args) => {
    const n = parseFloat(args[0] ?? '')
    const min = parseFloat(args[1] ?? '')
    const max = parseFloat(args[2] ?? '')
    if (isNaN(n) || isNaN(min) || isNaN(max))
      return '[BCFD Error: clamp requires numeric arguments]'
    return Math.max(min, Math.min(n, max)).toString()
  })

  // $pow(base, exp) - exponentiation
  registry.set('pow', (args) => {
    const base = parseFloat(args[0] ?? '')
    const exp = parseFloat(args[1] ?? '')
    if (isNaN(base) || isNaN(exp)) return '[BCFD Error: pow requires numeric arguments]'
    return Math.pow(base, exp).toString()
  })

  // $sqrt(n) - square root
  registry.set('sqrt', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: sqrt requires a numeric argument]'
    if (n < 0) return '[BCFD Error: sqrt of negative number]'
    return Math.sqrt(n).toString()
  })

  // $log(n) - natural logarithm
  registry.set('log', (args) => {
    const n = parseFloat(args[0] ?? '')
    if (isNaN(n)) return '[BCFD Error: log requires a numeric argument]'
    if (n <= 0) return '[BCFD Error: log of non-positive number]'
    return Math.log(n).toString()
  })

  // $pi - returns pi constant
  registry.set('pi', () => Math.PI.toString())

  // $isNumber(text) - check if text is a valid number
  registry.set('isNumber', (args) =>
    (!isNaN(parseFloat(args[0] ?? '')) && isFinite(Number(args[0] ?? ''))).toString()
  )

  // $args(index) - get argument at index
  registry.set('args', (args, ctx) => {
    const index = parseInt(args[0] ?? '0', 10)
    if (isNaN(index)) return ''
    const after = ctx.messageEvent?.content.substring(ctx.command?.command.length ?? 0).trim() ?? ''
    const messageArgs = after.split(' ').filter((s) => s.length > 0)
    return messageArgs[index] ?? ''
  })

  // $option(name) - get slash command option value
  registry.set('option', (args, ctx) => {
    if (args.length < 1 || !ctx.interactionOptions) return ''
    const name = args[0]
    const option = ctx.interactionOptions.get(name)
    if (!option) return ''
    // Handle different option types
    const value = option.value
    if (value === null || value === undefined) return ''
    return String(value)
  })

  // $set(name, value) - store a variable
  registry.set('set', (args, ctx) => {
    if (args.length < 2 || !ctx.vmContext) return ''
    const [name, value] = args
    ctx.vmContext.setVariable(name, value)
    return ''
  })

  // $get(name) - retrieve a variable
  registry.set('get', (args, ctx) => {
    if (args.length < 1 || !ctx.vmContext) return ''
    const value = ctx.vmContext.getVariable(args[0])
    return value !== undefined ? String(value) : ''
  })

  registry.set('setStatus', (args, ctx) => host.setStatus(ctx, args))

  // --------------------------------------------------------------------------
  // String Manipulation Functions
  // --------------------------------------------------------------------------

  registry.set('cropText', (args) => {
    const characters = Array.from(args[0] ?? '')
    const max = Number(args[1]?.trim())
    if (!Number.isInteger(max) || max < 0)
      return '[BCFD Error: cropText max must be a non-negative integer]'
    if (characters.length <= max) return characters.join('')
    return characters.slice(0, max).join('') + (args[2] ?? '')
  })

  registry.set('linesCount', (args) => {
    const text = args[0] ?? ''
    return text === '' ? '0' : text.split(/\r\n|\r|\n/u).length.toString()
  })

  registry.set('toTitleCase', (args) =>
    (args[0] ?? '').replace(/\S+/gu, (word) => {
      const characters = Array.from(word.toLocaleLowerCase())
      return characters.length === 0
        ? ''
        : characters[0].toLocaleUpperCase() + characters.slice(1).join('')
    })
  )

  registry.set('numberSeparator', (args) => {
    const value = args[0]?.trim() ?? ''
    if (!/^[+-]?\d+$/.test(value)) return '[BCFD Error: numberSeparator requires an integer]'
    const sign = value[0] === '+' || value[0] === '-' ? value[0] : ''
    const digits = sign ? value.slice(1) : value
    const separator = args[1] ?? ','
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator)
  })

  registry.set('randomString', (args) => {
    const length = Number(args[0]?.trim())
    if (!Number.isInteger(length) || length < 0 || length > 10)
      return '[BCFD Error: randomString length must be an integer from 0 to 10]'
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let index = 0; index < length; index++)
      result += alphabet[Math.floor(host.random() * alphabet.length)]
    return result
  })

  registry.set('isBoolean', (args) => (parseBooleanValue(args[0] ?? '') !== null).toString())
  registry.set('isInteger', (args) => /^[+-]?\d+$/.test(args[0]?.trim() ?? '').toString())
  registry.set('isValidHex', (args) => /^#?[0-9a-fA-F]{6}$/.test(args[0]?.trim() ?? '').toString())

  // $upper(text) - convert to uppercase
  registry.set('upper', (args) => args[0]?.toUpperCase() ?? '')

  // $lower(text) - convert to lowercase
  registry.set('lower', (args) => args[0]?.toLowerCase() ?? '')

  // $length(text) - get string length
  registry.set('length', (args) => (args[0]?.length ?? 0).toString())

  // $replace(text, find, replacement) - replace all occurrences
  registry.set('replace', (args) => {
    const text = args[0] ?? ''
    const find = args[1] ?? ''
    const replacement = args[2] ?? ''
    if (find === '') return text
    if (host.maxOutput !== undefined) {
      let count = 0,
        position = 0
      while ((position = text.indexOf(find, position)) !== -1) {
        count++
        position += find.length
      }
      if (text.length + count * (replacement.length - find.length) > host.maxOutput)
        throw new Error('Output exceeds the playground limit')
    }
    return text.split(find).join(replacement)
  })

  // $substring(text, start, end) - extract substring
  registry.set('substring', (args) => {
    const text = args[0] ?? ''
    const start = Math.max(0, Math.min(parseInt(args[1]?.trim() ?? '0', 10) || 0, text.length))
    const end = Math.max(
      start,
      Math.min(parseInt(args[2]?.trim() ?? String(text.length), 10) || text.length, text.length)
    )
    return text.substring(start, end)
  })

  // $trim(text) - trim whitespace
  registry.set('trim', (args) => args[0]?.trim() ?? '')

  // $repeat(text, count) - repeat text N times (capped at 100)
  registry.set('repeat', (args) => {
    const text = args[0] ?? ''
    const count = Math.max(0, Math.min(parseInt(args[1]?.trim() ?? '1', 10) || 1, 100))
    return text.repeat(count)
  })

  // $contains(text, search) - check if text contains search string
  registry.set('contains', (args) => (args[0] ?? '').includes(args[1] ?? '').toString())

  // $startsWith(text, prefix) - check if text starts with prefix
  registry.set('startsWith', (args) => (args[0] ?? '').startsWith(args[1] ?? '').toString())

  // $endsWith(text, suffix) - check if text ends with suffix
  registry.set('endsWith', (args) => (args[0] ?? '').endsWith(args[1] ?? '').toString())

  // $chat(prompt) - async AI chat (returns Promise)
  registry.set('chat', async (args) => {
    if (args.length < 1) return ''
    const prompt = args[0]
    return await host.chat(prompt)
  })

  // --------------------------------------------------------------------------
  // Cooldown Functions
  // --------------------------------------------------------------------------

  // $cooldownRemaining(level) - get remaining cooldown seconds
  // level arg is optional; defaults to the command's configured cooldownType
  registry.set('cooldownRemaining', (_args, ctx) => {
    const level = (_args[0]?.trim().toLowerCase() || ctx.cooldownType?.toLowerCase() || 'user') as
      'user' | 'server' | 'global'
    const commandId = ctx.commandId || ''
    const cooldownSeconds = ctx.cooldown || 0

    if (!commandId || cooldownSeconds <= 0) return '0'

    let scopeId: string | undefined
    switch (level) {
      case 'user':
        scopeId = ctx.userId
        break
      case 'server':
        scopeId = ctx.guildId
        break
      case 'global':
        scopeId = undefined
        break
    }

    return String(host.cooldownRemaining(commandId, level, cooldownSeconds, scopeId))
  })

  return registry
}
