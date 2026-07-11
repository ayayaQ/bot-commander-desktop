import { describe, expect, it } from 'vitest'
import {
  filterInteractions,
  getVisibleInteractions,
  sortInteractions,
  type InteractionSortMode,
  type InteractionStatusFilter
} from './interactionListSearch'
import type { BCFDInteractionCommand } from '../types/types'

function interaction(overrides: Partial<BCFDInteractionCommand> = {}): BCFDInteractionCommand {
  return {
    id: crypto.randomUUID(),
    commandName: '',
    commandDescription: '',
    options: [],
    isRegistered: false,
    rootAction: {
      sendChannelMessage: false,
      channelMessage: '',
      sendPrivateMessage: false,
      privateMessage: '',
      sendChannelEmbed: false,
      channelEmbed: {
        title: '',
        description: '',
        hexColor: '',
        imageURL: '',
        thumbnailURL: '',
        footer: ''
      },
      sendPrivateEmbed: false,
      privateEmbed: {
        title: '',
        description: '',
        hexColor: '',
        imageURL: '',
        thumbnailURL: '',
        footer: ''
      },
      isRoleAssigner: false,
      roleToAssign: '',
      isKick: false,
      isBan: false,
      isVoiceMute: false,
      targetUserOptionName: '',
      deleteX: false,
      deleteNum: 0,
      ephemeral: false,
      deferReply: false,
      buttons: []
    },
    ...overrides
  }
}

const interactions = [
  interaction({ id: 'bravo', commandName: 'bravo', commandDescription: 'Moderation tools' }),
  interaction({
    id: 'alpha',
    commandName: 'alpha',
    commandDescription: 'Greeting command',
    isRegistered: true
  }),
  interaction({ id: 'zeta', commandName: 'zeta', commandDescription: 'Status lookup' }),
  interaction({
    id: 'also-alpha',
    commandName: 'alpha',
    commandDescription: 'Duplicate name',
    isRegistered: true
  })
]

describe('interaction list search utilities', () => {
  it('searches name and description case-insensitively', () => {
    expect(filterInteractions(interactions, ' GREETING ', 'all').map((i) => i.id)).toEqual([
      'alpha'
    ])
    expect(filterInteractions(interactions, 'BRAVO', 'all').map((i) => i.id)).toEqual(['bravo'])
  })

  it('filters by registration status', () => {
    expect(filterInteractions(interactions, '', 'registered').map((i) => i.id)).toEqual([
      'alpha',
      'also-alpha'
    ])
    expect(filterInteractions(interactions, '', 'not-registered').map((i) => i.id)).toEqual([
      'bravo',
      'zeta'
    ])
  })

  it('combines search and status filters', () => {
    expect(filterInteractions(interactions, 'alpha', 'registered').map((i) => i.id)).toEqual([
      'alpha',
      'also-alpha'
    ])
    expect(filterInteractions(interactions, 'alpha', 'not-registered')).toEqual([])
  })

  it('preserves manual order by default', () => {
    expect(sortInteractions(interactions, 'manual').map((i) => i.id)).toEqual([
      'bravo',
      'alpha',
      'zeta',
      'also-alpha'
    ])
  })

  it('sorts by command name in both directions with stable ties', () => {
    expect(sortInteractions(interactions, 'name-asc').map((i) => i.id)).toEqual([
      'alpha',
      'also-alpha',
      'bravo',
      'zeta'
    ])
    expect(sortInteractions(interactions, 'name-desc').map((i) => i.id)).toEqual([
      'zeta',
      'bravo',
      'alpha',
      'also-alpha'
    ])
  })

  it('sorts by registration status with stable ties', () => {
    expect(sortInteractions(interactions, 'registered-first').map((i) => i.id)).toEqual([
      'alpha',
      'also-alpha',
      'bravo',
      'zeta'
    ])
    expect(sortInteractions(interactions, 'not-registered-first').map((i) => i.id)).toEqual([
      'bravo',
      'zeta',
      'alpha',
      'also-alpha'
    ])
  })

  it('does not mutate the input array', () => {
    const originalOrder = interactions.map((i) => i.id)
    getVisibleInteractions(interactions, 'a', 'all', 'name-asc')
    expect(interactions.map((i) => i.id)).toEqual(originalOrder)
  })

  it('accepts all supported status and sort values', () => {
    const statusFilters: InteractionStatusFilter[] = ['all', 'registered', 'not-registered']
    const sortModes: InteractionSortMode[] = [
      'manual',
      'name-asc',
      'name-desc',
      'registered-first',
      'not-registered-first'
    ]

    for (const statusFilter of statusFilters) {
      for (const sortMode of sortModes) {
        expect(() => getVisibleInteractions(interactions, '', statusFilter, sortMode)).not.toThrow()
      }
    }
  })
})
