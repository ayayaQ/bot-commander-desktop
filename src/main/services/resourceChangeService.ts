import crypto from 'node:crypto'
import type {
  ResourceChangedEvent,
  ResourceChangeKind,
  ResourceChangeSource
} from '../../shared/mcpTypes'

let eventSink: ((event: ResourceChangedEvent) => void) | null = null
const mutationChains = new Map<ResourceChangeKind, Promise<unknown>>()

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
  const previous = mutationChains.get(kind) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  mutationChains.set(kind, next)
  try {
    return await next
  } finally {
    if (mutationChains.get(kind) === next) mutationChains.delete(kind)
  }
}
