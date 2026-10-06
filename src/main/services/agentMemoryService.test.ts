import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const memoryPath = join('/user-data', 'agent-memories.json')

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
    }),
    copyFile: vi.fn(async (from: string, to: string) => {
      mocks.files.set(to, mocks.files.get(from)!)
    }),
    open: vi.fn(async () => ({ sync: async () => {}, close: async () => {} }))
  }
}))

// Collection/revision tests observe checkpoints. The adapter and service integration suites
// exercise the real atomic writer and filesystem commit faults.
vi.mock('./atomicPersistence', () => ({
  atomicWrite: vi.fn(async (path: string, raw: string, options) => {
    options?.validate?.(raw)
    const fs = (await import('node:fs/promises')).default
    await fs.writeFile(`${path}.tmp`, raw)
    await fs.rename(`${path}.tmp`, path)
    return { durability: 'confirmed' }
  })
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
    expect(JSON.parse(mocks.files.get(memoryPath)!)).toMatchObject({
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

  it('preserves malformed collections and blocks saves instead of dropping records', async () => {
    mocks.files.set(
      memoryPath,
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

    expect(loaded.memories).toEqual([])
    await expect(
      service.prepareCreateMemory('Do not erase malformed records', 'user')
    ).rejects.toThrow('read-only')
    expect(JSON.parse(mocks.files.get(memoryPath)!).memories).toHaveLength(2)
    expect(mocks.writes).toEqual([])
  })

  it.each([1, undefined])(
    'keeps legacy records, extras and exact revision bytes with version %s',
    async (version) => {
      const record = {
        content: '  Prefer examples.\n  ',
        extra: { retained: [true, 42] },
        updatedBy: 'agent' as const,
        id: 'legacy-memory-id',
        createdAt: 'legacy timestamp',
        revision: 'retained extra field',
        createdBy: 'user' as const,
        updatedAt: ''
      }
      const original = { rootExtra: ['retained'], version, memories: [record] }
      mocks.files.set(memoryPath, JSON.stringify(original))
      const service = await import('./agentMemoryService')
      const listed = await service.loadAgentMemories()
      const revision = createHash('sha256')
        .update(JSON.stringify(record))
        .digest('hex')
        .slice(0, 16)
      expect(listed.memories).toEqual([{ ...record, revision }])
      const checkpoint = JSON.parse(mocks.files.get(memoryPath)!)
      expect(checkpoint).toEqual({ ...original, version: 1 })
      expect(JSON.stringify(checkpoint.memories[0])).toBe(JSON.stringify(record))
      listed.memories[0].content = 'A caller must not change the store'
      expect((await service.loadAgentMemories()).memories[0].content).toBe(record.content)
    }
  )

  it.each(['duplicate IDs', 'duplicate content', 'record count', 'record size', 'total size'])(
    'keeps invalid legacy %s read-only without discarding evidence',
    async (reason) => {
      const record = (id: string, content = `Preference ${id}`) => ({
        id,
        content,
        createdAt: '',
        updatedAt: '',
        createdBy: 'user',
        updatedBy: 'agent'
      })
      const records =
        reason === 'duplicate IDs'
          ? [record('same', 'First preference'), record('same', 'Second preference')]
          : reason === 'duplicate content'
            ? [record('one', 'Preference'), record('two', '  PREFERENCE  ')]
            : reason === 'record count'
              ? Array.from({ length: 101 }, (_, index) => record(String(index)))
              : reason === 'record size'
                ? [record('oversized', 'x'.repeat(1001))]
                : Array.from({ length: 21 }, (_, index) =>
                    record(String(index), String(index).padEnd(1000, 'x'))
                  )
      const raw = JSON.stringify({ version: 1, memories: records })
      mocks.files.set(memoryPath, raw)
      const service = await import('./agentMemoryService')
      expect((await service.loadAgentMemories()).memories).toEqual([])
      await expect(service.prepareCreateMemory('Keep the original', 'user')).rejects.toThrow(
        'read-only'
      )
      expect(mocks.files.get(memoryPath)).toBe(raw)
      expect(mocks.writes).toEqual([])
    }
  )

  it('captures a proposal at facade admission before its asynchronous callback runs', async () => {
    const service = await import('./agentMemoryService')
    const proposal = await service.prepareCreateMemory('Approved exact content', 'user')
    const committed = service.commitMemoryMutation(proposal)
    proposal.after!.content = 'Unapproved replacement'
    expect((await committed).memories[0].content).toBe('Approved exact content')
    expect(JSON.parse(mocks.files.get(memoryPath)!).memories[0].content).toBe(
      'Approved exact content'
    )
  })

  it('keeps committed results successful even when memory notification and logging fail', async () => {
    const service = await import('./agentMemoryService')
    const listener = vi.fn(() => {
      throw new Error('Listener unavailable')
    })
    service.setAgentMemoryEventSink(listener)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('Log unavailable')
    })
    try {
      await expect(
        service.commitMemoryMutation(await service.prepareCreateMemory('First save', 'user'))
      ).resolves.toMatchObject({ memories: [{ content: 'First save' }] })
      await expect(
        service.commitMemoryMutation(await service.prepareCreateMemory('Second save', 'agent'))
      ).resolves.toMatchObject({
        memories: [{ content: 'First save' }, { content: 'Second save' }]
      })
      expect(listener).toHaveBeenCalledTimes(2)
      expect(JSON.parse(mocks.files.get(memoryPath)!).memories).toHaveLength(2)
    } finally {
      log.mockRestore()
    }
  })
})
