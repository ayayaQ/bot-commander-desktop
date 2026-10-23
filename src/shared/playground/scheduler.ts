import { IncompleteSimulationError } from './failures'

export const SCHEDULER_LIMITS = {
  maxPending: 1000,
  maxSteps: 5000,
  maxWork: 5000,
  maxTimeMs: 86_400_000
} as const

export type SchedulerLimits = { [K in keyof typeof SCHEDULER_LIMITS]: number }
type Task = {
  id: number
  due: number
  run: () => void
  reject: (error: Error) => void
}

/** Only trusted host callbacks enter this queue. Guest scripts never receive it. */
export class VirtualScheduler {
  private queue: Task[] = []
  private sequence = 0
  private steps = 0
  private disposed = false
  private readonly origin: number
  readonly limits: SchedulerLimits

  constructor(
    private readonly clock: { now: () => number; set: (value: number) => void },
    limits: Partial<SchedulerLimits> = {}
  ) {
    this.origin = clock.now()
    this.limits = { ...SCHEDULER_LIMITS, ...limits }
    for (const key of Object.keys(SCHEDULER_LIMITS) as (keyof SchedulerLimits)[])
      if (
        !Number.isSafeInteger(this.limits[key]) ||
        this.limits[key] < 1 ||
        this.limits[key] > SCHEDULER_LIMITS[key]
      )
        throw new Error(`Invalid scheduler ${key}`)
  }

  get pending(): number {
    return this.queue.length
  }

  schedule<T>(delayMs: number, run: () => T) {
    if (this.disposed) throw new IncompleteSimulationError('Virtual scheduler is disposed')
    if (this.queue.length >= this.limits.maxPending)
      throw new IncompleteSimulationError('Virtual scheduler pending task budget exhausted')
    if (this.sequence >= this.limits.maxWork)
      throw new IncompleteSimulationError('Virtual scheduler total work budget exhausted')
    const due = this.clock.now() + delayMs
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || !Number.isSafeInteger(due))
      throw new IncompleteSimulationError('Invalid virtual task time')
    const id = this.sequence++
    let rejectTask!: (error: Error) => void
    const promise = new Promise<T>((resolve, reject) => {
      rejectTask = reject
      this.queue.push({
        id,
        due,
        reject,
        run: () => {
          try {
            resolve(run())
          } catch (error) {
            reject(error)
          }
        }
      })
    })
    // Cancellation can happen before the owner attaches its await handler.
    void promise.catch(() => {})
    return {
      promise,
      cancel: () => {
        const index = this.queue.findIndex((task) => task.id === id)
        if (index < 0) return
        this.queue.splice(index, 1)
        rejectTask(new IncompleteSimulationError('Virtual task cancelled'))
      }
    }
  }

  private next(): Task | undefined {
    this.queue.sort((a, b) => a.due - b.due || a.id - b.id)
    return this.queue[0]
  }

  private checkTime(target: number): void {
    if (
      !Number.isSafeInteger(target) ||
      target < this.clock.now() ||
      target - this.origin > this.limits.maxTimeMs
    )
      throw new IncompleteSimulationError('Virtual scheduler time budget exhausted')
  }

  /** Advance explicitly, running every due callback in (time, insertion) order. */
  advanceTo(target: number): void {
    if (this.disposed) throw new IncompleteSimulationError('Virtual scheduler is disposed')
    this.checkTime(target)
    while (this.next() && this.next()!.due <= target) this.runNext()
    this.clock.set(target)
  }

  private runNext(): void {
    const task = this.next()
    if (!task) return
    this.checkTime(task.due)
    if (++this.steps > this.limits.maxSteps)
      throw new IncompleteSimulationError('Virtual scheduler step budget exhausted')
    this.queue.shift()
    this.clock.set(task.due)
    task.run()
  }

  /** Flush native promise continuations before choosing the next virtual timestamp.
   * MessageChannel yields an event-loop turn; it never sleeps or measures elapsed time.
   */
  async run<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted || this.disposed) {
      this.dispose()
      throw new IncompleteSimulationError('Virtual scheduler cancelled')
    }
    if (typeof MessageChannel !== 'function') {
      this.dispose()
      throw new IncompleteSimulationError('Virtual scheduler MessageChannel is unavailable')
    }
    const channel = new MessageChannel()
    const turn = () =>
      new Promise<void>((resolve) => {
        channel.port1.onmessage = () => resolve()
        channel.port2.postMessage(null)
      })
    let settled = false
    const result = Promise.resolve().then(execute)
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      while (true) {
        await turn()
        if (signal?.aborted || this.disposed)
          throw new IncompleteSimulationError('Virtual scheduler cancelled')
        if (this.pending) this.runNext()
        else if (settled) return await result
        else
          throw new IncompleteSimulationError('Unprocessed required work outside virtual scheduler')
      }
    } finally {
      this.dispose()
      // Allow rejection/finally handlers to unwind before releasing the execution scope.
      await turn()
      channel.port1.close()
      channel.port2.close()
    }
  }

  dispose(): void {
    this.disposed = true
    const tasks = this.queue.splice(0)
    for (const task of tasks)
      task.reject(new IncompleteSimulationError('Virtual scheduler discarded pending work'))
  }
}
