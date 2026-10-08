import fs from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

interface AtomicWriteOptions {
  validate?: (data: string) => void
  // Credential stores use this to ensure legacy plaintext never enters a backup.
  backupTransform?: (data: string) => string
}

export interface AtomicWriteResult {
  // All results acknowledge the rename commit. Only 'confirmed' also confirms directory fsync.
  durability: 'confirmed' | 'unsupported' | 'uncertain'
}

export interface AtomicWriteNotice {
  level: 'warning' | 'error'
  message: string
}

class DirectorySyncError extends Error {
  constructor(path: string, cause: unknown) {
    super(`The replacement of ${path} committed, but its directory could not be synced`, { cause })
  }
}

const writes = new Map<string, Promise<AtomicWriteResult>>()
const uncertainWrites = new Map<string, DirectorySyncError>()
const unsupportedDirectories = new Set<string>()
let noticeHandler: ((notice: AtomicWriteNotice) => void) | undefined
let writesClosed = false

/** A committed rename may still lack confirmed directory durability. */
export function hasUncertainAtomicWrites(): boolean {
  return uncertainWrites.size > 0
}

export function setAtomicWriteNoticeHandler(handler: (notice: AtomicWriteNotice) => void): void {
  noticeHandler = handler
}

function reportNotice(notice: AtomicWriteNotice): void {
  try {
    console[notice.level === 'error' ? 'error' : 'warn'](notice.message)
  } catch {
    // A broken log destination must not turn a committed save into a rejected operation.
  }
  try {
    noticeHandler?.(notice)
  } catch (error) {
    // Reporting must never turn a committed rename into a rejected, rollbackable operation.
    try {
      console.error('Could not report persistence notice:', error)
    } catch {
      // Preserve the commit result even when both notification and logging are unavailable.
    }
  }
}

export function reopenAtomicWrites(): void {
  writesClosed = false
}

export async function closeAndDrainAtomicWrites(): Promise<void> {
  writesClosed = true
  const results = await Promise.allSettled([...writes.values()])
  const errors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
  // A transient post-commit failure can be retried without rewriting data or its backup.
  // All accepted writes have finished, so syncing a directory confirms all its rename commits.
  const directories = new Set([...uncertainWrites.keys()].map(dirname))
  for (const directory of directories) {
    try {
      if (await syncDirectory(directory)) {
        for (const path of uncertainWrites.keys()) {
          if (dirname(path) === directory) uncertainWrites.delete(path)
        }
      }
    } catch (error) {
      for (const path of uncertainWrites.keys()) {
        if (dirname(path) === directory)
          uncertainWrites.set(path, new DirectorySyncError(path, error))
      }
    }
  }
  errors.push(...uncertainWrites.values())
  if (errors.length) throw new AggregateError(errors, 'Pending persistence failed during shutdown')
}

async function syncDirectory(directory: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    // Windows does not provide a supported directory-fsync operation through Node's fs API.
    if (process.platform === 'win32') return false
    handle = await fs.open(directory, 'r')
    await handle.sync()
    return true
  } catch (error) {
    // These codes denote an unsupported operation. Permissions and I/O errors remain failures.
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return false
    throw error
  } finally {
    await handle?.close()
  }
}

async function replaceFile(path: string, data: string): Promise<AtomicWriteResult> {
  const temporary = `${path}.${randomUUID()}.tmp`
  let file: Awaited<ReturnType<typeof fs.open>> | undefined
  try {
    file = await fs.open(temporary, 'wx', 0o600)
    await file.writeFile(data, 'utf8')
    await file.sync()
    await file.close()
    file = undefined
    await fs.rename(temporary, path)
    const directory = dirname(path)
    let supported: boolean
    try {
      supported = await syncDirectory(directory)
    } catch (error) {
      throw new DirectorySyncError(path, error)
    }
    if (!supported && !unsupportedDirectories.has(directory)) {
      unsupportedDirectories.add(directory)
      reportNotice({
        level: 'warning',
        message: `Directory sync is unsupported for ${directory}. Saves use atomic replacement and synced file contents, but rename durability across power loss cannot be guaranteed on this platform/filesystem.`
      })
    }
    return { durability: supported ? 'confirmed' : 'unsupported' }
  } finally {
    if (file) await file.close().catch(() => undefined)
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') console.error('Could not clean up temporary save file:', error)
    })
  }
}

/**
 * Pre-commit failures reject without changing the primary. After the primary rename commits,
 * directory-sync failures return 'uncertain', report a visible error, and block safe shutdown
 * until a successful write or shutdown directory-sync retry confirms that path. Callers must
 * keep the committed live state.
 * Unsupported directory fsync provides atomic replacement, not power-loss rename durability.
 */
export async function atomicWrite(
  path: string,
  data: string,
  options: AtomicWriteOptions = {}
): Promise<AtomicWriteResult> {
  if (writesClosed) throw new Error('The app is shutting down; persistence is closed')
  const previous = writes.get(path)
  const next = (previous ?? Promise.resolve())
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
      try {
        const result = await replaceFile(path, data)
        if (result.durability === 'confirmed') uncertainWrites.delete(path)
        // An unsupported sync cannot clear an earlier actual durability failure.
        if (uncertainWrites.has(path)) return { durability: 'uncertain' as const }
        return result
      } catch (error) {
        if (!(error instanceof DirectorySyncError)) throw error
        uncertainWrites.set(path, error)
        reportNotice({
          level: 'error',
          message: `${error.message}: ${String(error.cause)}. The new data is live and has not been rolled back. Power-loss durability is uncertain; retry saving this file or quit again to retry directory sync.`
        })
        return { durability: 'uncertain' as const }
      }
    })
  writes.set(path, next)
  try {
    return await next
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
