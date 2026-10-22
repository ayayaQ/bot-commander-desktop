// Discord wire values, kept independent of the Discord SDK in worker bundles.
export enum ChannelType {
  GuildText = 0,
  DM = 1,
  GuildVoice = 2,
  GuildCategory = 4,
  GuildAnnouncement = 5,
  GuildStageVoice = 13,
  GuildForum = 15,
  GuildMedia = 16
}
export const PermissionsBitField = {
  Flags: { Administrator: 8n, ViewChannel: 1024n, SendMessages: 2048n, ManageRoles: 268435456n }
} as const
export const OAuth2Scopes = { Bot: 'bot' } as const
