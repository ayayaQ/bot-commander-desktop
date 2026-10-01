import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  ResourceChangedEvent,
  ResourceChangeKind,
  ResourceChangeSource
} from '../../shared/mcpTypes'

let eventSink: ((event: ResourceChangedEvent) => void) | null = null
const mutationChains = new Map<ResourceChangeKind, Promise<unknown>>()
let mutationsStopped = false
const resourceAdmission = new AsyncLocalStorage<boolean>()

export function hasResourceMutationAdmission(): boolean {
  return resourceAdmission.getStore() === true
}

export function stopResourceMutations(): void {
  mutationsStopped = true
}

export function resumeResourceMutations(): void {
  mutationsStopped = false
}

export async function drainResourceMutations(): Promise<void> {
  const results = await Promise.allSettled([...mutationChains.values()])
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Pending resource mutation failed')
}

export function resourceRevision(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')
    .slice(0, 16)
}

export function setResourceChangeEventSink(
  sink: ((event: ResourceChangedEvent) => void) | null
): void {
  eventSink = sink
}

export function emitResourceChanged(
  kind: ResourceChangeKind,
  source: ResourceChangeSource,
  value: unknown,
  targetId?: string
): ResourceChangedEvent {
  const event: ResourceChangedEvent = {
    kind,
    source,
    revision: resourceRevision(value),
    ...(targetId ? { targetId } : {})
  }
  eventSink?.(structuredClone(event))
  return event
}

export async function withResourceMutationLock<T>(
  kind: ResourceChangeKind,
  operation: () => Promise<T>
): Promise<T> {
  if (mutationsStopped) throw new Error('The app is shutting down; resource edits are paused')
  const previous = mutationChains.get(kind) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(() => resourceAdmission.run(true, operation))
  mutationChains.set(kind, next)
  try {
    return await next
  } finally {
    if (mutationChains.get(kind) === next) mutationChains.delete(kind)
  }
}
