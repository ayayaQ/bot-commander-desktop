import { app } from 'electron'
import { join } from 'node:path'
import {
  createMemoryService,
  decodeMemories,
  memoryRevision,
  MAX_MEMORIES,
  MAX_MEMORY_CHARACTERS,
  MAX_MEMORY_TOTAL_CHARACTERS,
  type MemoryMutation
} from '@ayayaq/vivi/extensions/memory'
import { createAgentPersistence, reportAgentPersistenceNotice } from './agentPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import {
  resourceRevision,
  hasResourceMutationLock,
  withResourceMutationLock
} from './resourceChangeService'
import type {
  AgentMemoriesData,
  AgentMemoryActor,
  AgentMemoryListResult
} from '../../shared/agentTypes'

const AGENT_MEMORIES_FILENAME = 'agent-memories.json'
export const MAX_AGENT_MEMORIES = MAX_MEMORIES
export const MAX_AGENT_MEMORY_CHARACTERS = MAX_MEMORY_CHARACTERS
export const MAX_AGENT_MEMORY_TOTAL_CHARACTERS = MAX_MEMORY_TOTAL_CHARACTERS
export type AgentMemoryMutation = MemoryMutation
export const agentMemoryRevision = memoryRevision

let eventSink: ((memories: AgentMemoryListResult) => void) | null = null
let reviewRevision: string | undefined
let commitChain: Promise<unknown> = Promise.resolve()
let beforeSave: (() => void) | undefined

const persistence = createAgentPersistence<AgentMemoriesData>({
  path: () => join(app.getPath('userData'), AGENT_MEMORIES_FILENAME),
  label: 'Agent memories',
  decode: decodeMemories,
  empty: () => ({ version: 1, memories: [] })
})

// Files, recovery, durability notices and shutdown admission remain host-owned.
const memories = createMemoryService({
  async load() {
    const stored = await persistence.load()
    if (stored.writable) {
      try {
        await withAgentPersistenceOperation(() => persistence.save(stored.data))
      } catch (error) {
        reportAgentPersistenceNotice({
          level: 'error',
          message: `Could not checkpoint agent memory recovery: ${String(error)}. Existing saved data has been kept; retry saving or restart after resolving the file problem.`
        })
      }
    }
    return stored.data
  },
  assertWritable: persistence.assertWritable,
  // A resolved host save is committed, including reported post-rename sync uncertainty.
  save: (value) => {
    beforeSave?.()
    return persistence.save(value)
  }
})

export async function loadAgentMemories(): Promise<AgentMemoryListResult> {
  const result = await memories.list()
  reviewRevision = resourceRevision(result.memories)
  return result
}

export function getAgentMemoryReviewRevision(): string | undefined {
  return reviewRevision
}

export function setAgentMemoryEventSink(
  sink: ((memories: AgentMemoryListResult) => void) | null
): void {
  eventSink = sink
}

export function prepareCreateMemory(
  content: string,
  actor: AgentMemoryActor
): Promise<AgentMemoryMutation> {
  return memories.prepareCreate(content, actor)
}

export function prepareUpdateMemory(
  id: string,
  expectedRevision: string,
  content: string,
  actor: AgentMemoryActor
): Promise<AgentMemoryMutation> {
  return memories.prepareUpdate(id, expectedRevision, content, actor)
}

export function prepareDeleteMemory(
  id: string,
  expectedRevision: string
): Promise<AgentMemoryMutation> {
  return memories.prepareDelete(id, expectedRevision)
}

export function commitMemoryMutation(
  mutation: AgentMemoryMutation,
  options: { readonly signal?: AbortSignal; readonly beforeCommit?: () => void } = {}
): Promise<AgentMemoryListResult> {
  // Capture approved work before the asynchronous host admission callback can run.
  const captured = structuredClone(mutation)
  const signal = options.signal
  // Admit BEFORE the shared instance's queue so shutdown drains every accepted job.
  return withAgentPersistenceOperation(() => {
    const execute = () => {
      const pending = commitChain.then(async () => {
        await loadAgentMemories()
        if (signal?.aborted) throw new Error('Memory mutation aborted before save')
        beforeSave = options.beforeCommit
        let result: AgentMemoryListResult
        try {
          options.beforeCommit?.()
          result = await memories.commit(captured, { signal })
          reviewRevision = resourceRevision(result.memories)
        } finally {
          beforeSave = undefined
        }
        try {
          eventSink?.(structuredClone(result))
        } catch (error) {
          try {
            console.error('Could not report committed memory mutation:', error)
          } catch {
            // A failed listener or log destination cannot undo a committed save.
          }
        }
        return result
      })
      commitChain = pending.catch(() => {})
      return pending
    }
    return hasResourceMutationLock('memories')
      ? execute()
      : withResourceMutationLock('memories', execute)
  })
}
