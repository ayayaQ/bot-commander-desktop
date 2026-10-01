import { describe, expect, it } from 'vitest'
import { PlaygroundSavedData } from './playgroundSavedData'
import { snapshotCommands, snapshotInteractions } from '../../../shared/playground/snapshots'

const savedInteraction = () => ({
  id: 'slash',
  commandName: 'test',
  commandDescription: 'Test',
  options: [],
  rootAction: { buttons: [] },
  isRegistered: false
})
const deferred = () => {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => (resolve = done))
  return { promise, resolve }
}

describe('bounded read-only saved playground snapshots', () => {
  it('keeps interaction-only data usable when message commands are empty or unavailable', async () => {
    for (const fail of [false, true]) {
      const channels: string[] = [],
        loader = new PlaygroundSavedData()
      const result = await loader.load(async (channel) => {
        channels.push(channel)
        if (channel === 'get-interactions') return [savedInteraction()]
        if (fail) throw new Error('commands unavailable')
        return { bcfdCommands: [] }
      })
      expect(channels).toEqual(['get-commands', 'get-interactions'])
      expect(result?.commands).toEqual([])
      expect(result?.interactions[0].commandName).toBe('test')
      expect(result?.errors.length).toBe(fail ? 1 : 0)
    }
  })

  it('preserves valid command data when interaction data is malformed', async () => {
    const loader = new PlaygroundSavedData()
    const result = await loader.load(async (channel) =>
      channel === 'get-commands'
        ? {
            bcfdCommands: [
              {
                command: '!test',
                commandDescription: 'Test',
                type: 0,
                channelMessage: 'hello',
                privateMessage: '',
                channelEmbed: {},
                privateEmbed: {}
              }
            ]
          }
        : [{ ...savedInteraction(), options: 'invalid' }]
    )
    expect(result?.commands).toHaveLength(1)
    expect(result?.interactions).toEqual([])
    expect(result?.errors[0]).toContain('option count')
  })

  it('rejects oversized/malformed option and choice arrays before renderer assignment', () => {
    expect(() =>
      snapshotInteractions([
        {
          ...savedInteraction(),
          options: Array.from({ length: 50_000 }, () => ({ name: 'v', type: 3 }))
        }
      ])
    ).toThrow('option count')
    expect(() =>
      snapshotInteractions([
        {
          ...savedInteraction(),
          options: [
            {
              name: 'v',
              type: 3,
              choices: Array.from({ length: 26 }, () => ({ name: 'choice', value: 'x' }))
            }
          ]
        }
      ])
    ).toThrow('choice count')
    expect(() =>
      snapshotInteractions([{ ...savedInteraction(), options: [{ name: 'x', type: 99 }] }])
    ).toThrow('option type')
    expect(() =>
      snapshotInteractions([{ ...savedInteraction(), commandName: 'x'.repeat(100_000) }])
    ).toThrow('text')
    expect(() => snapshotInteractions([{ ...savedInteraction(), rootAction: null }])).toThrow(
      'Malformed'
    )
  })

  it('rejects deep/cyclic/oversized button trees and total sanitized snapshot size', () => {
    let root: Record<string, unknown> = { buttons: [] }
    for (let index = 0; index < 20; index++)
      root = { buttons: [{ customId: 'b', style: 1, label: 'Button', action: root }] }
    expect(() => snapshotInteractions([{ ...savedInteraction(), rootAction: root }])).toThrow(
      'tree'
    )
    const cyclic: Record<string, unknown> = { buttons: [] }
    cyclic.buttons = [{ customId: 'b', style: 1, action: cyclic }]
    expect(() => snapshotInteractions([{ ...savedInteraction(), rootAction: cyclic }])).toThrow(
      'cyclic'
    )
    const records = Array.from({ length: 200 }, (_, index) => ({
      ...savedInteraction(),
      id: String(index),
      rootAction: { buttons: [], channelMessage: 'x'.repeat(16_000) }
    }))
    expect(() => snapshotInteractions(records)).toThrow('total size')
  })

  it('normalizes valid data into detached known fields and bounds message command sources', () => {
    const source = {
      ...savedInteraction(),
      unknownLargeValue: 'x'.repeat(100_000),
      rootAction: { buttons: [] }
    }
    const snapshot = snapshotInteractions([source])
    expect(snapshot[0]).not.toHaveProperty('unknownLargeValue')
    source.rootAction.buttons.push({} as never)
    expect(snapshot[0].rootAction.buttons).toEqual([])
    expect(() =>
      snapshotCommands({
        bcfdCommands: [
          {
            command: '!test',
            commandDescription: 'Test',
            type: 0,
            channelMessage: 'x'.repeat(16_385),
            privateMessage: '',
            channelEmbed: {},
            privateEmbed: {}
          }
        ]
      })
    ).toThrow('limit')
  })

  it('reset/navigation cancellation discards pending reads and newer load supersedes older reads', async () => {
    const first = deferred(),
      loader = new PlaygroundSavedData()
    const old = loader.load(async (channel) =>
      channel === 'get-commands' ? first.promise : [savedInteraction()]
    )
    loader.cancel()
    first.resolve({ bcfdCommands: [] })
    await expect(old).resolves.toBeUndefined()
    const second = deferred()
    const stale = loader.load(async (channel) =>
      channel === 'get-commands' ? second.promise : [savedInteraction()]
    )
    const current = await loader.load(async (channel) =>
      channel === 'get-commands' ? { bcfdCommands: [] } : []
    )
    second.resolve({ bcfdCommands: [] })
    await expect(stale).resolves.toBeUndefined()
    expect(current?.interactions).toEqual([])
  })
})
