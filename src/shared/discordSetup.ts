export const DISCORD_DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications'

export const DISCORD_PRIVILEGED_INTENTS_HELP =
  'Open Discord Developer Portal → your application → Bot → Privileged Gateway Intents. ' +
  'Enable Server Members Intent and Message Content Intent, save your changes, then try Login again. ' +
  'If Discord requires approval for your app, obtain approval for those intents first.'

export const DISCORD_DISALLOWED_INTENTS_ERROR = `Login failed: Discord rejected the requested privileged intents (4014). ${DISCORD_PRIVILEGED_INTENTS_HELP}`

export function isDiscordIntentSetupError(message: string): boolean {
  return message === DISCORD_DISALLOWED_INTENTS_ERROR
}
