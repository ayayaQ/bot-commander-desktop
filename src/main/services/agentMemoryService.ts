import { app } from 'electron'
import crypto from 'node:crypto'
import { join } from 'node:path'
import { createAgentPersistence, reportAgentPersistenceNotice } from './agentPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import type {
  AgentMemoriesData,
  AgentMemory,
  AgentMemoryActor,
  AgentMemoryListResult
} from '../../shared/agentTypes'

const AGENT_MEMORIES_FILENAME = 'agent-memories.json'
export const MAX_AGENT_MEMORIES = 100
export const MAX_AGENT_MEMORY_CHARACTERS = 1_000
export const MAX_AGENT_MEMORY_TOTAL_CHARACTERS = 20_000

export interface AgentMemoryMutation {
  kind: 'create' | 'update' | 'delete'
  before: AgentMemory | null
  after: AgentMemory | null
  expectedRevision?: string
}

let data: AgentMemoriesData = { version: 1, memories: [] }
let loaded = false
let loading: Promise<AgentMemoryListResult> | undefined
let mutationChain: Promise<unknown> = Promise.resolve()
let eventSink: ((memories: AgentMemoryListResult) => void) | null = null

function memoryPath(): string {
  return join(app.getPath('userData'), AGENT_MEMORIES_FILENAME)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function isActor(value: unknown): value is AgentMemoryActor {
  return value === 'agent' || value === 'user'
}

function normalizeContent(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Memory content must be text')
  const content = value.trim()
  if (!content) throw new Error('Memory content cannot be empty')
  if (content.length > MAX_AGENT_MEMORY_CHARACTERS) {
    throw new Error(`Memory content cannot exceed ${MAX_AGENT_MEMORY_CHARACTERS} characters`)
  }
  return content
}

function validMemory(value: unknown): value is AgentMemory {
  if (!value || typeof value !== 'object') return false
  const memory = value as AgentMemory
  return (
    typeof memory.id === 'string' &&
    memory.id.trim().length > 0 &&
    typeof memory.content === 'string' &&
    memory.content.trim().length > 0 &&
    memory.content.length <= MAX_AGENT_MEMORY_CHARACTERS &&
    typeof memory.createdAt === 'string' &&
    typeof memory.updatedAt === 'string' &&
    isActor(memory.createdBy) &&
    isActor(memory.updatedBy)
  )
}

function validateCollection(memories: AgentMemory[]): void {
  if (memories.length > MAX_AGENT_MEMORIES) {
    throw new Error(`A maximum of ${MAX_AGENT_MEMORIES} memories can be stored`)
  }
  const totalCharacters = memories.reduce((total, memory) => total + memory.content.length, 0)
  if (totalCharacters > MAX_AGENT_MEMORY_TOTAL_CHARACTERS) {
    throw new Error(`Memories cannot exceed ${MAX_AGENT_MEMORY_TOTAL_CHARACTERS} total characters`)
  }
  const seen = new Map<string, string>()
  const ids = new Set<string>()
  for (const memory of memories) {
    if (!validMemory(memory) || ids.has(memory.id))
      throw new Error('Invalid memory record or duplicate ID')
    ids.add(memory.id)
    const key = memory.content.trim().toLocaleLowerCase()
    const duplicateId = seen.get(key)
    if (duplicateId) {
      throw new Error('An identical memory already exists')
    }
    seen.set(key, memory.id)
  }
}

export function agentMemoryRevision(memory: AgentMemory): string {
  return crypto.createHash('sha256').update(JSON.stringify(memory)).digest('hex').slice(0, 16)
}

function listResult(): AgentMemoryListResult {
  return {
    memories: data.memories.map((memory) => ({
      ...clone(memory),
      revision: agentMemoryRevision(memory)
    })),
    limits: {
      maximumMemories: MAX_AGENT_MEMORIES,
      maximumMemoryCharacters: MAX_AGENT_MEMORY_CHARACTERS,
      maximumTotalCharacters: MAX_AGENT_MEMORY_TOTAL_CHARACTERS
    }
  }
}

function decodeMemories(raw: string): AgentMemoriesData {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Agent memory store must be an object')
  const collection = parsed as Partial<AgentMemoriesData>
  if (
    (collection.version !== undefined && collection.version !== 1) ||
    !Array.isArray(collection.memories)
  )
    throw new Error('Invalid or unsupported agent memory store')
  validateCollection(collection.memories)
  return { ...collection, version: 1, memories: collection.memories }
}

const persistence = createAgentPersistence<AgentMemoriesData>({
  path: memoryPath,
  label: 'Agent memories',
  decode: decodeMemories,
  empty: () => ({ version: 1, memories: [] })
})

export async function loadAgentMemories(): Promise<AgentMemoryListResult> {
  if (loaded) return clone(listResult())
  if (!loading) loading = initializeMemories()
  return clone(await loading)
}

async function initializeMemories(): Promise<AgentMemoryListResult> {
  const stored = await persistence.load()
  data = stored.data
  if (stored.writable) {
    try {
      await withAgentPersistenceOperation(() => persistence.save(data))
    } catch (error) {
      reportAgentPersistenceNotice({
        level: 'error',
        message: `Could not checkpoint agent memory recovery: ${String(error)}. Existing saved data has been kept; retry saving or restart after resolving the file problem.`
      })
    }
  }
  loaded = true
  return listResult()
}

export function setAgentMemoryEventSink(
  sink: ((memories: AgentMemoryListResult) => void) | null
): void {
  eventSink = sink
}

export async function prepareCreateMemory(
  content: string,
  actor: AgentMemoryActor
): Promise<AgentMemoryMutation> {
  await loadAgentMemories()
  persistence.assertWritable()
  const timestamp = new Date().toISOString()
  const memory: AgentMemory = {
    id: crypto.randomUUID(),
    content: normalizeContent(content),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: actor,
    updatedBy: actor
  }
  validateCollection([...data.memories, memory])
  return { kind: 'create', before: null, after: memory }
}

export async function prepareUpdateMemory(
  id: string,
  expectedRevision: string,
  content: string,
  actor: AgentMemoryActor
): Promise<AgentMemoryMutation> {
  await loadAgentMemories()
  persistence.assertWritable()
  const before = data.memories.find((memory) => memory.id === id)
  if (!before) throw new Error('Memory not found')
  if (agentMemoryRevision(before) !== expectedRevision) {
    throw new Error('Stale memory revision; refresh memories before editing')
  }
  const after: AgentMemory = {
    ...before,
    content: normalizeContent(content),
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  }
  validateCollection(data.memories.map((memory) => (memory.id === id ? after : memory)))
  return { kind: 'update', before: clone(before), after, expectedRevision }
}

export async function prepareDeleteMemory(
  id: string,
  expectedRevision: string
): Promise<AgentMemoryMutation> {
  await loadAgentMemories()
  persistence.assertWritable()
  const before = data.memories.find((memory) => memory.id === id)
  if (!before) throw new Error('Memory not found')
  if (agentMemoryRevision(before) !== expectedRevision) {
    throw new Error('Stale memory revision; refresh memories before deleting')
  }
  return { kind: 'delete', before: clone(before), after: null, expectedRevision }
}

export function commitMemoryMutation(
  mutation: AgentMemoryMutation
): Promise<AgentMemoryListResult> {
  return withAgentPersistenceOperation(() => commitAcceptedMemoryMutation(mutation))
}

async function commitAcceptedMemoryMutation(
  mutation: AgentMemoryMutation
): Promise<AgentMemoryListResult> {
  const operation = mutationChain.then(async () => {
    await loadAgentMemories()
    persistence.assertWritable()
    let nextData: AgentMemoriesData
    if (mutation.kind === 'create') {
      if (!mutation.after) throw new Error('Invalid memory creation')
      if (data.memories.some((memory) => memory.id === mutation.after!.id)) {
        throw new Error('Memory already exists')
      }
      const next = [...data.memories, clone(mutation.after)]
      validateCollection(next)
      nextData = { version: 1, memories: next }
    } else {
      if (!mutation.before || !mutation.expectedRevision) throw new Error('Invalid memory mutation')
      const current = data.memories.find((memory) => memory.id === mutation.before!.id)
      if (!current) throw new Error('Memory not found')
      if (agentMemoryRevision(current) !== mutation.expectedRevision) {
        throw new Error(
          `Stale memory revision; refresh memories before ${mutation.kind === 'update' ? 'editing' : 'deleting'}`
        )
      }
      const next =
        mutation.kind === 'update'
          ? data.memories.map((memory) =>
              memory.id === current.id ? clone(mutation.after as AgentMemory) : memory
            )
          : data.memories.filter((memory) => memory.id !== current.id)
      validateCollection(next)
      nextData = { version: 1, memories: next }
    }
    await persistence.save(nextData)
    data = nextData
    const result = listResult()
    try {
      eventSink?.(clone(result))
    } catch (error) {
      console.error('Could not report committed memory mutation:', error)
    }
    return result
  })
  mutationChain = operation.catch(() => undefined)
  return clone((await operation) as AgentMemoryListResult)
}
