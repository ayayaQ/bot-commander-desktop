import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { atomicWrite, readWithBackup } from './atomicPersistence'

describe('atomic persistence', () => {
  let directory: string
  let path: string
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'bcfd-atomic-'))
    path = join(directory, 'state.json')
  })
  afterEach(async () => {
    vi.restoreAllMocks()
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
  })
})
