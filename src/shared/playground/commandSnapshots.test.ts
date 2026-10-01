import { describe, expect, it } from 'vitest'
import { snapshotCommands } from './commandSnapshots'
const command = () => ({
  id: 'saved',
  command: '!test',
  commandDescription: 'Test',
  type: 0,
  channelMessage: '',
  privateMessage: '',
  channelEmbed: {},
  privateEmbed: {}
})

describe('bounded saved message-command snapshots', () => {
  it('normalizes and detaches known saved fields without copying unknown data', () => {
    const source = { ...command(), ignored: 'large ignored data', channelEmbed: { title: 'Hello' } }
    const result = snapshotCommands({ bcfdCommands: [source] })
    expect(result[0]).not.toHaveProperty('ignored')
    source.channelEmbed.title = 'Changed'
    expect(result[0].channelEmbed.title).toBe('Hello')
  })
  it('rejects malformed, oversized, and aggregate oversized sources before assignment', () => {
    expect(() => snapshotCommands({ bcfdCommands: null })).toThrow('limit')
    expect(() =>
      snapshotCommands({ bcfdCommands: [{ ...command(), cooldownType: 'x'.repeat(16_385) }] })
    ).toThrow('limit')
    expect(() =>
      snapshotCommands({ bcfdCommands: [{ ...command(), channelMessage: 'x'.repeat(16_385) }] })
    ).toThrow('limit')
    expect(() =>
      snapshotCommands({
        bcfdCommands: [{ ...command(), channelEmbed: { title: 'x'.repeat(16_385) } }]
      })
    ).toThrow('limit')
    expect(() =>
      snapshotCommands({
        bcfdCommands: Array.from({ length: 200 }, () => ({
          ...command(),
          channelMessage: 'x'.repeat(16_000)
        }))
      })
    ).toThrow('total size')
  })
})
