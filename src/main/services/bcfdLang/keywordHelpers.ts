import type { Client, User } from 'discord.js'
import { parsePresence } from '../../../shared/runtime/presence'

export function mutualGuildCount(client?: Client, user?: User): string {
  if (!client || !user) return ''
  return client.guilds.cache.filter((guild) => guild.members.cache.has(user.id)).size.toString()
}

export function setBotStatus(client: Client | undefined, args: string[]): string {
  if (!client || args.length !== 3) return '```MISSING ARGUMENTS IN $setStatus!```'

  const presence = parsePresence(args)!
  client.user?.setPresence(presence)
  return ''
}
