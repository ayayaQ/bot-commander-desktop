import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  operations: [] as { operation: string; path: string }[],
  fault: undefined as ((operation: string, path: string) => void | Promise<void>) | undefined,
  fs: {
    readFile: vi.fn(),
    mkdir: vi.fn(),
    copyFile: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn()
  }
}))

vi.mock('node:fs/promises', () => ({ default: mock.fs }))

interface Store {
  version: 1
  values: number[]
}

const directory = '/agent-test'
const path = `${directory}/agent.json`
const backupPath = `${path}.bak`
const raw = (values: number[]): string => JSON.stringify({ version: 1, values })
const empty = (): Store => ({ version: 1, values: [] })
const decode = (data: string): Store => {
  const value: unknown = JSON.parse(data)
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Store).version !== 1 ||
    !Array.isArray((value as Store).values) ||
    !(value as Store).values.every((entry) => typeof entry === 'number')
  )
    throw new Error('Invalid store envelope')
  return value as Store
}
const error = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })
const put = (file: string, data: string | Buffer): void => {
  mock.files.set(file, Buffer.from(data))
}
const text = (file: string): string | undefined => mock.files.get(file)?.toString('utf8')
const copies = (file: string): string[] =>
  [...mock.files.keys()].filter((name) => name.startsWith(`${file}.`) && name.endsWith('.corrupt'))

let createAgentPersistence: typeof import('./agentPersistence').createAgentPersistence
let setAgentPersistenceNoticeHandler: typeof import('./agentPersistence').setAgentPersistenceNoticeHandler
let atomic: typeof import('./atomicPersistence')

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.resetModules()
  mock.files.clear()
  mock.operations.length = 0
  mock.fault = undefined
  const operation = async (name: string, file: string): Promise<void> => {
    mock.operations.push({ operation: name, path: file })
    await mock.fault?.(name, file)
  }
  mock.fs.readFile.mockImplementation(async (file: string) => {
    await operation('read', file)
    const bytes = mock.files.get(file)
    if (!bytes) throw error('ENOENT')
    return bytes.toString('utf8')
  })
  mock.fs.mkdir.mockImplementation(async (file: string) => operation('mkdir', file))
  mock.fs.copyFile.mockImplementation(async (source: string, destination: string) => {
    await operation('copy', source)
    if (mock.files.has(destination)) throw error('EEXIST')
    const bytes = mock.files.get(source)
    if (!bytes) throw error('ENOENT')
    put(destination, bytes)
  })
  mock.fs.open.mockImplementation(async (file: string, flags: string) => {
    await operation('open', file)
    if (flags === 'wx') {
      if (mock.files.has(file)) throw error('EEXIST')
      put(file, '')
    } else if (file !== directory && !mock.files.has(file)) throw error('ENOENT')
    return {
      writeFile: async (data: string) => {
        await operation('write', file)
        put(file, data)
      },
      sync: async () => operation('sync', file),
      close: async () => operation('close', file)
    }
  })
  mock.fs.rename.mockImplementation(async (source: string, destination: string) => {
    await operation('rename', destination)
    const bytes = mock.files.get(source)
    if (!bytes) throw error('ENOENT')
    put(destination, bytes)
    mock.files.delete(source)
  })
  mock.fs.unlink.mockImplementation(async (file: string) => {
    await operation('unlink', file)
    if (!mock.files.delete(file)) throw error('ENOENT')
  })
  ;({ createAgentPersistence, setAgentPersistenceNoticeHandler } =
    await import('./agentPersistence'))
  atomic = await import('./atomicPersistence')
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

function store(notice = vi.fn()): ReturnType<typeof createAgentPersistence<Store>> {
  return createAgentPersistence({
    path: () => path,
    label: 'Agent test store',
    decode,
    empty,
    notice
  })
}

describe('agent persistence recovery', () => {
  it('loads a valid primary without consulting or changing its backup', async () => {
    put(path, raw([1]))
    put(backupPath, '{invalid')
    const notice = vi.fn()
    const persistence = store(notice)
    expect(() => persistence.assertWritable()).toThrow('has not finished loading')
    expect(await persistence.load()).toEqual({ data: decode(raw([1])), writable: true })
    expect(() => persistence.assertWritable()).not.toThrow()
    expect(mock.fs.readFile).toHaveBeenCalledTimes(1)
    expect(text(backupPath)).toBe('{invalid')
    expect(notice).not.toHaveBeenCalled()
  })

  it('treats only two missing files as a writable empty store', async () => {
    const persistence = store()
    expect(await persistence.load()).toEqual({ data: empty(), writable: true })
    expect(mock.files.size).toBe(0)
    await persistence.save({ version: 1, values: [2] })
    expect(decode(text(path)!)).toEqual({ version: 1, values: [2] })
  })

  it('preserves exact damaged bytes and recovers a valid backup before enabling saves', async () => {
    const damaged = Buffer.from([123, 255, 0, 98])
    put(path, damaged)
    put(backupPath, raw([3]))
    const notice = vi.fn()
    const persistence = store(notice)
    expect(await persistence.load()).toEqual({ data: decode(raw([3])), writable: true })
    expect(copies(path)).toHaveLength(1)
    expect(mock.files.get(copies(path)[0])).toEqual(damaged)
    expect(text(path)).toBe(raw([3]))
    expect(text(backupPath)).toBe(raw([3]))
    const preservedSync = mock.operations.findIndex(
      (entry) => entry.operation === 'sync' && entry.path === copies(path)[0]
    )
    const replacement = mock.operations.findIndex(
      (entry) => entry.operation === 'rename' && entry.path === path
    )
    expect(preservedSync).toBeGreaterThan(-1)
    expect(replacement).toBeGreaterThan(preservedSync)
    expect(notice).toHaveBeenCalledWith({
      level: 'warning',
      message: expect.stringContaining('recovered from its backup')
    })
  })

  it.each(['[]', '{"version":2,"values":[]}', '{"version":1,"values":["wrong"]}'])(
    'uses strict caller validation to recover the wrong envelope %s',
    async (damaged) => {
      put(path, damaged)
      put(backupPath, raw([4]))
      expect(await store().load()).toEqual({ data: decode(raw([4])), writable: true })
      expect(text(copies(path)[0])).toBe(damaged)
      expect(text(backupPath)).toBe(raw([4]))
    }
  )

  it('recovers a missing primary from a valid backup with a visible warning', async () => {
    put(backupPath, raw([5]))
    const notice = vi.fn()
    expect(await store(notice).load()).toEqual({ data: decode(raw([5])), writable: true })
    expect(text(path)).toBe(raw([5]))
    expect(text(backupPath)).toBe(raw([5]))
    expect(copies(path)).toHaveLength(0)
    expect(notice).toHaveBeenCalledWith({
      level: 'warning',
      message: expect.stringContaining('primary file was missing')
    })
  })

  it('uses a non-truncating write-capable handle to sync preserved evidence on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    put(path, '{bad')
    put(backupPath, raw([2]))
    expect(await store().load()).toEqual({ data: decode(raw([2])), writable: true })
    const preserved = copies(path)[0]
    expect(text(preserved)).toBe('{bad')
    expect(mock.fs.open).toHaveBeenCalledWith(preserved, 'r+')
    expect(mock.fs.open.mock.calls.some(([file]) => file === directory)).toBe(false)
  })

  it('preserves both corrupt files and blocks every save of the empty fallback', async () => {
    put(path, '{truncated')
    put(backupPath, '[]')
    const notice = vi.fn()
    const persistence = store(notice)
    expect(await persistence.load()).toEqual({ data: empty(), writable: false })
    expect(() => persistence.assertWritable()).toThrow('read-only')
    await expect(persistence.save(empty())).rejects.toThrow('read-only')
    expect(text(path)).toBe('{truncated')
    expect(text(backupPath)).toBe('[]')
    expect(text(copies(path)[0])).toBe('{truncated')
    expect(text(copies(backupPath)[0])).toBe('[]')
    expect(mock.fs.rename).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith({
      level: 'error',
      message: expect.stringContaining('saving is disabled')
    })
  })

  it.each([path, backupPath])('keeps a lone corrupt file at %s read-only', async (file) => {
    put(file, '{bad')
    const persistence = store()
    expect(await persistence.load()).toEqual({ data: empty(), writable: false })
    expect(text(file)).toBe('{bad')
    expect(text(copies(file)[0])).toBe('{bad')
    await expect(persistence.save(empty())).rejects.toThrow('read-only')
    expect(mock.fs.rename).not.toHaveBeenCalled()
  })

  it.each(['EACCES', 'EIO', 'EISDIR'])(
    'keeps valid backup data read-only when the primary cannot be read (%s)',
    async (code) => {
      put(path, raw([1]))
      put(backupPath, raw([2]))
      mock.fault = (operation, file) => {
        if (operation === 'read' && file === path) throw error(code)
      }
      const persistence = store()
      expect(await persistence.load()).toEqual({ data: decode(raw([2])), writable: false })
      await expect(persistence.save(empty())).rejects.toThrow('read-only')
      expect(mock.fs.copyFile).not.toHaveBeenCalled()
      expect(mock.fs.open).not.toHaveBeenCalled()
      expect(text(path)).toBe(raw([1]))
    }
  )

  it('does not perform recovery writes when an invalid primary has an unreadable backup', async () => {
    put(path, '{bad')
    put(backupPath, raw([2]))
    mock.fault = (operation, file) => {
      if (operation === 'read' && file === backupPath) throw error('EIO')
    }
    expect(await store().load()).toEqual({ data: empty(), writable: false })
    expect(mock.fs.copyFile).not.toHaveBeenCalled()
    expect(mock.fs.open).not.toHaveBeenCalled()
    expect(text(path)).toBe('{bad')
    expect(text(backupPath)).toBe(raw([2]))
  })

  it.each(['copy', 'file sync', 'directory sync'])(
    'never replaces the damaged primary if preservation fails at %s',
    async (stage) => {
      put(path, '{bad')
      put(backupPath, raw([2]))
      mock.fault = (operation, file) => {
        if (
          (stage === 'copy' && operation === 'copy') ||
          (stage === 'file sync' && operation === 'sync' && file.endsWith('.corrupt')) ||
          (stage === 'directory sync' && operation === 'sync' && file === directory)
        )
          throw error('EIO')
      }
      const persistence = store()
      expect(await persistence.load()).toEqual({ data: decode(raw([2])), writable: false })
      expect(text(path)).toBe('{bad')
      expect(text(backupPath)).toBe(raw([2]))
      expect(mock.fs.rename).not.toHaveBeenCalled()
      await expect(persistence.save(empty())).rejects.toThrow('read-only')
    }
  )

  it('tries a new exclusive corrupt-copy name after a collision', async () => {
    put(path, '{bad')
    put(backupPath, raw([2]))
    let collide = true
    mock.fault = (operation) => {
      if (operation === 'copy' && collide) {
        collide = false
        throw error('EEXIST')
      }
    }
    expect((await store().load()).writable).toBe(true)
    expect(mock.fs.copyFile).toHaveBeenCalledTimes(2)
    const destinations = mock.fs.copyFile.mock.calls.slice(-2).map((call) => call[1])
    expect(destinations[0]).not.toBe(destinations[1])
    expect(copies(path)).toHaveLength(1)
  })

  it('blocks repair safely when exclusive preservation repeatedly collides', async () => {
    put(path, '{bad')
    put(backupPath, raw([2]))
    mock.fault = (operation) => {
      if (operation === 'copy') throw error('EEXIST')
    }
    expect(await store().load()).toEqual({ data: decode(raw([2])), writable: false })
    expect(mock.fs.copyFile).toHaveBeenCalledTimes(10)
    expect(mock.fs.rename).not.toHaveBeenCalled()
    expect(text(path)).toBe('{bad')
    expect(text(backupPath)).toBe(raw([2]))
  })

  it('keeps unrecoverable originals when separate preservation also fails', async () => {
    put(path, '{bad-primary')
    put(backupPath, '{bad-backup')
    mock.fault = (operation) => {
      if (operation === 'copy') throw error('ENOSPC')
    }
    const notice = vi.fn()
    expect(await store(notice).load()).toEqual({ data: empty(), writable: false })
    expect(text(path)).toBe('{bad-primary')
    expect(text(backupPath)).toBe('{bad-backup')
    expect(mock.fs.rename).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledWith({
      level: 'error',
      message: expect.stringContaining('Could not preserve a separate damaged-file copy')
    })
  })

  it('opens known-good backup data read-only if the recovery rename fails', async () => {
    put(path, '{bad')
    put(backupPath, raw([2]))
    mock.fault = (operation, file) => {
      if (operation === 'rename' && file === path) throw error('EACCES')
    }
    expect(await store().load()).toEqual({ data: decode(raw([2])), writable: false })
    expect(text(path)).toBe('{bad')
    expect(text(backupPath)).toBe(raw([2]))
    expect(text(copies(path)[0])).toBe('{bad')
    expect([...mock.files.keys()].some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('shares a single in-flight load and does not make repeated preservation copies', async () => {
    put(path, '{bad')
    put(backupPath, raw([2]))
    const persistence = store()
    const first = persistence.load()
    const second = persistence.load()
    expect(first).toBe(second)
    expect(await first).toBe(await second)
    expect(persistence.load()).toBe(first)
    expect(copies(path)).toHaveLength(1)
  })

  it('routes notices to the global handler when no per-store override is given', async () => {
    put(backupPath, raw([2]))
    const notice = vi.fn()
    setAgentPersistenceNoticeHandler(notice)
    const persistence = createAgentPersistence({
      path: () => path,
      label: 'Global store',
      decode,
      empty
    })
    expect((await persistence.load()).writable).toBe(true)
    expect(notice).toHaveBeenCalledWith({
      level: 'warning',
      message: expect.stringContaining('Global store was recovered')
    })
  })

  it('does not throw when both notice reporting and console fallback fail', async () => {
    put(backupPath, raw([2]))
    const notice = vi.fn(() => {
      throw new Error('Notice destination failed')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('Console unavailable')
    })
    expect(await store(notice).load()).toEqual({ data: decode(raw([2])), writable: true })
    expect(text(path)).toBe(raw([2]))
  })
})

describe('agent persistence atomic saves', () => {
  it('captures each snapshot at admission while load and earlier writes are still pending', async () => {
    put(path, raw([0]))
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waiting = true
    mock.fault = async (operation, file) => {
      if (operation === 'read' && file === path && waiting) await gate
    }
    const persistence = store()
    const value: Store = { version: 1, values: [1] }
    const first = persistence.save(value)
    value.values.push(2)
    const second = persistence.save(value)
    value.values.push(3)
    waiting = false
    release!()
    await Promise.all([first, second])
    expect(decode(text(path)!)).toEqual({ version: 1, values: [1, 2] })
    expect(decode(text(backupPath)!)).toEqual({ version: 1, values: [1] })
  })

  it('keeps queued snapshots detached from caller mutations during an earlier atomic write', async () => {
    put(path, raw([0]))
    const persistence = store()
    await persistence.load()
    let release: () => void
    let writing: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      writing = resolve
    })
    let paused = true
    mock.fault = async (operation, file) => {
      if (operation === 'write' && file.startsWith(`${backupPath}.`) && paused) {
        writing!()
        await gate
      }
    }
    const first = persistence.save({ version: 1, values: [1] })
    await started
    const pending: Store = { version: 1, values: [2] }
    const second = persistence.save(pending)
    pending.values.push(3)
    paused = false
    release!()
    await Promise.all([first, second])
    expect(decode(text(path)!)).toEqual({ version: 1, values: [2] })
    expect(decode(text(backupPath)!)).toEqual({ version: 1, values: [1] })
  })

  it('rejects a wrong-envelope snapshot before performing any filesystem operation', async () => {
    const persistence = store()
    await expect(persistence.save({ version: 2, values: [] } as unknown as Store)).rejects.toThrow(
      'Invalid store envelope'
    )
    expect(mock.operations).toEqual([])
    expect(mock.files.size).toBe(0)
  })

  it('does not replace a known-good backup with a shape-invalid primary during save', async () => {
    put(path, raw([1]))
    put(backupPath, raw([0]))
    const persistence = store()
    await persistence.load()
    put(path, '{"version":2,"values":[]}')
    await persistence.save({ version: 1, values: [2] })
    expect(decode(text(path)!)).toEqual({ version: 1, values: [2] })
    expect(text(backupPath)).toBe(raw([0]))
  })

  it.each(['primary file sync', 'backup file sync', 'backup directory sync', 'primary rename'])(
    'rejects before primary commit at %s and permits a later retry',
    async (stage) => {
      put(path, raw([0]))
      const persistence = store()
      await persistence.load()
      let directorySyncs = 0
      mock.fault = (operation, file) => {
        if (operation === 'sync' && file === directory) directorySyncs++
        if (
          (stage === 'primary file sync' &&
            operation === 'sync' &&
            file.startsWith(`${path}.`) &&
            !file.startsWith(`${backupPath}.`)) ||
          (stage === 'backup file sync' &&
            operation === 'sync' &&
            file.startsWith(`${backupPath}.`)) ||
          (stage === 'backup directory sync' &&
            operation === 'sync' &&
            file === directory &&
            directorySyncs === 1) ||
          (stage === 'primary rename' && operation === 'rename' && file === path)
        )
          throw error('EIO')
      }
      await expect(persistence.save({ version: 1, values: [1] })).rejects.toThrow()
      expect(text(path)).toBe(raw([0]))
      expect([...mock.files.keys()].some((name) => name.endsWith('.tmp'))).toBe(false)
      mock.fault = undefined
      await expect(persistence.save({ version: 1, values: [2] })).resolves.toBeUndefined()
      expect(decode(text(path)!)).toEqual({ version: 1, values: [2] })
      expect(text(backupPath)).toBe(raw([0]))
    }
  )

  it('blocks save writes on a primary read IO failure rather than treating it as corruption', async () => {
    put(path, raw([0]))
    const persistence = store()
    await persistence.load()
    mock.fault = (operation, file) => {
      if (operation === 'read' && file === path) throw error('EIO')
    }
    await expect(persistence.save({ version: 1, values: [1] })).rejects.toThrow('EIO')
    expect(text(path)).toBe(raw([0]))
    expect(mock.fs.open).not.toHaveBeenCalled()
    expect(mock.files.has(backupPath)).toBe(false)
  })

  it('resolves post-commit uncertainty without rollback and retains atomic shutdown retry semantics', async () => {
    put(path, raw([0]))
    const notice = vi.fn()
    const persistence = store(notice)
    await persistence.load()
    atomic.setAtomicWriteNoticeHandler(notice)
    let directorySyncs = 0
    let failSync = true
    mock.fault = (operation, file) => {
      if (operation === 'sync' && file === directory) {
        directorySyncs++
        if (directorySyncs >= 2 && failSync) throw error('EIO')
      }
    }
    await expect(persistence.save({ version: 1, values: [1] })).resolves.toBeUndefined()
    expect(decode(text(path)!)).toEqual({ version: 1, values: [1] })
    expect(text(backupPath)).toBe(raw([0]))
    expect(() => persistence.assertWritable()).not.toThrow()
    expect(notice).toHaveBeenCalledWith({
      level: 'error',
      message: expect.stringContaining('new data is live and has not been rolled back')
    })
    await expect(atomic.closeAndDrainAtomicWrites()).rejects.toThrow('Pending persistence failed')
    const renames = mock.fs.rename.mock.calls.length
    failSync = false
    await expect(atomic.closeAndDrainAtomicWrites()).resolves.toBeUndefined()
    expect(mock.fs.rename.mock.calls.length).toBe(renames)
  })

  it('keeps a recovered commit writable when only its post-rename directory sync fails', async () => {
    put(backupPath, raw([2]))
    mock.fault = (operation, file) => {
      if (operation === 'sync' && file === directory) throw error('EIO')
    }
    const notice = vi.fn()
    atomic.setAtomicWriteNoticeHandler(notice)
    expect(await store(notice).load()).toEqual({ data: decode(raw([2])), writable: true })
    expect(text(path)).toBe(raw([2]))
    expect(text(backupPath)).toBe(raw([2]))
    expect(notice).toHaveBeenCalledWith({
      level: 'error',
      message: expect.stringContaining('has not been rolled back')
    })
  })

  it('does not reject an uncertain committed save when the reporting destinations fail', async () => {
    const notice = vi.fn(() => {
      throw new Error('Notice destination failed')
    })
    const persistence = store(notice)
    atomic.setAtomicWriteNoticeHandler(notice)
    await persistence.load()
    mock.fault = (operation, file) => {
      if (operation === 'sync' && file === directory) throw error('EIO')
    }
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('Console unavailable')
    })
    await expect(persistence.save({ version: 1, values: [3] })).resolves.toBeUndefined()
    expect(decode(text(path)!)).toEqual({ version: 1, values: [3] })
  })
})
