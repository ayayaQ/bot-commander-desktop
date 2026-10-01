import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  atomicWrite,
  readWithBackup,
  closeAndDrainAtomicWrites,
  reopenAtomicWrites,
  setAtomicWriteNoticeHandler
} from './atomicPersistence'

describe('atomic persistence', () => {
  let directory: string
  let path: string
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'bcfd-atomic-'))
    path = join(directory, 'state.json')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    reopenAtomicWrites()
    // Clear a deliberately injected uncertain commit before deleting this test's directory.
    await atomicWrite(path, '{"cleanup":true}', { validate: JSON.parse })
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('keeps primary intact on fsync failure and cleans exclusive temporary files', async () => {
    await fs.writeFile(path, '{"value":"old"}')
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (String(args[0]).startsWith(`${path}.`) && !String(args[0]).includes('.bak.')) {
        vi.spyOn(handle, 'sync').mockRejectedValue(new Error('Disk sync failed'))
      }
      return handle
    })
    await expect(atomicWrite(path, '{"value":"new"}', { validate: JSON.parse })).rejects.toThrow(
      'Disk sync failed'
    )
    expect(await fs.readFile(path, 'utf8')).toBe('{"value":"old"}')
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('{"value":"old"}')
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('preserves the known-good backup when corrupt primary is replaced', async () => {
    await fs.writeFile(path, '{"truncated":')
    await fs.writeFile(`${path}.bak`, '{"value":"good"}')
    expect(await readWithBackup(path, JSON.parse)).toEqual({ value: 'good' })
    await atomicWrite(path, '{"value":"new"}', { validate: JSON.parse })
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('{"value":"good"}')
    expect(await readWithBackup(path, JSON.parse)).toEqual({ value: 'new' })
  })

  it('recovers shape-invalid JSON and refuses to default when only a corrupt backup exists', async () => {
    const decode = (data: string) => {
      const value = JSON.parse(data)
      if (!value || Array.isArray(value)) throw new Error('Expected object')
      return value
    }
    await fs.writeFile(path, '[]')
    await fs.writeFile(`${path}.bak`, '{"valid":true}')
    expect(await readWithBackup(path, decode)).toEqual({ valid: true })
    await fs.unlink(path)
    await fs.writeFile(`${path}.bak`, '{broken')
    await expect(readWithBackup(path, decode)).rejects.toThrow(SyntaxError)
  })

  it('serializes overlapping snapshots and allows retry after a failed rename', async () => {
    await fs.writeFile(path, '{"value":0}')
    const rename = fs.rename.bind(fs)
    let fail = true
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (destination === path && fail) {
        fail = false
        throw new Error('Rename failed')
      }
      return rename(source, destination)
    })
    const failed = atomicWrite(path, '{"value":1}', { validate: JSON.parse })
    const retried = atomicWrite(path, '{"value":2}', { validate: JSON.parse })
    await expect(failed).rejects.toThrow('Rename failed')
    await retried
    expect(await readWithBackup(path, JSON.parse)).toEqual({ value: 2 })
    expect(await readWithBackup(`${path}.bak`, JSON.parse)).toEqual({ value: 0 })
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
  })

  it('does not touch primary if preparing the backup fails', async () => {
    await fs.writeFile(path, '{"value":0}')
    await fs.mkdir(`${path}.bak`)
    await expect(atomicWrite(path, '{"value":1}', { validate: JSON.parse })).rejects.toThrow()
    expect(await fs.readFile(path, 'utf8')).toBe('{"value":0}')
    await fs.rm(`${path}.bak`, { recursive: true })
  })

  it('syncs each temporary file before rename and its parent after both backup and primary', async () => {
    await fs.writeFile(path, '{"value":0}')
    const operations: string[] = []
    const open = fs.open.bind(fs)
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      const sync = handle.sync.bind(handle)
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        operations.push(args[0] === directory ? 'directory sync' : 'file sync')
        await sync()
      })
      return handle
    })
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      operations.push(destination === path ? 'primary rename' : 'backup rename')
      await rename(source, destination)
    })

    expect(await atomicWrite(path, '{"value":1}', { validate: JSON.parse })).toEqual({
      durability: 'confirmed'
    })
    expect(operations).toEqual([
      'file sync',
      'backup rename',
      'directory sync',
      'file sync',
      'primary rename',
      'directory sync'
    ])
  })

  it('rejects backup-directory sync failure before changing the primary', async () => {
    await fs.writeFile(path, '{"value":0}')
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === directory) {
        vi.spyOn(handle, 'sync').mockRejectedValue(
          Object.assign(new Error('disk I/O'), { code: 'EIO' })
        )
      }
      return handle
    })
    await expect(atomicWrite(path, '{"value":1}', { validate: JSON.parse })).rejects.toThrow(
      'directory could not be synced'
    )
    expect(await fs.readFile(path, 'utf8')).toBe('{"value":0}')
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('{"value":0}')
  })

  it('keeps a committed primary after real sync failure, reports uncertainty, and blocks quit until retry', async () => {
    await fs.writeFile(path, '{"value":0}')
    const notice = vi.fn()
    setAtomicWriteNoticeHandler(notice)
    const open = fs.open.bind(fs)
    let directorySyncs = 0
    let failSync = true
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === directory && ++directorySyncs >= 2 && failSync) {
        vi.spyOn(handle, 'sync').mockRejectedValue(
          Object.assign(new Error('disk I/O'), { code: 'EIO' })
        )
      }
      return handle
    })
    expect(await atomicWrite(path, '{"value":1}', { validate: JSON.parse })).toEqual({
      durability: 'uncertain'
    })
    expect(await fs.readFile(path, 'utf8')).toBe('{"value":1}')
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('{"value":0}')
    expect(notice).toHaveBeenCalledWith({
      level: 'error',
      message: expect.stringContaining('has not been rolled back')
    })
    await expect(closeAndDrainAtomicWrites()).rejects.toThrow('Pending persistence failed')
    reopenAtomicWrites()
    failSync = false
    expect(await atomicWrite(path, '{"value":1}', { validate: JSON.parse })).toEqual({
      durability: 'confirmed'
    })
    await expect(closeAndDrainAtomicWrites()).resolves.toBeUndefined()
    expect((await fs.readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('can retry a transient committed-directory sync on quit without rewriting either file', async () => {
    const open = fs.open.bind(fs)
    let failSync = true
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args)
      if (args[0] === directory && failSync) {
        vi.spyOn(handle, 'sync').mockRejectedValue(
          Object.assign(new Error('disk I/O'), { code: 'EIO' })
        )
      }
      return handle
    })
    expect(await atomicWrite(path, '{"value":1}')).toEqual({ durability: 'uncertain' })
    const rename = vi.spyOn(fs, 'rename')
    await expect(closeAndDrainAtomicWrites()).rejects.toThrow('Pending persistence failed')
    failSync = false
    reopenAtomicWrites()
    await expect(closeAndDrainAtomicWrites()).resolves.toBeUndefined()
    expect(rename).not.toHaveBeenCalled()
    expect(await fs.readFile(path, 'utf8')).toBe('{"value":1}')
    await expect(fs.stat(`${path}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'])(
    'explicitly reports unsupported directory sync (%s) once per directory',
    async (code) => {
      const notice = vi.fn()
      setAtomicWriteNoticeHandler(notice)
      const open = fs.open.bind(fs)
      vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await open(...args)
        if (args[0] === directory) {
          vi.spyOn(handle, 'sync').mockRejectedValue(
            Object.assign(new Error('unsupported'), { code })
          )
        }
        return handle
      })
      expect(await atomicWrite(path, '{"value":1}')).toEqual({ durability: 'unsupported' })
      expect(await atomicWrite(path, '{"value":2}')).toEqual({ durability: 'unsupported' })
      expect(notice).toHaveBeenCalledOnce()
      expect(notice).toHaveBeenCalledWith({
        level: 'warning',
        message: expect.stringContaining('rename durability across power loss cannot be guaranteed')
      })
      await expect(closeAndDrainAtomicWrites()).resolves.toBeUndefined()
    }
  )

  it('uses the explicitly unsupported Windows path without attempting directory open', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const open = vi.spyOn(fs, 'open')
    const notice = vi.fn()
    setAtomicWriteNoticeHandler(notice)
    expect(await atomicWrite(path, '{}')).toEqual({ durability: 'unsupported' })
    expect(open.mock.calls.some((args) => args[0] === directory)).toBe(false)
    expect(notice).toHaveBeenCalledOnce()
  })

  it('treats directory-open permission failure as real uncertainty, not unsupported fsync', async () => {
    const notice = vi.fn()
    setAtomicWriteNoticeHandler(notice)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === directory) throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return open(...args)
    })
    expect(await atomicWrite(path, '{}')).toEqual({ durability: 'uncertain' })
    expect(notice).toHaveBeenCalledWith({ level: 'error', message: expect.any(String) })
  })

  it('does not reject a committed save if its notice handler throws', async () => {
    setAtomicWriteNoticeHandler(() => {
      throw new Error('notification failed')
    })
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === directory) throw Object.assign(new Error('disk I/O'), { code: 'EIO' })
      return open(...args)
    })
    expect(await atomicWrite(path, '{}')).toEqual({ durability: 'uncertain' })
    expect(await fs.readFile(path, 'utf8')).toBe('{}')
  })
})
