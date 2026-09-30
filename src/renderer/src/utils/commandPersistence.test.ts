import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { decodeBCFDCommand } from '../../../shared/commandCodec'
import { createCommandPersistence, prepareCommandImports } from './commandPersistence'

function command(id: string) {
  return decodeBCFDCommand({
    id,
    command: '!hello',
    commandDescription: 'Greeting',
    type: 0,
    channelMessage: 'Hello',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {}
  }).command
}

describe('command persistence model', () => {
  it.each(['add', 'import', 'duplicate', 'remove', 'update'])(
    'stages %s without changing the saved list and retries the exact snapshot once',
    async (operation) => {
      const original = command('original')
      let live = [original]
      let revision = 'disk-before'
      const next =
        operation === 'remove'
          ? []
          : operation === 'update'
            ? [{ ...original, commandDescription: 'Edited' }]
            : [
                ...live,
                ...prepareCommandImports(
                  [command(operation === 'duplicate' ? 'original' : operation)],
                  live,
                  () => 'stable-new-id'
                )
              ]
      const persist = vi
        .fn()
        .mockRejectedValueOnce(new Error('Disk full'))
        .mockResolvedValueOnce({ success: true, revision: 'disk-after' })
      const onSaved = vi.fn()
      const model = createCommandPersistence(persist, (snapshot, savedRevision) => {
        live = snapshot.bcfdCommands
        revision = savedRevision
      })

      expect(await model.save({ bcfdCommands: next, expectedRevision: revision }, onSaved)).toBe(
        false
      )
      expect(live).toEqual([original])
      expect(revision).toBe('disk-before')
      expect(onSaved).not.toHaveBeenCalled()
      expect(get(model.status)).toEqual({ saving: false, pending: true, error: 'Disk full' })
      if (next[0]) next[0].channelEmbed.title = 'Caller edited after failure'
      persist.mock.calls[0][0].bcfdCommands.push(command('transport-mutated'))

      expect(await model.retry()).toBe(true)
      expect(persist.mock.calls[1][0].expectedRevision).toBe('disk-before')
      expect(live.map((value) => value.id)).not.toContain('transport-mutated')
      expect(live[0]?.channelEmbed.title).not.toBe('Caller edited after failure')
      expect(revision).toBe('disk-after')
      expect(onSaved).toHaveBeenCalledTimes(1)
      expect(get(model.status)).toEqual({ saving: false, pending: false, error: '' })
      await model.retry()
      expect(persist).toHaveBeenCalledTimes(2)
    }
  )

  it('does not multiply submissions or allow discard while a save is pending', async () => {
    let resolve!: (value: { success: boolean; revision: string }) => void
    const persist = vi.fn(
      () =>
        new Promise<{ success: boolean; revision: string }>((yes) => {
          resolve = yes
        })
    )
    const commit = vi.fn()
    const model = createCommandPersistence(persist, commit)
    const saving = model.save({ bcfdCommands: [command('first')], expectedRevision: 'revision' })
    await Promise.resolve()
    expect(
      await model.save({ bcfdCommands: [command('second')], expectedRevision: 'revision' })
    ).toBe(false)
    expect(model.discard()).toBe(false)
    expect(model.retry()).toBe(saving)
    resolve({ success: true, revision: 'next' })
    expect(await saving).toBe(true)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0].bcfdCommands[0].id).toBe('first')
  })

  it('contains synchronous transport errors, preserves pending state, and permits retry', async () => {
    const persist = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Bridge unavailable')
      })
      .mockResolvedValueOnce({ success: true })
    const commit = vi.fn()
    const model = createCommandPersistence(persist, commit)
    expect(await model.save({ bcfdCommands: [], expectedRevision: 'revision' })).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(await model.retry()).toBe(true)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('allows an edited failed draft to replace its staged snapshot without adding twice', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed'))
      .mockResolvedValueOnce({ success: true })
    const commit = vi.fn()
    const model = createCommandPersistence(persist, commit)
    const draft = command('stable-draft')
    await model.save({ bcfdCommands: [draft], expectedRevision: 'revision' })
    draft.channelMessage = 'Updated draft'
    await model.save({ bcfdCommands: [draft], expectedRevision: 'revision' })
    expect(commit.mock.calls[0][0].bcfdCommands).toEqual([draft])
  })

  it('leaves the saved list untouched on an unconfirmed response or revision conflict', async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce({ success: false })
      .mockRejectedValueOnce(new Error('Commands changed externally; reload before saving'))
    const commit = vi.fn()
    const model = createCommandPersistence(persist, commit)
    expect(
      await model.save({ bcfdCommands: [command('pending')], expectedRevision: 'stale' })
    ).toBe(false)
    expect(await model.retry()).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(get(model.status).pending).toBe(true)
    expect(model.discard()).toBe(true)
    expect(get(model.status).error).toBe('')
    await model.retry()
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it('keeps a confirmed save successful if its post-save UI callback fails', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const persist = vi.fn().mockResolvedValue({ success: true, revision: 'saved' })
      const commit = vi.fn()
      const model = createCommandPersistence(persist, commit)
      expect(
        await model.save({ bcfdCommands: [command('draft')], expectedRevision: 'before' }, () => {
          throw new Error('UI effect failed')
        })
      ).toBe(true)
      expect(commit).toHaveBeenCalledTimes(1)
      expect(get(model.status)).toEqual({ saving: false, pending: false, error: '' })
      expect(await model.retry()).toBe(true)
      expect(persist).toHaveBeenCalledTimes(1)
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })

  it('normalizes colliding and missing imported IDs exactly once without changing sources', () => {
    const existing = [command('already-used')]
    const sources = [command('already-used'), command(''), command('unique'), command('unique')]
    sources[1].id = ''
    const generated = ['new-1', 'new-2', 'new-3']
    const createId = vi.fn(() => generated.shift()!)
    const imported = prepareCommandImports(sources, existing, createId)
    expect(imported.map((value) => value.id)).toEqual(['new-1', 'new-2', 'unique', 'new-3'])
    expect(new Set(imported.map((value) => value.id)).size).toBe(4)
    expect(sources[0].id).toBe('already-used')
    expect(createId).toHaveBeenCalledTimes(3)
  })
})
