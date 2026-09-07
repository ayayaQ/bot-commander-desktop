import { REST, Routes, ApplicationCommandOptionType } from 'discord.js'
import { getClient } from './botService'
import { PublicationFailure, type InteractionPublishBackend } from './interactionPublisher'
import { BCFDInteractionCommand, BCFDSlashCommandOption } from '../types/types'

function mapOptionType(type: number): ApplicationCommandOptionType {
  const mapping: Record<number, ApplicationCommandOptionType> = {
    3: ApplicationCommandOptionType.String,
    4: ApplicationCommandOptionType.Integer,
    5: ApplicationCommandOptionType.Boolean,
    6: ApplicationCommandOptionType.User,
    7: ApplicationCommandOptionType.Channel,
    8: ApplicationCommandOptionType.Role,
    10: ApplicationCommandOptionType.Number
  }
  return mapping[type] ?? ApplicationCommandOptionType.String
}

function buildSlashCommandPayload(interaction: BCFDInteractionCommand) {
  return {
    name: interaction.commandName,
    description: interaction.commandDescription || 'No description',
    options: interaction.options.map((opt: BCFDSlashCommandOption) => ({
      name: opt.name,
      description: opt.description || 'No description',
      type: mapOptionType(opt.type),
      required: opt.required,
      choices: opt.choices
    }))
  }
}

/** Capture the connected client so reconnects cannot redirect an in-flight publish. */
export function createInteractionPublishBackend(): InteractionPublishBackend {
  const client = getClient()
  if (!client?.isReady() || !client.token || !client.user) {
    throw new PublicationFailure({ code: 'bot-required' })
  }
  const rest = new REST({ version: '10' }).setToken(client.token)
  const applicationId = client.user.id
  const route = (guildId: string) =>
    guildId
      ? Routes.applicationGuildCommands(applicationId, guildId)
      : Routes.applicationCommands(applicationId)
  const requireGuild = (guildId: string) => {
    if (guildId && !client.guilds.cache.has(guildId)) {
      throw new PublicationFailure({ code: 'server-missing' })
    }
  }
  return {
    isCurrent: () => getClient() === client && client.isReady(),
    async replace(guildId, commands) {
      requireGuild(guildId)
      await rest.put(route(guildId), { body: commands.map(buildSlashCommandPayload) })
    },
    async register(command) {
      requireGuild(command.guildId || '')
      await rest.post(route(command.guildId || ''), { body: buildSlashCommandPayload(command) })
    },
    async unregister(command) {
      const guildId = command.guildId || ''
      requireGuild(guildId)
      const remote = (await rest.get(route(guildId))) as Array<{
        id: string
        name: string
        type: number
      }>
      const found = remote.find((item) => item.type === 1 && item.name === command.commandName)
      if (found) {
        await rest.delete(
          guildId
            ? Routes.applicationGuildCommand(applicationId, guildId, found.id)
            : Routes.applicationCommand(applicationId, found.id)
        )
      }
    }
  }
}
