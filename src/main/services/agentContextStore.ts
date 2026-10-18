import fs from 'node:fs/promises'
import { validateContextCheckpoint, type ContextCheckpoint } from '@ayayaq/vivi'
import { atomicWrite } from './atomicPersistence'

const MAX_CHECKPOINT_BYTES = 256 * 1024
interface Envelope {
  version: 1
  sessionId: string
  checkpoint: ContextCheckpoint
}
interface Options {
  path: (sessionId: string) => string
  assertAllowed: (value: unknown) => void
  notice: (message: string) => void
}

/** Disposable derived context. Canonical history and approval/outcome records live elsewhere. */
export function createAgentContextStore(options: Options) {
  const pending = new Map<string, Promise<unknown>>()
  const deleted = new Set<string>()
  function decode(raw: string, sessionId: string): Envelope {
    if (Buffer.byteLength(raw) > MAX_CHECKPOINT_BYTES)
      throw new Error('Context checkpoint is too large')
    const value: unknown = JSON.parse(raw)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'checkpoint,sessionId,version' ||
      (value as Envelope).version !== 1 ||
      (value as Envelope).sessionId !== sessionId
    )
      throw new Error('Invalid context checkpoint envelope')
    validateContextCheckpoint((value as Envelope).checkpoint)
    if ((value as Envelope).checkpoint.source.id !== `desktop/session/${sessionId}`)
      throw new Error('Context source does not match the session')
    options.assertAllowed(value)
    return value as Envelope
  }

  return {
    async load(sessionId: string): Promise<ContextCheckpoint | undefined> {
      if (deleted.has(sessionId)) return undefined
      try {
        const path = options.path(sessionId)
        if ((await fs.stat(path)).size > MAX_CHECKPOINT_BYTES)
          throw new Error('Oversized context checkpoint')
        return structuredClone(decode(await fs.readFile(path, 'utf8'), sessionId).checkpoint)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          options.notice(
            'Saved compact context is unavailable; the original conversation is retained.'
          )
        return undefined
      }
    },
    async save(
      sessionId: string,
      checkpoint: ContextCheckpoint,
      beforeCommit?: () => void
    ): Promise<void> {
      const value: Envelope = { version: 1, sessionId, checkpoint: structuredClone(checkpoint) }
      const raw = JSON.stringify(value)
      decode(raw, sessionId)
      if (deleted.has(sessionId)) throw new Error('Agent session is being deleted')
      const operation = (pending.get(sessionId) ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (deleted.has(sessionId)) throw new Error('Agent session is being deleted')
          await atomicWrite(options.path(sessionId), raw, {
            beforeCommit: () => {
              if (deleted.has(sessionId)) throw new Error('Agent session is being deleted')
              beforeCommit?.()
            },
            validate: (text) => {
              decode(text, sessionId)
            }
          })
        })
      pending.set(sessionId, operation)
      try {
        await operation
      } finally {
        if (pending.get(sessionId) === operation) pending.delete(sessionId)
      }
    },
    async forget(sessionId: string): Promise<void> {
      deleted.add(sessionId)
      await pending.get(sessionId)?.catch(() => undefined)
      for (const path of [options.path(sessionId), `${options.path(sessionId)}.bak`]) {
        await fs.unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    }
  }
}
