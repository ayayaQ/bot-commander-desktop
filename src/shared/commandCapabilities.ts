export type CommandEmbed = {
  title: string
  description: string
  hexColor: string
  imageURL: string
  thumbnailURL: string
  footer: string
}

export function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function hasEmbedContent(embed: CommandEmbed | null | undefined): boolean {
  if (!embed) return false
  return [embed.title, embed.description, embed.footer, embed.imageURL, embed.thumbnailURL].some(
    hasText
  )
}

export const commandCapabilities = {
  sendsChannelMessage: (command: { channelMessage: string }): boolean =>
    hasText(command.channelMessage),
  sendsPrivateMessage: (command: { privateMessage: string }): boolean =>
    hasText(command.privateMessage),
  sendsChannelEmbed: (command: { channelEmbed: CommandEmbed }): boolean =>
    hasEmbedContent(command.channelEmbed),
  sendsPrivateEmbed: (command: { privateEmbed: CommandEmbed }): boolean =>
    hasEmbedContent(command.privateEmbed),
  hasRequiredRole: (command: { requiredRole: string }): boolean => hasText(command.requiredRole),
  assignsRole: (command: { roleToAssign: string }): boolean => hasText(command.roleToAssign),
  usesSpecificChannel: (command: { specificChannel: string }): boolean =>
    hasText(command.specificChannel),
  usesSpecificMessage: (command: { specificMessage: string }): boolean =>
    hasText(command.specificMessage),
  reacts: (command: { reaction: string }): boolean => hasText(command.reaction),
  deletesIfMatched: (command: { deleteIfStrings: string }): boolean =>
    hasText(command.deleteIfStrings),
  deletesMessages: (command: { deleteNum: number }): boolean => command.deleteNum > 0,
  limitsChannels: (command: { channelWhitelist?: string }): boolean =>
    hasText(command.channelWhitelist),
  limitsServers: (command: { serverWhitelist?: string }): boolean => hasText(command.serverWhitelist)
}
