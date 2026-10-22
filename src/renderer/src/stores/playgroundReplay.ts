import { writable } from 'svelte/store'
import type { AgentValidationRequest } from '../../../shared/agentValidationTypes'

/** A one-use handoff, never persisted and never a save authorization. */
export const playgroundReplay = writable<AgentValidationRequest | null>(null)
