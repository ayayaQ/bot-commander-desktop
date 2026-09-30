import { describe, expect, it, vi } from 'vitest'
import { saveCommandSnapshot } from './commandPersistence'

describe('saveCommandSnapshot', () => {
  it('retries the same failed add without duplicating the command', async () => {
    const command = { id: 'command-1', command: '!hello' } as any
    const desiredCommands = [command]
    const invokeSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce({ success: true, revision: 'next-revision' })

    await expect(saveCommandSnapshot(desiredCommands, 'initial', invokeSave)).rejects.toThrow(
      'disk full'
    )
    const saved = await saveCommandSnapshot(desiredCommands, 'initial', invokeSave)

    expect(saved.commands).toEqual([command])
    expect(saved.revision).toBe('next-revision')
    expect(invokeSave.mock.calls.map(([payload]) => payload.bcfdCommands)).toEqual([
      [command],
      [command]
    ])
  })

  it('does not treat a negative response as a persisted save', async () => {
    await expect(
      saveCommandSnapshot([], 'initial', async () => ({ success: false }))
    ).rejects.toThrow('not saved')
  })
})
