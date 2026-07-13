import { describe, expect, it } from 'vitest'
import { applyCommandPatch, type CommandPatchChange } from './commandPatch'
import type { BCFDCommand } from '../main/types/types'

function baseCommand(): BCFDCommand {
  return {
    id: 'command-1',
    channelMessage: '',
    command: '!test',
    commandDescription: 'Test command',
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
    }
  }
}

function change(field: string, value: CommandPatchChange['value']): CommandPatchChange {
  return { field, value, reason: 'test' }
}

describe('applyCommandPatch', () => {
  it('updates a channel message without maintaining a parallel action flag', () => {
    const result = applyCommandPatch(baseCommand(), [change('channelMessage', 'Hello $namePlain')])

    expect(result.warnings).toEqual([])
    expect(result.command.channelMessage).toBe('Hello $namePlain')
    expect(result.diff.changes.map((item) => item.field)).toContain('channelMessage')
  })

  it('merges nested embed changes without maintaining a parallel action flag', () => {
    const command = baseCommand()
    command.channelEmbed.title = 'Existing'

    const result = applyCommandPatch(command, [change('channelEmbed.description', 'Welcome')])

    expect(result.warnings).toEqual([])
    expect(result.command.channelEmbed).toEqual({
      title: 'Existing',
      description: 'Welcome',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    })
  })

  it('normalizes cooldown fields when cooldown is enabled or disabled', () => {
    const enabled = applyCommandPatch(baseCommand(), [change('cooldown', 30)])
    expect(enabled.command.cooldown).toBe(30)
    expect(enabled.command.cooldownType).toBe('User')

    const disabled = applyCommandPatch(
      { ...baseCommand(), cooldown: 10, cooldownType: 'Server', cooldownMessage: 'Wait' },
      [change('cooldown', 0)]
    )
    expect(disabled.command.cooldown).toBe(0)
    expect(disabled.command.cooldownType).toBe('')
    expect(disabled.command.cooldownMessage).toBe('')
  })

  it('ignores unknown fields and wrong value types with warnings', () => {
    const result = applyCommandPatch(baseCommand(), [
      change('id', 'bad'),
      change('deleteNum', 'many')
    ])

    expect(result.command.id).toBe('command-1')
    expect(result.warnings).toEqual([
      'Unknown command field "id"',
      'Field "deleteNum" must be a number'
    ])
    expect(result.diff.changes).toEqual([])
  })
})
