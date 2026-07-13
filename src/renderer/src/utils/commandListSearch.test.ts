import { describe, expect, it } from 'vitest'
import {
  filterCommands,
  getVisibleCommands,
  sortCommands,
  type CommandSortMode,
  type CommandTypeFilter
} from './commandListSearch'
import type { BCFDCommand } from '../types/types'

function command(overrides: Partial<BCFDCommand> = {}): BCFDCommand {
  return {
    id: crypto.randomUUID(),
    channelMessage: '',
    command: '',
    commandDescription: '',
    deleteAfter: false,
    deleteIfStrings: '',
    deleteNum: 0,
    ignoreErrorMessage: false,
    isBan: false,
    isKick: false,
    isNSFW: false,
    requiredRole: '',
    isVoiceMute: false,
    isAdmin: false,
    phrase: false,
    privateMessage: '',
    reaction: '',
    roleToAssign: '',
    specificChannel: '',
    specificMessage: '',
    startsWith: false,
    type: 0,
    channelEmbed: {
      title: '',
      description: '',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    },
    privateEmbed: {
      title: '',
      description: '',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    },
    ...overrides
  }
}

const commands = [
  command({ id: 'bravo', command: '!bravo', commandDescription: 'Moderation tools', type: 0 }),
  command({ id: 'alpha', command: '!alpha', commandDescription: 'Greeting command', type: 1 }),
  command({ id: 'join', command: '', commandDescription: 'Welcome new users', type: 2 }),
  command({ id: 'reaction', command: 'zeta', commandDescription: 'Reaction response', type: 5 }),
  command({ id: 'also-alpha', command: '!alpha', commandDescription: 'Duplicate name', type: 0 })
]

describe('command list search utilities', () => {
  it('searches command trigger and description case-insensitively', () => {
    expect(filterCommands(commands, ' GREETING ', 'all').map((c) => c.id)).toEqual(['alpha'])
    expect(filterCommands(commands, 'BRAVO', 'all').map((c) => c.id)).toEqual(['bravo'])
  })

  it('filters by command type', () => {
    expect(filterCommands(commands, '', '0').map((c) => c.id)).toEqual(['bravo', 'also-alpha'])
    expect(filterCommands(commands, '', '5').map((c) => c.id)).toEqual(['reaction'])
  })

  it('combines search and type filters', () => {
    expect(filterCommands(commands, 'alpha', '0').map((c) => c.id)).toEqual(['also-alpha'])
  })

  it('preserves manual order by default', () => {
    expect(sortCommands(commands, 'manual').map((c) => c.id)).toEqual([
      'bravo',
      'alpha',
      'join',
      'reaction',
      'also-alpha'
    ])
  })

  it('sorts by display name in both directions', () => {
    expect(sortCommands(commands, 'name-asc').map((c) => c.id)).toEqual([
      'alpha',
      'also-alpha',
      'bravo',
      'join',
      'reaction'
    ])
    expect(sortCommands(commands, 'name-desc').map((c) => c.id)).toEqual([
      'reaction',
      'join',
      'bravo',
      'alpha',
      'also-alpha'
    ])
  })

  it('groups by type while keeping ties stable', () => {
    expect(sortCommands(commands, 'type').map((c) => c.id)).toEqual([
      'bravo',
      'also-alpha',
      'alpha',
      'join',
      'reaction'
    ])
  })

  it('does not mutate the input array', () => {
    const originalOrder = commands.map((c) => c.id)
    getVisibleCommands(commands, 'command', 'all', 'name-asc')
    expect(commands.map((c) => c.id)).toEqual(originalOrder)
  })

  it('accepts all supported type and sort values', () => {
    const typeFilters: CommandTypeFilter[] = ['all', '0', '1', '2', '3', '4', '5']
    const sortModes: CommandSortMode[] = ['manual', 'name-asc', 'name-desc', 'type']

    for (const typeFilter of typeFilters) {
      for (const sortMode of sortModes) {
        expect(() => getVisibleCommands(commands, '', typeFilter, sortMode)).not.toThrow()
      }
    }
  })
})
