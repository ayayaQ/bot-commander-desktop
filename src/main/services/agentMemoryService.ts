import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
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
    throw new Error(
      `Memories cannot exceed ${MAX_AGENT_MEMORY_TOTAL_CHARACTERS} total characters`
    )
  }
  const seen = new Map<string, string>()
  for (const memory of memories) {
    const key = memory.content.trim().toLocaleLowerCase()
    const duplicateId = seen.get(key)
    if (duplicateId) {
      throw new Error('An identical memory already exists')
    }
    seen.set(key, memory.id)
  }
}

export function agentMemoryRevision(memory: AgentMemory): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(memory))
    .digest('hex')
    .slice(0, 16)
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

async function persist(next: AgentMemoriesData): Promise<void> {
  const output = memoryPath()
  const temporary = `${output}.tmp`
  await fs.writeFile(temporary, JSON.stringify(next, null, 2))
  await fs.rename(temporary, output)
}

export async function loadAgentMemories(): Promise<AgentMemoryListResult> {
  if (loaded) return clone(listResult())
  try {
    const parsed = JSON.parse(await fs.readFile(memoryPath(), 'utf-8')) as Partial<AgentMemoriesData>
    data = {
      version: 1,
      memories: Array.isArray(parsed.memories) ? parsed.memories.filter(validMemory) : []
    }
    validateCollection(data.memories)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to load agent memories:', error)
    }
    data = { version: 1, memories: [] }
  }
  loaded = true
  return clone(listResult())
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
  const before = data.memories.find((memory) => memory.id === id)
  if (!before) throw new Error('Memory not found')
  if (agentMemoryRevision(before) !== expectedRevision) {
    throw new Error('Stale memory revision; refresh memories before deleting')
  }
  return { kind: 'delete', before: clone(before), after: null, expectedRevision }
}

export async function commitMemoryMutation(
  mutation: AgentMemoryMutation
): Promise<AgentMemoryListResult> {
  const operation = mutationChain.then(async () => {
    await loadAgentMemories()
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
        throw new Error(`Stale memory revision; refresh memories before ${mutation.kind === 'update' ? 'editing' : 'deleting'}`)
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
    await persist(nextData)
    data = nextData
    const result = listResult()
    eventSink?.(clone(result))
    return result
  })
  mutationChain = operation.catch(() => undefined)
  return clone((await operation) as AgentMemoryListResult)
}
