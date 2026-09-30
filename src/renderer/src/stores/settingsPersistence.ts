import { get, writable } from 'svelte/store'
import type { AppSettings } from '../types/types'

export interface SettingsSaveStatus {
  saving: boolean
  unsaved: boolean
  error: string
}

function snapshot(settings: AppSettings): AppSettings {
  return JSON.parse(JSON.stringify(settings))
}

/** Keep editable settings separate from the last disk-confirmed settings. */
export function createSettingsPersistence(
  initial: AppSettings,
  persist: (settings: AppSettings) => Promise<AppSettings>,
  onCommitted: (settings: AppSettings) => void = () => {}
) {
  const committed = writable(snapshot(initial))
  const draft = writable(snapshot(initial))
  const status = writable<SettingsSaveStatus>({ saving: false, unsaved: false, error: '' })
  let pending: { settings: AppSettings; version: number } | null = null
  let version = 0
  let active: Promise<boolean> | null = null
  let commits = 0
  let loadVersion = 0

  function applyCommitted(settings: AppSettings) {
    committed.set(snapshot(settings))
    commits += 1
    try {
      onCommitted(snapshot(settings))
    } catch (error) {
      // Disk success is still success if an unrelated renderer effect fails.
      console.error('Could not apply saved settings effects', error)
    }
  }

  function setLoaded(settings: AppSettings) {
    const previous = get(committed) as unknown as Record<string, unknown>
    if (pending) {
      // Keep local edits while adopting confirmed external changes to untouched fields.
      const local = pending.settings as unknown as Record<string, unknown>
      const rebased = { ...settings } as AppSettings & Record<string, unknown>
      for (const key of new Set([...Object.keys(previous), ...Object.keys(local)])) {
        if (JSON.stringify(local[key]) !== JSON.stringify(previous[key])) rebased[key] = local[key]
      }
      pending = { settings: snapshot(rebased), version: ++version }
      draft.set(snapshot(rebased))
    } else {
      draft.set(snapshot(settings))
    }
    applyCommitted(settings)
  }

  async function load(read: () => Promise<AppSettings>) {
    const requested = ++loadVersion
    const startedAtVersion = version
    const startedAtCommit = commits
    const settings = await read()
    if (requested !== loadVersion || startedAtVersion !== version || startedAtCommit !== commits) {
      return false
    }
    setLoaded(settings)
    return true
  }

  function retry(): Promise<boolean> {
    if (active) return active
    if (!pending) return Promise.resolve(true)
    status.set({ saving: true, unsaved: true, error: '' })
    active = (async () => {
      await Promise.resolve()
      try {
        while (pending) {
          const submitted = pending
          // Each request gets its own copy; neither callers nor IPC can mutate a retry.
          const saved = await persist(snapshot(submitted.settings))
          if (!saved || typeof saved !== 'object') {
            throw new Error('Settings save was not confirmed')
          }
          applyCommitted(saved)
          if (pending.version === submitted.version) {
            pending = null
            draft.set(snapshot(saved))
          }
        }
        status.set({ saving: false, unsaved: false, error: '' })
        return true
      } catch (error) {
        status.set({
          saving: false,
          unsaved: true,
          error: error instanceof Error ? error.message : 'Could not save settings'
        })
        return false
      } finally {
        active = null
      }
    })()
    return active
  }

  function save(settings: AppSettings): Promise<boolean> {
    const next = snapshot(settings)
    pending = { settings: next, version: ++version }
    draft.set(snapshot(next))
    return retry()
  }

  function patch(changes: Partial<AppSettings>): Promise<boolean> {
    return save({ ...get(draft), ...changes })
  }

  return { committed, draft, status, setLoaded, load, save, patch, retry }
}
