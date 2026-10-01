import { Events, GatewayIntentBits, Partials, type Client, type ClientOptions } from 'discord.js'
import { DISCORD_DISALLOWED_INTENTS_ERROR } from '../../shared/discordSetup'

export function getDiscordClientOptions(): ClientOptions {
  return {
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      // Ban events use this standard intent; server permissions are still required.
      GatewayIntentBits.GuildModeration,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction]
  }
}

export class DiscordLoginLifetime {
  private cancelled = false
  private ready = false
  private settled = false
  private destruction: Promise<void> | undefined

  constructor(
    private readonly client: Client,
    private readonly onCleanupError: (error: unknown) => void
  ) {
    client.once(Events.ClientReady, () => {
      this.ready = true
      if (this.cancelled) void this.destroy()
    })
  }

  async login(token: string): Promise<string> {
    try {
      return await this.client.login(token)
    } finally {
      this.settled = true
      if (this.cancelled) await this.destroy()
    }
  }

  cancel(): void {
    this.cancelled = true
    // discord.js destroy() cannot cancel pending gateway discovery/spawn. Calling
    // it then sets ws.destroyed too early, allowing a later socket to escape cleanup.
    // Quarantine that attempt in botService and destroy once ready or settled.
    // Cancellation never waits for discovery/handshake or blocks a newer login.
    if (this.ready || this.settled) void this.destroy()
  }

  private destroy(): Promise<void> {
    this.destruction ??= this.client.destroy().catch(this.onCleanupError)
    return this.destruction
  }
}

type GatewayError = {
  code?: unknown
  name?: unknown
  message?: unknown
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && error.message) {
    return String(error.message)
  }
  return String(error)
}

export function formatDiscordLoginError(error: unknown): string {
  const details: GatewayError = error && typeof error === 'object' ? error : {}
  const message = getErrorMessage(error)
  // Keep other explicit Gateway close codes (particularly 4013) unchanged.
  const code = String(details.code ?? '')
  const hasOtherCloseCode = /^40\d\d$/.test(code) && code !== '4014'
  const disallowedIntents =
    !hasOtherCloseCode &&
    (code === '4014' ||
      code === 'DisallowedIntents' ||
      code === 'DISALLOWED_INTENTS' ||
      details.name === 'DisallowedIntents' ||
      details.name === 'DISALLOWED_INTENTS' ||
      /\bdisallowed intents?\b|privileged intent provided is not enabled or whitelisted/i.test(
        message
      ))

  // @discordjs/ws rejects login with Error('Used disallowed intents'), without a code.
  return disallowedIntents ? DISCORD_DISALLOWED_INTENTS_ERROR : `Login failed: ${message}`
}
