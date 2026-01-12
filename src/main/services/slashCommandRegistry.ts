import { REST, Routes, ApplicationCommandOptionType } from 'discord.js'
import { getClient } from './botService'
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

export async function registerSlashCommand(interaction: BCFDInteractionCommand): Promise<void> {
  const client = getClient()
  if (!client?.token || !client.user) {
    throw new Error('Bot not connected')
  }

  const rest = new REST({ version: '10' }).setToken(client.token)
  const command = buildSlashCommandPayload(interaction)

  if (interaction.guildId) {
    // Register for a specific guild (instant)
    await rest.post(Routes.applicationGuildCommands(client.user.id, interaction.guildId), {
      body: command
    })
  } else {
    // Register globally (can take up to an hour to propagate)
    await rest.post(Routes.applicationCommands(client.user.id), { body: command })
  }
}

export async function registerSlashCommands(interactions: BCFDInteractionCommand[]): Promise<void> {
  const client = getClient()
  if (!client?.token || !client.user) {
    throw new Error('Bot not connected')
  }

  const rest = new REST({ version: '10' }).setToken(client.token)

  // Group commands by guild (null = global)
  const globalCommands: BCFDInteractionCommand[] = []
  const guildCommands: Map<string, BCFDInteractionCommand[]> = new Map()

  for (const interaction of interactions) {
    if (interaction.guildId) {
      const existing = guildCommands.get(interaction.guildId) || []
      existing.push(interaction)
      guildCommands.set(interaction.guildId, existing)
    } else {
      globalCommands.push(interaction)
    }
  }

  // Register global commands
  if (globalCommands.length > 0) {
    const commands = globalCommands.map(buildSlashCommandPayload)
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
  }

  // Register guild-specific commands
  for (const [guildId, guildInteractions] of guildCommands) {
    const commands = guildInteractions.map(buildSlashCommandPayload)
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands })
  }
}

export async function unregisterSlashCommand(
  interaction: BCFDInteractionCommand,
  discordCommandId?: string
): Promise<void> {
  const client = getClient()
  if (!client?.token || !client.user) {
    throw new Error('Bot not connected')
  }

  if (!discordCommandId) {
    // If no Discord command ID provided, we need to find it by name
    const rest = new REST({ version: '10' }).setToken(client.token)

    if (interaction.guildId) {
      const commands = (await rest.get(
        Routes.applicationGuildCommands(client.user.id, interaction.guildId)
      )) as Array<{ id: string; name: string }>
      const found = commands.find((c) => c.name === interaction.commandName)
      if (found) {
        await rest.delete(
          Routes.applicationGuildCommand(client.user.id, interaction.guildId, found.id)
        )
      }
    } else {
      const commands = (await rest.get(Routes.applicationCommands(client.user.id))) as Array<{
        id: string
        name: string
      }>
      const found = commands.find((c) => c.name === interaction.commandName)
      if (found) {
        await rest.delete(Routes.applicationCommand(client.user.id, found.id))
      }
    }
  } else {
    const rest = new REST({ version: '10' }).setToken(client.token)

    if (interaction.guildId) {
      await rest.delete(
        Routes.applicationGuildCommand(client.user.id, interaction.guildId, discordCommandId)
      )
    } else {
      await rest.delete(Routes.applicationCommand(client.user.id, discordCommandId))
    }
  }
}

export async function syncAllSlashCommands(
  interactions: BCFDInteractionCommand[]
): Promise<void> {
  const client = getClient()
  if (!client?.token || !client.user) {
    throw new Error('Bot not connected')
  }

  const rest = new REST({ version: '10' }).setToken(client.token)

  // Build payload for all interactions
  const commands = interactions.map(buildSlashCommandPayload)

  // This will sync all commands - adding new ones, updating existing ones, and removing old ones
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands })
}
