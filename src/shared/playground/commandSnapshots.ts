import { decodeBCFDCommand } from '../commandCodec'
import type { BCFDCommand } from '../../main/types/types'
import { PLAYGROUND_LIMITS } from './types'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed saved playground data')
  return value as Record<string, unknown>
}

export function snapshotCommands(value: unknown): BCFDCommand[] {
  const commands = record(value).bcfdCommands
  if (!Array.isArray(commands) || commands.length > PLAYGROUND_LIMITS.commands)
    throw new Error('Saved-command limit exceeded')
  let remaining = PLAYGROUND_LIMITS.requestBytes as number
  const count = (value: unknown) => {
    if (typeof value === 'string') {
      remaining -= value.length
      if (remaining < 0) throw new Error('Saved commands exceed the total size limit')
    }
  }
  const result = commands.map((command) => {
    const source = record(command)
    const known = [
      'id',
      'command',
      'commandDescription',
      'channelMessage',
      'privateMessage',
      'deleteIfStrings',
      'requiredRole',
      'roleToAssign',
      'reaction',
      'specificChannel',
      'specificMessage',
      'cooldownMessage',
      'cooldownType',
      'channelWhitelist',
      'serverWhitelist'
    ]
    for (const key of known) {
      count(source[key])
      if (typeof source[key] === 'string' && source[key].length > PLAYGROUND_LIMITS.template)
        throw new Error(`Saved command ${key} exceeds the limit`)
    }
    for (const key of ['channelEmbed', 'privateEmbed']) {
      if (!source[key]) continue
      const embed = record(source[key])
      for (const field of [
        'title',
        'description',
        'hexColor',
        'imageURL',
        'thumbnailURL',
        'footer'
      ]) {
        count(embed[field])
        if (typeof embed[field] === 'string' && embed[field].length > PLAYGROUND_LIMITS.template)
          throw new Error('Saved embed exceeds the limit')
      }
    }
    return decodeBCFDCommand(source, () => 'offline-missing-id').command
  })
  if (JSON.stringify(result).length > PLAYGROUND_LIMITS.requestBytes)
    throw new Error('Saved commands exceed the total size limit')
  return result
}
