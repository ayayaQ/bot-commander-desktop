import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

interface AtomicWriteOptions {
  validate?: (data: string) => void
  // Credential stores use this to ensure legacy plaintext never enters a backup.
  backupTransform?: (data: string) => string
}

const writes = new Map<string, Promise<void>>()
let writesClosed = false

export function reopenAtomicWrites(): void {
  writesClosed = false
}

export async function closeAndDrainAtomicWrites(): Promise<void> {
  writesClosed = true
  const results = await Promise.allSettled([...writes.values()])
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  if (errors.length) throw new AggregateError(errors, 'Pending persistence failed during shutdown')
}

async function replaceFile(path: string, data: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  let file: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    file = await fs.open(temporary, 'wx', 0o600)
    await file.writeFile(data, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await fs.rename(temporary, path)
  } finally {
    if (file) await file.close().catch(() => undefined)
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') console.error('Could not clean up temporary save file:', error)
    })
  }
}

/** A failed operation never truncates the current file or promotes a corrupt primary to backup. */
export async function atomicWrite(
  path: string,
  data: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  if (writesClosed) throw new Error('The app is shutting down; persistence is closed')
  const previous = writes.get(path) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      options.validate?.(data)
      await fs.mkdir(dirname(path), { recursive: true })
      let backup: string | undefined
      try {
        const current = await fs.readFile(path, 'utf8')
        try {
          options.validate?.(current)
          backup = current
        } catch {
          // Do not replace the last recoverable copy with malformed or incompatible data.
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (backup === undefined && options.backupTransform) {
        let existing: string | undefined
        try {
          existing = await fs.readFile(`${path}.bak`, 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (existing !== undefined) {
          try {
            options.validate?.(existing)
            backup = existing
          } catch {
            // An invalid backup cannot become a valid backup by being copied.
          }
        }
      }
      if (backup !== undefined) {
        backup = options.backupTransform ? options.backupTransform(backup) : backup
        await replaceFile(`${path}.bak`, backup)
      }
      await replaceFile(path, data)
    })
  writes.set(path, next)
  try {
    await next
  } finally {
    if (writes.get(path) === next) writes.delete(path)
  }
}

/** Decoding is part of validation, so valid JSON with the wrong shape also recovers from .bak. */
export async function readWithBackup<T>(path: string, decode: (data: string) => T): Promise<T> {
  let primaryError: unknown
  try {
    return decode(await fs.readFile(path, 'utf8'))
  } catch (error) {
    primaryError = error
  }
  try {
    return decode(await fs.readFile(`${path}.bak`, 'utf8'))
  } catch (backupError) {
    if (
      (primaryError as NodeJS.ErrnoException).code === 'ENOENT' &&
      (backupError as NodeJS.ErrnoException).code !== 'ENOENT'
    )
      throw backupError
    throw primaryError
  }
}
