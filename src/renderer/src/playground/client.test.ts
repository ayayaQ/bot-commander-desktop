import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPlayground } from './client'
import { createPlaygroundFixture } from '../../../shared/playground'

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: (event: { data: unknown }) => void
  onerror: () => void
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() {
    FakeWorker.instances.push(this)
  }
}
const request = () => ({
  commands: [],
  fixture: createPlaygroundFixture(),
  message: 'hello',
  senderId: 'test'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  FakeWorker.instances = []
})

describe('playground worker boundary', () => {
  it('uses a fresh worker per run and terminates it on completion', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const first = runPlayground(request())
    const worker = FakeWorker.instances[0]
    const result = { outputs: [], traces: [] }
    worker.onmessage({ data: { result } })
    expect(await first).toEqual(result)
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(worker.postMessage).toHaveBeenCalledOnce()
    const next = runPlayground(request())
    expect(FakeWorker.instances).toHaveLength(2)
    FakeWorker.instances[1].onmessage({ data: { result } })
    await next
  })
  it('terminates stalled parsers after the bounded timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', FakeWorker)
    const promise = runPlayground(request())
    const assertion = expect(promise).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(2000)
    await assertion
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce()
  })
  it.each(['reported', 'crash', 'malformed'])('cleans up after %s errors', async (kind) => {
    vi.stubGlobal('Worker', FakeWorker)
    const promise = runPlayground(request())
    const assertion = expect(promise).rejects.toThrow()
    const worker = FakeWorker.instances[0]
    if (kind === 'crash') worker.onerror()
    else worker.onmessage({ data: kind === 'reported' ? { error: 'Unsupported' } : {} })
    await assertion
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
