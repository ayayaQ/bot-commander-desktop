import { get, writable } from 'svelte/store'
import type { BCFDCommand } from '../types/types'
import { cloneCommandDraft } from './commandDraft'

export interface CommandSaveSnapshot {
  bcfdCommands: BCFDCommand[]
  expectedRevision: string
}

export interface CommandSaveStatus {
  saving: boolean
  pending: boolean
  error: string
}

function cloneSnapshot(snapshot: CommandSaveSnapshot): CommandSaveSnapshot {
  return {
    bcfdCommands: snapshot.bcfdCommands.map(cloneCommandDraft),
    expectedRevision: snapshot.expectedRevision
  }
}

/** One staged mutation at a time. Retry reuses its contents, IDs and revision. */
export function createCommandPersistence(
  persist: (snapshot: CommandSaveSnapshot) => Promise<{ success: boolean; revision?: string }>,
  commit: (snapshot: CommandSaveSnapshot, revision: string) => void
) {
  const status = writable<CommandSaveStatus>({ saving: false, pending: false, error: '' })
  let pending: { snapshot: CommandSaveSnapshot; onSaved: () => void } | null = null
  let active: Promise<boolean> | null = null

  function retry(): Promise<boolean> {
    if (active) return active
    if (!pending) return Promise.resolve(true)
    const submitted = pending
    status.set({ saving: true, pending: true, error: '' })
    active = (async () => {
      await Promise.resolve()
      try {
        const result = await persist(cloneSnapshot(submitted.snapshot))
        if (!result?.success) throw new Error('Command save was not confirmed')
        commit(
          cloneSnapshot(submitted.snapshot),
          result.revision || submitted.snapshot.expectedRevision
        )
        pending = null
        status.set({ saving: false, pending: false, error: '' })
        try {
          submitted.onSaved()
        } catch (error) {
          // A post-save UI effect must not turn confirmed persistence into a failed retry.
          console.error('Could not finish saved command UI', error)
        }
        return true
      } catch (error) {
        status.set({
          saving: false,
          pending: true,
          error: error instanceof Error ? error.message : 'Could not save commands'
        })
        return false
      } finally {
        active = null
      }
    })()
    return active
  }

  function save(snapshot: CommandSaveSnapshot, onSaved: () => void = () => {}): Promise<boolean> {
    if (active) return Promise.resolve(false)
    pending = { snapshot: cloneSnapshot(snapshot), onSaved }
    return retry()
  }

  function discard(): boolean {
    if (get(status).saving) return false
    pending = null
    status.set({ saving: false, pending: false, error: '' })
    return true
  }

  return { status, save, retry, discard }
}

/** New imports are separate commands even if the source already has a local ID. */
export function prepareCommandImports(
  commands: readonly BCFDCommand[],
  existing: readonly BCFDCommand[],
  createId: () => string = () => crypto.randomUUID()
): BCFDCommand[] {
  const usedIds = new Set(existing.map((command) => command.id))
  return commands.map((command) => {
    const imported = cloneCommandDraft(command)
    while (!imported.id || usedIds.has(imported.id)) imported.id = createId()
    usedIds.add(imported.id)
    return imported
  })
}
