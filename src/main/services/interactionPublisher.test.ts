import { describe, expect, it, vi } from 'vitest'
import type { BCFDInteractionCommand } from '../types/types'
import {
  InteractionPublisher,
  PublicationFailure,
  applyPublicationResults,
  type InteractionPublishBackend
} from './interactionPublisher'

function command(id: string, guildId = ''): BCFDInteractionCommand {
  return {
    id,
    commandName: id,
    commandDescription: 'Test',
    guildId,
    options: [],
    rootAction: {} as BCFDInteractionCommand['rootAction'],
    isRegistered: false
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup(initial = [command('hello')]) {
  let current = initial
  const backend: InteractionPublishBackend = {
    replace: vi.fn().mockResolvedValue(undefined),
    register: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(undefined),
    isCurrent: vi.fn().mockReturnValue(true)
  }
  const commit = vi.fn(async (results) => applyPublicationResults(current, results))
  const createBackend = vi.fn(() => backend)
  const publisher = new InteractionPublisher({
    read: () => current,
    backend: createBackend,
    commit
  })
  return {
    publisher,
    backend,
    commit,
    createBackend,
    current,
    replaceCurrent: (next: BCFDInteractionCommand[]) => {
      current = next
    }
  }
}

describe('interaction publication', () => {
  it('waits for Discord, exposes pending state and rejects overlapping publication', async () => {
    const { publisher, backend, current, commit } = setup()
    const gate = deferred()
    vi.mocked(backend.replace).mockReturnValue(gate.promise)
    const publishing = publisher.publish('sync')
    expect(publisher.getState()).toMatchObject({
      busy: true,
      pendingIds: ['hello'],
      completed: false
    })
    expect(current[0].isRegistered).toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect((await publisher.publish('register', 'hello')).success).toBe(false)
    expect(backend.register).not.toHaveBeenCalled()
    gate.resolve()
    expect((await publishing).success).toBe(true)
    expect(current[0].isRegistered).toBe(true)
    expect(publisher.getState()).toMatchObject({ busy: false, pendingIds: [], completed: true })
  })

  it('preserves successful servers when another server fails and permits retry', async () => {
    const { publisher, backend, current } = setup([
      command('global'),
      command('bad', 'missing'),
      command('good', 'server')
    ])
    vi.mocked(backend.replace).mockImplementation(async (guildId) => {
      if (guildId === 'missing') throw new PublicationFailure({ code: 'server-missing' })
    })
    expect((await publisher.publish('sync')).success).toBe(false)
    expect(vi.mocked(backend.replace).mock.calls.map(([scope]) => scope)).toEqual([
      '',
      'missing',
      'server'
    ])
    expect(current.map((c) => c.isRegistered)).toEqual([true, false, true])
    expect(publisher.getState().failedIds).toEqual(['bad'])
    vi.mocked(backend.replace).mockResolvedValue(undefined)
    await publisher.publish('sync')
    expect(publisher.getState().failedIds).toEqual([])
    expect(current.every((c) => c.isRegistered)).toBe(true)
  })

  it('submits the empty global scope, including with only server commands', async () => {
    const { publisher, backend } = setup([command('hello', 'server')])
    await publisher.publish('sync')
    expect(backend.replace).toHaveBeenNthCalledWith(1, '', [])
    expect(backend.replace).toHaveBeenNthCalledWith(2, 'server', [
      expect.objectContaining({ id: 'hello' })
    ])
    const empty = setup([])
    await empty.publisher.publish('sync')
    expect(empty.backend.replace).toHaveBeenCalledWith('', [])
  })

  it('rejects duplicate names per scope without blocking another scope', async () => {
    const first = command('first')
    const second = { ...command('second'), commandName: first.commandName }
    const other = { ...command('third', 'server'), commandName: first.commandName }
    const { publisher, backend } = setup([first, second, other])
    await publisher.publish('sync')
    expect(backend.replace).toHaveBeenCalledTimes(1)
    expect(backend.replace).toHaveBeenCalledWith('server', [{ ...other, isRegistered: false }])
    expect(publisher.getState().failedIds).toEqual(['first', 'second'])
  })

  it('uses a snapshot and never marks a newer edit published or restores a deleted item', async () => {
    const { publisher, backend, current, replaceCurrent } = setup([
      command('hello'),
      command('removed')
    ])
    const gate = deferred()
    vi.mocked(backend.replace).mockReturnValue(gate.promise)
    const publishing = publisher.publish('sync')
    current[0].commandDescription = 'New description'
    replaceCurrent([current[0]])
    expect(vi.mocked(backend.replace).mock.calls[0][1][0].commandDescription).toBe('Test')
    gate.resolve()
    expect((await publishing).success).toBe(false)
    expect(current[0].isRegistered).toBe(false)
    expect(publisher.getState().staleIds).toEqual(['hello', 'removed'])
  })

  it('keeps the registration flag on failed unregister and updates only after confirmation', async () => {
    const original = { ...command('hello'), isRegistered: true }
    const { publisher, backend } = setup([original])
    vi.mocked(backend.unregister).mockRejectedValue(new Error('Request failed'))
    await publisher.publish('unregister', original.id)
    expect(original.isRegistered).toBe(true)
    expect(publisher.getState().failedIds).toEqual(['hello'])
    vi.mocked(backend.unregister).mockResolvedValue(undefined)
    await publisher.publish('unregister', original.id)
    expect(original.isRegistered).toBe(false)
  })

  it('does not apply results to another bot after reconnecting', async () => {
    const { publisher, backend, commit } = setup()
    const gate = deferred()
    vi.mocked(backend.replace).mockReturnValue(gate.promise)
    const publishing = publisher.publish('sync')
    vi.mocked(backend.isCurrent).mockReturnValue(false)
    gate.resolve()
    await publishing
    expect(commit).not.toHaveBeenCalled()
    expect(publisher.getState().error?.code).toBe('connection-changed')
  })

  it('reports missing connections and releases busy state', async () => {
    const { publisher, createBackend } = setup()
    createBackend.mockImplementation(() => {
      throw new PublicationFailure({ code: 'bot-required' })
    })
    await publisher.publish('sync')
    expect(publisher.getState()).toMatchObject({ busy: false, error: { code: 'bot-required' } })
  })

  it('does not report success when confirmed status cannot be persisted', async () => {
    const { publisher, commit } = setup()
    commit.mockRejectedValue(new Error('Disk full'))
    expect((await publisher.publish('sync')).success).toBe(false)
    expect(publisher.getState().error?.code).toBe('save-failed')
  })

  it('does not mutate stored state when callers modify a status snapshot', async () => {
    const { publisher } = setup()
    await publisher.publish('sync')
    publisher.getState().targets[0].commandIds.push('unrelated')
    expect(publisher.getState().targets[0].commandIds).toEqual(['hello'])
  })
})
