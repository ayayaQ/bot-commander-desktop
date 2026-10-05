import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite } from './atomicPersistence'

export interface AgentPersistenceNotice {
  level: 'warning' | 'error'
  message: string
}

interface AgentPersistenceOptions<T> {
  path: () => string
  label: string
  decode: (raw: string) => T
  empty: () => T
  notice?: (notice: AgentPersistenceNotice) => void
}

interface AgentPersistenceLoad<T> {
  data: T
  writable: boolean
}

type ReadResult<T> =
  | { kind: 'valid'; raw: string; data: T }
  | { kind: 'corrupt'; error: unknown }
  | { kind: 'unreadable'; error: unknown }
  | { kind: 'missing' }

let noticeHandler: ((notice: AgentPersistenceNotice) => void) | undefined

export function setAgentPersistenceNoticeHandler(
  handler: (notice: AgentPersistenceNotice) => void
): void {
  noticeHandler = handler
}

export function reportAgentPersistenceNotice(
  notice: AgentPersistenceNotice,
  handler?: (notice: AgentPersistenceNotice) => void
): void {
  try {
    const report = handler ?? noticeHandler
    if (report) {
      report(notice)
      return
    }
  } catch {
    // A notification failure must never change a save's commit result.
  }
  try {
    console[notice.level === 'error' ? 'error' : 'warn'](notice.message)
  } catch {
    // Recovery and persistence must also work when the log destination is unavailable.
  }
}

async function read<T>(path: string, decode: (raw: string) => T): Promise<ReadResult<T>> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable', error }
  }
  try {
    return { kind: 'valid', raw, data: decode(raw) }
  } catch (error) {
    return { kind: 'corrupt', error }
  }
}

/** Preserve the original bytes exclusively, and sync them before any destructive repair. */
async function preserveCorruptFile(path: string): Promise<string> {
  let preserved: string
  for (let attempt = 0; ; attempt++) {
    preserved = `${path}.${randomUUID()}.corrupt`
    try {
      await fs.copyFile(path, preserved, constants.COPYFILE_EXCL)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 9) throw error
    }
  }
  // Windows FlushFileBuffers requires a write-capable handle. Never truncate the evidence.
  const copy = await fs.open(preserved, 'r+')
  try {
    await copy.sync()
  } finally {
    await copy.close()
  }
  if (process.platform !== 'win32') {
    let directory: Awaited<ReturnType<typeof fs.open>> | undefined
    try {
      directory = await fs.open(dirname(path), 'r')
      await directory.sync()
    } catch (error) {
      if (
        !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes((error as NodeJS.ErrnoException).code ?? '')
      )
        throw error
    } finally {
      await directory?.close()
    }
  }
  return preserved
}

/**
 * A store has one load/recovery operation. Unrecoverable or unreadable stores stay read-only
 * for this process, so a later mutation cannot replace evidence with an empty fallback.
 */
export function createAgentPersistence<T>(options: AgentPersistenceOptions<T>): {
  load: () => Promise<AgentPersistenceLoad<T>>
  assertWritable: () => void
  save: (value: T) => Promise<void>
} {
  let loading: Promise<AgentPersistenceLoad<T>> | undefined
  let loaded: AgentPersistenceLoad<T> | undefined
  let path: string
  const notice = (level: AgentPersistenceNotice['level'], message: string): void =>
    reportAgentPersistenceNotice({ level, message }, options.notice)

  const write = async (raw: string): Promise<void> => {
    // Atomic persistence reports post-commit durability notices through its global router.
    // Every resolved result is a committed save; only rejection means it can be rolled back.
    await atomicWrite(path, raw, { validate: options.decode })
  }

  const recover = async (): Promise<AgentPersistenceLoad<T>> => {
    const primary = await read(path, options.decode)
    if (primary.kind === 'valid') return { data: primary.data, writable: true }
    const backupPath = `${path}.bak`
    const backup = await read(backupPath, options.decode)
    if (primary.kind === 'unreadable' || backup.kind === 'unreadable') {
      const error =
        primary.kind === 'unreadable'
          ? primary.error
          : backup.kind === 'unreadable'
            ? backup.error
            : undefined
      notice(
        'error',
        `${options.label} could not be read safely: ${String(error)}. Existing files have been kept and saving is disabled until the file problem is resolved and the app is restarted.`
      )
      return {
        data: backup.kind === 'valid' ? backup.data : options.empty(),
        writable: false
      }
    }
    if (primary.kind === 'missing' && backup.kind === 'missing')
      return { data: options.empty(), writable: true }

    if (backup.kind === 'valid') {
      let preserved: string | undefined
      try {
        if (primary.kind === 'corrupt') preserved = await preserveCorruptFile(path)
        await write(backup.raw)
      } catch (error) {
        notice(
          'error',
          `${options.label} was opened from its backup, but recovery could not be completed safely: ${String(error)}. Existing files have been kept and saving is disabled until the file problem is resolved and the app is restarted.`
        )
        return { data: backup.data, writable: false }
      }
      notice(
        'warning',
        `${options.label} was recovered from its backup because the primary file was ${primary.kind === 'missing' ? 'missing' : 'invalid'}.${preserved ? ` The damaged file was preserved at ${preserved}.` : ''}`
      )
      return { data: backup.data, writable: true }
    }

    const preservationErrors: unknown[] = []
    for (const [file, result] of [
      [path, primary],
      [backupPath, backup]
    ] as const) {
      if (result.kind === 'corrupt') {
        try {
          await preserveCorruptFile(file)
        } catch (error) {
          preservationErrors.push(error)
        }
      }
    }
    notice(
      'error',
      `${options.label} could not be recovered from the primary file or its backup. Original files have been kept and saving is disabled until the file problem is resolved and the app is restarted.${preservationErrors.length ? ` Could not preserve a separate damaged-file copy: ${preservationErrors.map(String).join('; ')}.` : ''}`
    )
    return { data: options.empty(), writable: false }
  }

  const load = (): Promise<AgentPersistenceLoad<T>> => {
    if (!loading) {
      path = options.path()
      loading = recover().then((result) => {
        loaded = result
        return result
      })
    }
    return loading
  }

  const assertWritable = (): void => {
    if (!loaded) throw new Error(`${options.label} has not finished loading`)
    if (!loaded.writable)
      throw new Error(`${options.label} is read-only because its persisted files need recovery`)
  }

  const save = async (value: T): Promise<void> => {
    // Serialize at admission, before waiting for recovery or earlier queued atomic writes.
    const snapshot = JSON.stringify(value, null, 2)
    options.decode(snapshot)
    await load()
    assertWritable()
    await write(snapshot)
  }

  return { load, assertWritable, save }
}
