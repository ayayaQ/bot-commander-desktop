import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { atomicWriteJson, BACKUP_SUFFIX, readJsonWithBackup } from './atomicFile'

describe('atomicFile', () => {
  let directory: string
  let path: string

  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'bcfd-atomic-file-'))
    path = join(directory, 'resource.json')
  })

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true })
  })

  it('keeps the previous complete value as a recovery backup', async () => {
    await atomicWriteJson(path, { version: 1 })
    await atomicWriteJson(path, { version: 2 })

    await expect(fs.readFile(`${path}${BACKUP_SUFFIX}`, 'utf-8')).resolves.toContain('"version": 1')
    await expect(fs.readFile(path, 'utf-8')).resolves.toContain('"version": 2')
  })

  it('recovers a corrupt primary file and repairs it from the backup', async () => {
    await atomicWriteJson(path, { version: 1 })
    await atomicWriteJson(path, { version: 2 })
    await fs.writeFile(path, '{partial')

    await expect(readJsonWithBackup<{ version: number }>(path)).resolves.toEqual({
      value: { version: 1 },
      recoveredFromBackup: true
    })
    await expect(fs.readFile(path, 'utf-8')).resolves.toContain('"version": 1')
  })

  it('never rotates corrupt primary JSON over a known-good backup', async () => {
    await atomicWriteJson(path, { version: 1 })
    await atomicWriteJson(path, { version: 2 })
    await fs.writeFile(path, '{partial')

    await atomicWriteJson(path, { version: 3 })

    await expect(fs.readFile(path, 'utf-8')).resolves.toContain('"version": 3')
    await expect(fs.readFile(`${path}${BACKUP_SUFFIX}`, 'utf-8')).resolves.toContain('"version": 1')
  })

  it('leaves the primary file untouched when the replacement cannot be prepared', async () => {
    await atomicWriteJson(path, { version: 1 })
    await fs.mkdir(`${path}${BACKUP_SUFFIX}`)

    await expect(atomicWriteJson(path, { version: 2 })).rejects.toThrow()
    await expect(fs.readFile(path, 'utf-8')).resolves.toContain('"version": 1')

    const files = await fs.readdir(directory)
    expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([])
  })
})
