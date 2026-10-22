import { PLAYGROUND_LIMITS } from '../../../shared/playground/types'
import type { PlaygroundRequest, PlaygroundResult } from '../../../shared/playground/types'

export interface DisposableWorker {
  onmessage: ((event: { data: { result?: PlaygroundResult; error?: string } }) => void) | null
  onerror: ((event: unknown) => void) | null
  postMessage(request: PlaygroundRequest): void
  terminate(): void
}

export class PlaygroundSession {
  private generation = 0
  private worker?: DisposableWorker
  private idle?: ReturnType<typeof setTimeout>
  private pending?: {
    worker: DisposableWorker
    timer: ReturnType<typeof setTimeout>
    reject: (error: Error) => void
  }

  constructor(
    private readonly createWorker: () => DisposableWorker,
    private readonly timeoutMs: number = PLAYGROUND_LIMITS.timeoutMs
  ) {}

  get revision(): number {
    return this.generation
  }
  isCurrent(revision: number): boolean {
    return revision === this.generation
  }

  cancel(): void {
    this.generation++
    clearTimeout(this.idle)
    this.worker?.terminate()
    this.worker = undefined
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    this.pending.reject(new Error('Playground execution cancelled'))
    this.pending = undefined
  }

  run(request: PlaygroundRequest): Promise<PlaygroundResult> {
    if (this.pending) this.cancel()
    clearTimeout(this.idle)
    this.generation++
    const generation = this.generation
    if (JSON.stringify(request).length > PLAYGROUND_LIMITS.requestBytes)
      return Promise.reject(new Error('Playground request is too large'))
    return new Promise((resolve, reject) => {
      const worker = (this.worker ??= this.createWorker())
      const finish = (result?: PlaygroundResult, error?: string) => {
        if (generation !== this.generation || this.pending?.worker !== worker) return
        clearTimeout(this.pending.timer)
        this.pending = undefined
        if (error || !result) {
          worker.terminate()
          this.worker = undefined
        } else this.idle = setTimeout(() => this.cancel(), 600_000)
        if (error || !result) reject(new Error(error ?? 'Invalid worker result'))
        else resolve(result)
      }
      const timer = setTimeout(
        () => finish(undefined, 'Playground execution exceeded the time limit'),
        this.timeoutMs
      )
      this.pending = { worker, timer, reject }
      worker.onmessage = (event) => finish(event.data.result, event.data.error)
      worker.onerror = () => finish(undefined, 'Playground worker failed')
      try {
        worker.postMessage(request)
      } catch {
        finish(undefined, 'Unable to start playground execution')
      }
    })
  }
}
