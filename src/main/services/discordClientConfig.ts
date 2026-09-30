import { ClientOptions, GatewayIntentBits, Partials } from 'discord.js'

export function createDiscordClientOptions(): ClientOptions {
  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers, // GuildMemberAdd / GuildMemberRemove (privileged)
      GatewayIntentBits.GuildModeration, // GuildBanAdd; also needs Ban Members or View Audit Log
      GatewayIntentBits.GuildMessages, // MessageCreate in servers
      GatewayIntentBits.MessageContent, // Message payload content (privileged)
      GatewayIntentBits.DirectMessages, // MessageCreate in DMs
      GatewayIntentBits.GuildMessageReactions // MessageReactionAdd in servers
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
  }
}

export function formatDiscordLoginError(error: unknown): string {
  const details =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; message?: unknown })
      : undefined
  const message = typeof details?.message === 'string' ? details.message : String(error)

  // @discordjs/ws rejects login with this plain Error for Gateway close code 4014.
  if (details?.code === 4014 || details?.code === '4014' || message === 'Used disallowed intents') {
    return (
      'Login failed: Discord rejected required privileged Gateway intents. ' +
      'In Discord Developer Portal → your application → Bot → Privileged Gateway Intents, ' +
      'enable Server Members Intent and Message Content Intent, obtain approval if required, ' +
      'then try Login again.'
    )
  }

  return `Login failed: ${message}`
}
