import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlaygroundSession } from './playgroundSession'
import type { DisposableWorker } from './playgroundSession'
import { createPlaygroundState } from '../../../shared/playground/types'

const input = () => ({
  state: createPlaygroundState(),
  commands: [],
  senderId: '100000000000000001',
  content: '!test'
})
const output = () => ({ state: createPlaygroundState(), trace: [], errors: [] })
const worker = (): DisposableWorker => ({
  onmessage: null,
  onerror: null,
  postMessage: vi.fn(),
  terminate: vi.fn()
})
afterEach(() => vi.useRealTimers())

describe('disposable playground lifecycle (headless unit tests)', () => {
  it('terminates after successful result', async () => {
    const stub = worker(),
      session = new PlaygroundSession(() => stub)
    const promise = session.run(input())
    stub.onmessage!({ data: { result: output() } })
    await expect(promise).resolves.toEqual(output())
    expect(stub.terminate).toHaveBeenCalledTimes(1)
  })

  it('cancels on reset/navigation and ignores stale worker completion', async () => {
    const stub = worker(),
      session = new PlaygroundSession(() => stub)
    const promise = session.run(input())
    const revision = session.revision
    const assertion = expect(promise).rejects.toThrow('cancelled')
    session.cancel()
    stub.onmessage!({ data: { result: output() } })
    await assertion
    expect(session.isCurrent(revision)).toBe(false)
    expect(stub.terminate).toHaveBeenCalledTimes(1)
  })

  it('new execution cannot be settled by the prior worker', async () => {
    const first = worker(),
      second = worker()
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second)
    const session = new PlaygroundSession(create)
    const old = session.run(input())
    const assertion = expect(old).rejects.toThrow('cancelled')
    const current = session.run(input())
    first.onmessage!({ data: { error: 'stale' } })
    second.onmessage!({ data: { result: output() } })
    await assertion
    await expect(current).resolves.toEqual(output())
  })

  it('enforces deadline by terminating the worker', async () => {
    vi.useFakeTimers()
    const stub = worker(),
      session = new PlaygroundSession(() => stub, 10)
    const promise = session.run(input())
    const assertion = expect(promise).rejects.toThrow('time limit')
    vi.advanceTimersByTime(11)
    await assertion
    expect(stub.terminate).toHaveBeenCalledTimes(1)
  })

  it('terminates failed workers and handles serialization limits before launch', async () => {
    const stub = worker(),
      create = vi.fn(() => stub),
      session = new PlaygroundSession(create)
    const promise = session.run(input())
    stub.onerror!({})
    await expect(promise).rejects.toThrow('worker failed')
    expect(stub.terminate).toHaveBeenCalledTimes(1)
    await expect(session.run({ ...input(), content: 'x'.repeat(2_000_001) })).rejects.toThrow(
      'too large'
    )
    expect(create).toHaveBeenCalledTimes(1)
  })
})
