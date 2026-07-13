import { describe, expect, it } from 'vitest'
import { decodeBCFDCommand } from './commandCodec'

const base = () => ({
  command: '!test',
  commandDescription: 'Test',
  type: 0,
  channelMessage: '',
  privateMessage: '',
  channelEmbed: {},
  privateEmbed: {}
})

describe('decodeBCFDCommand', () => {
  it('derives canonical actions from payloads', () => {
    const result = decodeBCFDCommand(
      { ...base(), channelMessage: 'Hello', requiredRole: 'Mods', deleteNum: 2 },
      () => 'id'
    )

    expect(result.command.channelMessage).toBe('Hello')
    expect(result.command.requiredRole).toBe('Mods')
    expect(result.command.deleteNum).toBe(2)
    expect(result.command).not.toHaveProperty('actionArr')
    expect(result.command).not.toHaveProperty('isRequiredRole')
  })

  it('honors legacy false flags and clears stale payloads', () => {
    const result = decodeBCFDCommand(
      {
        ...base(),
        actionArr: [false, false],
        channelMessage: 'stale',
        requiredRole: 'stale',
        isRequiredRole: false,
        deleteNum: 12,
        deleteX: false
      },
      () => 'id'
    )

    expect(result.command.channelMessage).toBe('')
    expect(result.command.requiredRole).toBe('')
    expect(result.command.deleteNum).toBe(0)
  })

  it('normalizes the Android ignore-error alias and reports unknown fields', () => {
    const result = decodeBCFDCommand(
      { ...base(), ignoreErrorMessages: true, futureField: 'ignored' },
      () => 'id'
    )

    expect(result.command.ignoreErrorMessage).toBe(true)
    expect(result.droppedFields).toEqual(['futureField'])
  })

  it('rejects enabled legacy actions with empty payloads', () => {
    expect(() => decodeBCFDCommand({ ...base(), isReact: true }, () => 'id')).toThrow(
      'isReact is enabled but its payload is empty'
    )
  })
})
