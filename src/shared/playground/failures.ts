import type { PlaygroundState } from './types'
import { IncompleteSimulationError } from '../runtime/errors'
export { IncompleteSimulationError } from '../runtime/errors'

/** Separate from modeled command errors, even when a keyword catches adapter errors. */
const incomplete = new WeakMap<PlaygroundState, string[]>()
export function incompleteReasons(state: PlaygroundState): string[] {
  return incomplete.get(state) ?? []
}
export function markIncomplete(state: PlaygroundState, reason: string): void {
  const reasons = incomplete.get(state) ?? []
  if (!reasons.includes(reason)) reasons.push(reason)
  incomplete.set(state, reasons)
}

export function recordFailure(state: PlaygroundState, error: unknown): void {
  if (error instanceof IncompleteSimulationError) markIncomplete(state, error.message)
}
