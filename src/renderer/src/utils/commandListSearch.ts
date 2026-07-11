import type { BCFDCommand, BCFDCommandType } from '../types/types'
import type { TranslationKey } from '../stores/localisation'

export type CommandTypeFilter = 'all' | `${BCFDCommandType}`
export type CommandSortMode = 'manual' | 'name-asc' | 'name-desc' | 'type'

export type CommandTypeOption = {
  value: CommandTypeFilter
  labelKey: TranslationKey
  icon: string
}

export const commandTypeOptions: CommandTypeOption[] = [
  { value: 'all', labelKey: 'all-types', icon: 'apps' },
  { value: '0', labelKey: 'message-received', icon: 'message' },
  { value: '1', labelKey: 'private-message-received', icon: 'chat' },
  { value: '2', labelKey: 'member-join', icon: 'person_add' },
  { value: '3', labelKey: 'member-leave', icon: 'exit_to_app' },
  { value: '4', labelKey: 'member-ban', icon: 'person_remove' },
  { value: '5', labelKey: 'reaction', icon: 'thumb_up' }
]

export function displayNameForCommand(command: BCFDCommand): string {
  switch (command.type) {
    case 2:
      return 'Member Join'
    case 3:
      return 'Member Leave'
    case 4:
      return 'Member Ban'
    default:
      return command.command
  }
}

function searchableText(command: BCFDCommand): string {
  return `${command.command ?? ''} ${command.commandDescription ?? ''}`.toLowerCase()
}

function commandName(command: BCFDCommand): string {
  return displayNameForCommand(command).toLocaleLowerCase()
}

export function filterCommands(
  commands: BCFDCommand[],
  searchQuery: string,
  typeFilter: CommandTypeFilter
): BCFDCommand[] {
  const normalizedQuery = searchQuery.trim().toLowerCase()

  return commands.filter((command) => {
    const matchesType = typeFilter === 'all' || command.type === Number(typeFilter)
    const matchesSearch = !normalizedQuery || searchableText(command).includes(normalizedQuery)
    return matchesType && matchesSearch
  })
}

export function sortCommands(commands: BCFDCommand[], sortMode: CommandSortMode): BCFDCommand[] {
  const indexedCommands = commands.map((command, index) => ({ command, index }))

  indexedCommands.sort((a, b) => {
    switch (sortMode) {
      case 'name-asc':
        return commandName(a.command).localeCompare(commandName(b.command)) || a.index - b.index
      case 'name-desc':
        return commandName(b.command).localeCompare(commandName(a.command)) || a.index - b.index
      case 'type':
        return a.command.type - b.command.type || a.index - b.index
      case 'manual':
      default:
        return a.index - b.index
    }
  })

  return indexedCommands.map(({ command }) => command)
}

export function getVisibleCommands(
  commands: BCFDCommand[],
  searchQuery: string,
  typeFilter: CommandTypeFilter,
  sortMode: CommandSortMode
): BCFDCommand[] {
  return sortCommands(filterCommands(commands, searchQuery, typeFilter), sortMode)
}
