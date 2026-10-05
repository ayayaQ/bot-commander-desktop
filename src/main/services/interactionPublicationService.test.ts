import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BCFDInteractionCommand } from '../types/types'

const host = vi.hoisted(() => ({
  commands: [] as BCFDInteractionCommand[],
  read: vi.fn(),
  set: vi.fn(),
  save: vi.fn(),
  backend: vi.fn(),
  lock: vi.fn(),
  emit: vi.fn(),
  replace: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  current: vi.fn()
}))
vi.mock('./interactionService', () => ({
  getInteractions: () => {
    host.read()
    return host.commands
  },
  setInteractions: (value: BCFDInteractionCommand[]) => {
    host.set(value)
    host.commands = value
  }
}))
vi.mock('./fileService', () => ({ saveInteractions: host.save }))
vi.mock('./slashCommandRegistry', () => ({ createInteractionPublishBackend: host.backend }))
vi.mock('./resourceChangeService', async (original) => ({
  ...(await original<typeof import('./resourceChangeService')>()),
  withResourceMutationLock: host.lock,
  emitResourceChanged: host.emit
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  host.commands = [
    {
      id: 'fixture-command',
      commandName: 'fixture',
      commandDescription: 'Test',
      options: [],
      rootAction: {} as BCFDInteractionCommand['rootAction'],
      isRegistered: false
    }
  ] as BCFDInteractionCommand[]
  host.lock.mockImplementation(async (_kind, operation) => operation())
  host.save.mockResolvedValue(undefined)
  host.current.mockReturnValue(true)
  host.backend.mockReturnValue({
    managedGuildIds: async () => [],
    replace: host.replace,
    register: host.register,
    unregister: host.unregister,
    isCurrent: host.current
  })
  host.replace.mockResolvedValue(undefined)
})

describe('app-wide publication ownership', () => {
  it('shares one publisher without triggering backend/credential loading when read', async () => {
    const service = await import('./interactionPublicationService')
    const again = await import('./interactionPublicationService')
    expect(service.interactionPublisher).toBe(again.interactionPublisher)
    const first = service.getInteractionPublicationObservation()
    expect(first.observedAt).toBeNull()
    expect(first.state.completed).toBe(false)
    first.state.pendingIds.push('changed-copy')
    expect(service.getInteractionPublicationObservation().state.pendingIds).toEqual([])
    expect(host.read).not.toHaveBeenCalled()
    expect(host.backend).not.toHaveBeenCalled()
    expect(host.save).not.toHaveBeenCalled()
    expect(host.lock).not.toHaveBeenCalled()
  })

  it('preserves event sink, exact revision commit, interaction lock, save then live commit and system notification', async () => {
    const { interactionPublisher, getInteractionPublicationObservation } =
      await import('./interactionPublicationService')
    const sink = vi.fn()
    interactionPublisher.setEventSink(sink)
    const result = await interactionPublisher.publish('sync')
    expect(result.success).toBe(true)
    expect(host.backend).toHaveBeenCalledOnce()
    expect(host.replace).toHaveBeenCalledWith('', [
      expect.objectContaining({ id: 'fixture-command' })
    ])
    expect(host.lock).toHaveBeenCalledWith('interactions', expect.any(Function))
    expect(host.save).toHaveBeenCalledWith([expect.objectContaining({ isRegistered: true })])
    expect(host.set).toHaveBeenCalledAfter(host.save)
    expect(host.emit).toHaveBeenCalledAfter(host.set)
    expect(host.emit).toHaveBeenCalledWith('interactions', 'system', host.commands)
    expect(sink).toHaveBeenCalled()
    expect(sink.mock.calls.at(-1)![0]).toEqual(getInteractionPublicationObservation().state)
    expect(getInteractionPublicationObservation()).toMatchObject({
      observedAt: expect.any(Number),
      state: { completed: true, busy: false }
    })
  })

  it('preserves no-op commits for changed local versions and failure when current connection changes', async () => {
    const { interactionPublisher } = await import('./interactionPublicationService')
    host.replace.mockImplementationOnce(async () => {
      host.commands[0].commandName = 'edited'
    })
    const stale = await interactionPublisher.publish('sync')
    expect(stale.success).toBe(false)
    expect(stale.state!.staleIds).toEqual(['fixture-command'])
    expect(host.save).not.toHaveBeenCalled()
    host.replace.mockImplementationOnce(async () => {
      host.current.mockReturnValue(false)
    })
    const failed = await interactionPublisher.publish('sync')
    expect(failed.state!.error!.code).toBe('connection-changed')
    expect(host.save).not.toHaveBeenCalled()
  })
})
