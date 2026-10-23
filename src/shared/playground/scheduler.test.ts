import { describe, expect, it, vi } from 'vitest'
import { VirtualScheduler } from './scheduler'
import { IncompleteSimulationError } from './failures'

function setup(limits = {}) {
  let now = 0
  const scheduler = new VirtualScheduler(
    {
      now: () => now,
      set: (value) => {
        now = value
      }
    },
    limits
  )
  return { scheduler, now: () => now }
}

describe('bounded virtual task queue', () => {
  it('advances only due work and orders equal timestamps by insertion, including new tasks', () => {
    const { scheduler, now } = setup()
    const effects: string[] = []
    scheduler.schedule(20, () => effects.push('later'))
    scheduler.schedule(10, () => {
      effects.push('first')
      scheduler.schedule(0, () => effects.push('nested'))
    })
    scheduler.schedule(10, () => effects.push('second'))
    scheduler.advanceTo(9)
    expect(effects).toEqual([])
    scheduler.advanceTo(10)
    expect(effects).toEqual(['first', 'second', 'nested'])
    expect(scheduler.pending).toBe(1)
    expect(now()).toBe(10)
    scheduler.advanceTo(20)
    expect(effects.at(-1)).toBe('later')
  })

  it('flushes arbitrary promise chains before advancing virtual time', async () => {
    const { scheduler, now } = setup()
    const effects: number[] = []
    await scheduler.run(async () => {
      const late = scheduler.schedule(100, () => effects.push(now())).promise
      // More microtasks than a fixed guessed flush count can reliably handle.
      for (let i = 0; i < 200; i++) await Promise.resolve()
      await scheduler.schedule(10, () => effects.push(now())).promise
      await late
    })
    expect(effects).toEqual([10, 100])
  })

  it.each([
    [{ maxPending: 1 }, 'pending task'],
    [{ maxWork: 1 }, 'total work']
  ])('bounds admission using %j', (limits, reason) => {
    const { scheduler } = setup(limits)
    scheduler.schedule(1, () => {})
    expect(() => scheduler.schedule(1, () => {})).toThrow(reason)
    scheduler.dispose()
  })

  it.each([
    [{ maxSteps: 1 }, 'step budget'],
    [{ maxTimeMs: 1 }, 'time budget']
  ])('discards all remaining work when %j is exhausted', async (limits, reason) => {
    const { scheduler } = setup(limits)
    const effects: number[] = []
    await expect(
      scheduler.run(async () => {
        await scheduler.schedule(1, () => effects.push(1)).promise
        await scheduler.schedule(1, () => effects.push(2)).promise
      })
    ).rejects.toThrow(reason)
    expect(effects).toEqual([1])
    expect(scheduler.pending).toBe(0)
  })

  it('cancellation and disposal prevent pending effects and a fresh queue starts empty', async () => {
    const { scheduler } = setup()
    const effects: number[] = []
    const task = scheduler.schedule(100, () => effects.push(1))
    task.cancel()
    await expect(task.promise).rejects.toThrow('cancelled')
    const controller = new AbortController()
    await expect(
      scheduler.run(async () => {
        controller.abort()
        await scheduler.schedule(1, () => effects.push(2)).promise
      }, controller.signal)
    ).rejects.toThrow('cancelled')
    expect(scheduler.pending).toBe(0)
    expect(effects).toEqual([])
    expect(() => scheduler.schedule(0, () => {})).toThrow('disposed')
    expect(setup().scheduler.pending).toBe(0)
  })

  it('reports untracked required work rather than authorizing a partial result', async () => {
    const { scheduler } = setup()
    await expect(scheduler.run(() => new Promise(() => {}))).rejects.toThrow(
      'Unprocessed required work'
    )
  })

  it('does not start an event whose signal was already cancelled', async () => {
    const { scheduler } = setup()
    const controller = new AbortController()
    controller.abort()
    let ran = false
    await expect(
      scheduler.run(async () => {
        ran = true
      }, controller.signal)
    ).rejects.toThrow('cancelled')
    expect(ran).toBe(false)
  })

  it('classifies missing scheduling infrastructure as incomplete', async () => {
    const { scheduler } = setup()
    vi.stubGlobal('MessageChannel', undefined)
    try {
      await expect(scheduler.run(async () => {})).rejects.toBeInstanceOf(IncompleteSimulationError)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
