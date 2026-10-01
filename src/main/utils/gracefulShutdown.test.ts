import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  atomicWrite,
  closeAndDrainAtomicWrites,
  reopenAtomicWrites
} from '../services/atomicPersistence'
import {
  stopResourceMutations,
  drainResourceMutations,
  resumeResourceMutations,
  withResourceMutationLock
} from '../services/resourceChangeService'
import { finishPersistenceBeforeQuit } from './gracefulShutdown'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

const directories: string[] = []
afterEach(async () => {
  reopenAtomicWrites()
  resumeResourceMutations()
  vi.restoreAllMocks()
  await Promise.all(directories.map((path) => fs.rm(path, { recursive: true, force: true })))
})

function shutdown() {
  return finishPersistenceBeforeQuit({
    pauseResources: stopResourceMutations,
    pauseRuntime: () => {},
    checkpointAndStopRuntime: async () => {},
    drainResources: drainResourceMutations,
    saveStats: async () => {},
    stopServer: async () => {},
    closeAndDrainWrites: closeAndDrainAtomicWrites,
    resumeResources: resumeResourceMutations,
    resumeRuntime: () => {},
    reopenWrites: reopenAtomicWrites
  })
}

it.each(['resource mutation', 'direct write'])(
  'waits for a gated %s rename before allowing exit',
  async (kind) => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'bcfd-shutdown-'))
    directories.push(directory)
    const path = join(directory, 'settings.json')
    await atomicWrite(path, '{"theme":"light"}', { validate: JSON.parse })
    const entered = deferred()
    const gate = deferred()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (target === path) {
        entered.resolve()
        await gate.promise
      }
      await rename(source, target)
    })
    const save = () => atomicWrite(path, '{"theme":"dark"}', { validate: JSON.parse })
    const pending =
      kind === 'resource mutation' ? withResourceMutationLock('settings', save) : save()
    await entered.promise
    let exited = false
    const finishing = shutdown().then(() => {
      exited = true
    })
    await Promise.resolve()
    expect(exited).toBe(false)
    await expect(withResourceMutationLock('settings', save)).rejects.toThrow('shutting down')
    gate.resolve()
    await pending
    await finishing
    expect(exited).toBe(true)
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ theme: 'dark' })
    await expect(atomicWrite(path, '{}')).rejects.toThrow('shutting down')
  }
)

describe('failed shutdown recovery', () => {
  it('waits for all jobs and reopens mutation and write ingress after failure', async () => {
    const entered = deferred()
    const gate = deferred()
    let reopened = false
    const finishing = finishPersistenceBeforeQuit({
      pauseResources: stopResourceMutations,
      pauseRuntime: () => {},
      checkpointAndStopRuntime: async () => {
        throw new Error('Checkpoint failed')
      },
      drainResources: async () => {
        entered.resolve()
        await gate.promise
      },
      saveStats: async () => {},
      stopServer: async () => {},
      closeAndDrainWrites: closeAndDrainAtomicWrites,
      resumeResources: resumeResourceMutations,
      resumeRuntime: () => {
        reopened = true
      },
      reopenWrites: reopenAtomicWrites
    })
    const failure = expect(finishing).rejects.toThrow('Could not finish persistence')
    await entered.promise
    expect(reopened).toBe(false)
    gate.resolve()
    await failure
    expect(reopened).toBe(true)
    await expect(withResourceMutationLock('settings', async () => 'retry')).resolves.toBe('retry')
    const directory = await fs.mkdtemp(join(tmpdir(), 'bcfd-shutdown-retry-'))
    directories.push(directory)
    await expect(atomicWrite(join(directory, 'retry.json'), '{}')).resolves.toEqual({
      durability: 'confirmed'
    })
  })
})
