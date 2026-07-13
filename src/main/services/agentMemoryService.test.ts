import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  writes: [] as string[]
}))

vi.mock('electron', () => ({ app: { getPath: () => '/user-data' } }))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async (path: string) => {
      const value = mocks.files.get(path)
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return value
    }),
    writeFile: vi.fn(async (path: string, value: string) => {
      mocks.files.set(path, value)
      mocks.writes.push(path)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      mocks.files.set(to, mocks.files.get(from) || '')
      mocks.files.delete(from)
    })
  }
}))

describe('agentMemoryService', () => {
  beforeEach(() => {
    mocks.files.clear()
    mocks.writes = []
    vi.resetModules()
  })

  it('creates, persists, edits, and deletes revisioned memories', async () => {
    const service = await import('./agentMemoryService')
    const events: number[] = []
    service.setAgentMemoryEventSink((result) => events.push(result.memories.length))

    const created = await service.commitMemoryMutation(
      await service.prepareCreateMemory('  Prefer TypeScript examples.  ', 'user')
    )
    expect(created.memories[0]).toMatchObject({
      content: 'Prefer TypeScript examples.',
      createdBy: 'user',
      updatedBy: 'user'
    })
    expect(created.memories[0].revision).toHaveLength(16)

    const updated = await service.commitMemoryMutation(
      await service.prepareUpdateMemory(
        created.memories[0].id,
        created.memories[0].revision,
        'Prefer concise TypeScript examples.',
        'agent'
      )
    )
    expect(updated.memories[0]).toMatchObject({
      content: 'Prefer concise TypeScript examples.',
      updatedBy: 'agent'
    })

    const deleted = await service.commitMemoryMutation(
      await service.prepareDeleteMemory(updated.memories[0].id, updated.memories[0].revision)
    )
    expect(deleted.memories).toEqual([])
    expect(events).toEqual([1, 1, 0])
    expect(mocks.writes.every((path) => path.endsWith('.tmp'))).toBe(true)
    expect(JSON.parse(mocks.files.get('/user-data/agent-memories.json')!)).toMatchObject({
      version: 1,
      memories: []
    })
  })

  it('rejects duplicate content, oversized content, and stale edits', async () => {
    const service = await import('./agentMemoryService')
    const first = await service.commitMemoryMutation(
      await service.prepareCreateMemory('Use concise responses.', 'user')
    )

    await expect(service.prepareCreateMemory('use concise responses.', 'agent')).rejects.toThrow(
      'identical memory'
    )
    await expect(
      service.prepareCreateMemory('x'.repeat(service.MAX_AGENT_MEMORY_CHARACTERS + 1), 'user')
    ).rejects.toThrow('cannot exceed')

    const prepared = await service.prepareUpdateMemory(
      first.memories[0].id,
      first.memories[0].revision,
      'Use short responses.',
      'user'
    )
    const intervening = await service.prepareUpdateMemory(
      first.memories[0].id,
      first.memories[0].revision,
      'Use brief responses.',
      'agent'
    )
    await service.commitMemoryMutation(intervening)
    await expect(service.commitMemoryMutation(prepared)).rejects.toThrow('Stale memory revision')
  })

  it('loads valid records and ignores malformed records', async () => {
    mocks.files.set(
      '/user-data/agent-memories.json',
      JSON.stringify({
        version: 1,
        memories: [
          {
            id: 'valid',
            content: 'Prefer examples.',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            createdBy: 'user',
            updatedBy: 'user'
          },
          { id: 'invalid', content: '' }
        ]
      })
    )
    const service = await import('./agentMemoryService')
    const loaded = await service.loadAgentMemories()

    expect(loaded.memories.map((memory) => memory.id)).toEqual(['valid'])
  })
})
