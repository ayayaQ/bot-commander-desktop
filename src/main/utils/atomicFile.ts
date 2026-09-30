import fs from 'fs/promises'
import { dirname } from 'path'
import crypto from 'crypto'

export const BACKUP_SUFFIX = '.bak'

type AtomicWriteOptions = {
  backup?: boolean
  validateBackupSource?: (contents: string) => boolean
}

function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
}

async function writeTemporaryFile(path: string, contents: string): Promise<void> {
  const handle = await fs.open(path, 'wx', 0o600)
  try {
    await handle.writeFile(contents, 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    handle = await fs.open(dirname(path), 'r')
    await handle.sync()
  } catch {
    // Directory fsync is unavailable on some supported filesystems. The file itself was
    // fsynced before the atomic rename, so do not report a failed save after it committed.
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

export async function atomicWriteFile(
  path: string,
  contents: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const nextPath = temporaryPath(path)
  const backupPath = `${path}${BACKUP_SUFFIX}`
  let backupTempPath: string | undefined

  try {
    await writeTemporaryFile(nextPath, contents)

    if (options.backup !== false) {
      try {
        const currentContents = await fs.readFile(path, 'utf-8')
        if (!options.validateBackupSource || options.validateBackupSource(currentContents)) {
          backupTempPath = temporaryPath(backupPath)
          await writeTemporaryFile(backupTempPath, currentContents)
          await fs.rename(backupTempPath, backupPath)
          backupTempPath = undefined
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }

    await fs.rename(nextPath, path)
    await syncParentDirectory(path)
  } finally {
    await Promise.allSettled([
      fs.unlink(nextPath),
      ...(backupTempPath ? [fs.unlink(backupTempPath)] : [])
    ])
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteJsonText(path, JSON.stringify(value, null, 2))
}

export async function atomicWriteJsonText(
  path: string,
  contents: string,
  options: Pick<AtomicWriteOptions, 'backup'> = {}
): Promise<void> {
  JSON.parse(contents)
  await atomicWriteFile(path, contents, {
    ...options,
    validateBackupSource: (currentContents) => {
      try {
        JSON.parse(currentContents)
        return true
      } catch {
        return false
      }
    }
  })
}

export type RecoveredJson<T> = {
  value: T
  recoveredFromBackup: boolean
}

export async function readJsonWithBackup<T>(path: string): Promise<RecoveredJson<T>> {
  let primaryError: unknown
  try {
    return {
      value: JSON.parse(await fs.readFile(path, 'utf-8')) as T,
      recoveredFromBackup: false
    }
  } catch (error) {
    primaryError = error
  }

  try {
    const backupContents = await fs.readFile(`${path}${BACKUP_SUFFIX}`, 'utf-8')
    const value = JSON.parse(backupContents) as T
    await atomicWriteFile(path, backupContents, { backup: false })
    return { value, recoveredFromBackup: true }
  } catch {
    throw primaryError
  }
}
