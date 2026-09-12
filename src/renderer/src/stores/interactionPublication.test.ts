import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { emptyPublicationState } from '../../../shared/interactionPublication'
import {
  initializeInteractionPublication,
  interactionPublication,
  publicationRequestPending,
  publicationTransportError,
  publishInteractions
} from './interactionPublication'

const ipc = { on: vi.fn(), removeListener: vi.fn(), invoke: vi.fn() }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { electron: { ipcRenderer: ipc } })
  interactionPublication.set(emptyPublicationState())
  publicationRequestPending.set(false)
  publicationTransportError.set('')
})
afterEach(() => vi.unstubAllGlobals())

describe('publication feedback store', () => {
  it('does not replace a new event with a delayed initial status response', async () => {
    let resolve!: (state: ReturnType<typeof emptyPublicationState>) => void
    ipc.invoke.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const destroy = initializeInteractionPublication()
    const receive = ipc.on.mock.calls[0][1]
    receive({ ...emptyPublicationState(), revision: 2, busy: true, pendingIds: ['hello'] })
    resolve(emptyPublicationState())
    await Promise.resolve()
    expect(get(interactionPublication).busy).toBe(true)
    destroy()
    expect(ipc.removeListener).toHaveBeenCalledWith('interactions:publication', receive)
  })

  it('keeps completed feedback for later subscribers and prevents duplicate requests', async () => {
    let resolve!: (result: unknown) => void
    ipc.invoke.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    const run = publishInteractions('sync')
    await publishInteractions('register', 'hello')
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    const state = { ...emptyPublicationState(), revision: 3, completed: true }
    resolve({ success: true, state })
    await run
    const subscriber = vi.fn()
    const unsubscribe = interactionPublication.subscribe(subscriber)
    expect(subscriber).toHaveBeenLastCalledWith(state)
    expect(get(publicationRequestPending)).toBe(false)
    unsubscribe()
  })

  it('surfaces IPC errors and allows the user to try again', async () => {
    ipc.invoke.mockRejectedValueOnce(new Error('Bridge unavailable'))
    await publishInteractions('sync')
    expect(get(publicationTransportError)).toContain('Bridge unavailable')
    expect(get(publicationRequestPending)).toBe(false)
    ipc.invoke.mockResolvedValue({
      success: true,
      state: { ...emptyPublicationState(), revision: 1, completed: true }
    })
    await publishInteractions('register', 'hello')
    expect(ipc.invoke).toHaveBeenLastCalledWith('register-slash-command', 'hello')
    expect(get(publicationTransportError)).toBe('')
  })
})
