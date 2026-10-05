import { AsyncLocalStorage } from 'node:async_hooks'
import { hasResourceMutationAdmission } from './resourceChangeService'

const admission = new AsyncLocalStorage<boolean>()
const operations = new Set<Promise<unknown>>()
let paused = false

export function pauseAgentPersistence(): void {
  paused = true
}

export function resumeAgentPersistence(): void {
  paused = false
}

export function isAgentPersistencePaused(): boolean {
  return paused
}

/** Admission happens before queuing, so shutdown can drain even jobs not yet writing. */
export function withAgentPersistenceOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (paused && !admission.getStore() && !hasResourceMutationAdmission()) {
    return Promise.reject(new Error('The app is shutting down; agent edits are paused'))
  }
  const pending = Promise.resolve().then(() => admission.run(true, operation))
  operations.add(pending)
  void pending.then(
    () => operations.delete(pending),
    () => operations.delete(pending)
  )
  return pending
}

export async function drainAgentPersistence(): Promise<void> {
  const errors: unknown[] = []
  // Accepted runs/jobs can enqueue their final checkpoints while being stopped.
  while (operations.size) {
    const results = await Promise.allSettled([...operations])
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Pending agent persistence failed')
}
