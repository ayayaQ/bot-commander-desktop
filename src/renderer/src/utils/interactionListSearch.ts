import type { BCFDInteractionCommand } from '../types/types'
import type { TranslationKey } from '../stores/localisation'

export type InteractionStatusFilter = 'all' | 'registered' | 'not-registered'
export type InteractionSortMode =
  | 'manual'
  | 'name-asc'
  | 'name-desc'
  | 'registered-first'
  | 'not-registered-first'

export type InteractionStatusOption = {
  value: InteractionStatusFilter
  labelKey: TranslationKey
}

export const interactionStatusOptions: InteractionStatusOption[] = [
  { value: 'all', labelKey: 'all-statuses' },
  { value: 'registered', labelKey: 'registered' },
  { value: 'not-registered', labelKey: 'not-registered' }
]

function searchableText(interaction: BCFDInteractionCommand): string {
  return `${interaction.commandName ?? ''} ${interaction.commandDescription ?? ''}`.toLowerCase()
}

function interactionName(interaction: BCFDInteractionCommand): string {
  return (interaction.commandName || 'Unnamed').toLocaleLowerCase()
}

function statusRank(interaction: BCFDInteractionCommand, sortMode: InteractionSortMode): number {
  if (sortMode === 'registered-first') return interaction.isRegistered ? 0 : 1
  if (sortMode === 'not-registered-first') return interaction.isRegistered ? 1 : 0
  return 0
}

export function filterInteractions(
  interactions: BCFDInteractionCommand[],
  searchQuery: string,
  statusFilter: InteractionStatusFilter
): BCFDInteractionCommand[] {
  const normalizedQuery = searchQuery.trim().toLowerCase()

  return interactions.filter((interaction) => {
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'registered' && interaction.isRegistered) ||
      (statusFilter === 'not-registered' && !interaction.isRegistered)
    const matchesSearch =
      !normalizedQuery || searchableText(interaction).includes(normalizedQuery)

    return matchesStatus && matchesSearch
  })
}

export function sortInteractions(
  interactions: BCFDInteractionCommand[],
  sortMode: InteractionSortMode
): BCFDInteractionCommand[] {
  const indexedInteractions = interactions.map((interaction, index) => ({ interaction, index }))

  indexedInteractions.sort((a, b) => {
    switch (sortMode) {
      case 'name-asc':
        return (
          interactionName(a.interaction).localeCompare(interactionName(b.interaction)) ||
          a.index - b.index
        )
      case 'name-desc':
        return (
          interactionName(b.interaction).localeCompare(interactionName(a.interaction)) ||
          a.index - b.index
        )
      case 'registered-first':
      case 'not-registered-first':
        return (
          statusRank(a.interaction, sortMode) - statusRank(b.interaction, sortMode) ||
          a.index - b.index
        )
      case 'manual':
      default:
        return a.index - b.index
    }
  })

  return indexedInteractions.map(({ interaction }) => interaction)
}

export function getVisibleInteractions(
  interactions: BCFDInteractionCommand[],
  searchQuery: string,
  statusFilter: InteractionStatusFilter,
  sortMode: InteractionSortMode
): BCFDInteractionCommand[] {
  return sortInteractions(filterInteractions(interactions, searchQuery, statusFilter), sortMode)
}
