import { ActivityType, type Client, type PresenceStatusData, type User } from 'discord.js'

export function mutualGuildCount(client?: Client, user?: User): string {
  if (!client || !user) return ''
  return client.guilds.cache.filter((guild) => guild.members.cache.has(user.id)).size.toString()
}

export function setBotStatus(client: Client | undefined, args: string[]): string {
  if (!client || args.length !== 3) return '```MISSING ARGUMENTS IN $setStatus!```'

  const statusMap: Record<string, PresenceStatusData> = {
    idle: 'idle',
    dnd: 'dnd',
    online: 'online'
  }
  const activityMap: Record<string, ActivityType> = {
    watching: ActivityType.Watching,
    playing: ActivityType.Playing,
    listening: ActivityType.Listening,
    competing: ActivityType.Competing
  }

  const status = statusMap[args[0].trim().toLowerCase()] ?? 'online'
  const activityName = args[1].trim().toLowerCase()
  const text = args[2].trim().slice(0, 128)
  const activities =
    !text || activityName === 'reset'
      ? []
      : [{ name: text, type: activityMap[activityName] ?? ActivityType.Playing }]

  client.user?.setPresence({ status, activities })
  return ''
}
