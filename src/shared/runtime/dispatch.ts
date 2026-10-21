import type { BCFDCommand } from '../../main/types/types'

export const commandEvents = [
  'message',
  'dm',
  'memberJoin',
  'memberLeave',
  'memberBan',
  'reaction'
] as const
export type CommandEvent = (typeof commandEvents)[number]
export function matchesCommand(
  command: BCFDCommand,
  event: CommandEvent,
  content: string,
  messageId?: string
): boolean {
  if (command.type !== commandEvents.indexOf(event)) return false
  if (command.type >= 2 && command.type <= 4) return true
  if (event === 'reaction')
    return (
      content === command.command ||
      (!!command.phrase && content.toLowerCase().includes(command.command.toLowerCase())) ||
      (!!command.specificMessage && command.specificMessage === messageId)
    )
  return (
    content === command.command ||
    command.command === '*' ||
    (command.startsWith && content.startsWith(command.command)) ||
    (command.phrase && content.toLowerCase().includes(command.command.toLowerCase())) ||
    ((command.isKick || command.isBan || command.isVoiceMute) &&
      content.split(' ')[0] === command.command &&
      content.split(' ').length === 2)
  )
}
