import { afterEach, describe, expect, it } from 'vitest'
import {
  pauseAgentPersistence,
  drainAgentPersistence,
  resumeAgentPersistence,
  withAgentPersistenceOperation
} from './agentPersistenceLifecycle'
import { withResourceMutationLock } from './resourceChangeService'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((yes) => (resolve = yes))
  return { promise, resolve }
}

afterEach(() => resumeAgentPersistence())

describe('agent persistence admission', () => {
  it('drains accepted jobs including checkpoints admitted after shutdown begins', async () => {
    const entered = deferred()
    const gate = deferred()
    const finalCheckpoint = deferred()
    const job = withAgentPersistenceOperation(async () => {
      entered.resolve()
      await gate.promise
      await withAgentPersistenceOperation(async () => {
        finalCheckpoint.resolve()
      })
    })
    await entered.promise
    pauseAgentPersistence()
    let finished = false
    const drain = drainAgentPersistence().then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    await expect(withAgentPersistenceOperation(async () => {})).rejects.toThrow('shutting down')
    gate.resolve()
    await Promise.all([job, finalCheckpoint.promise, drain])
    expect(finished).toBe(true)
  })

  it('allows a previously admitted resource job to finish its agent-memory persistence', async () => {
    const entered = deferred()
    const gate = deferred()
    const resource = withResourceMutationLock('memories', async () => {
      entered.resolve()
      await gate.promise
      return withAgentPersistenceOperation(async () => 'persisted')
    })
    await entered.promise
    pauseAgentPersistence()
    gate.resolve()
    await expect(resource).resolves.toBe('persisted')
    await drainAgentPersistence()
  })

  it('surfaces an accepted failing save and can reopen ingress after failed quit', async () => {
    const gate = deferred()
    const job = withAgentPersistenceOperation(async () => {
      await gate.promise
      throw new Error('Accepted save failed')
    })
    const failure = expect(job).rejects.toThrow('Accepted save failed')
    pauseAgentPersistence()
    const drain = expect(drainAgentPersistence()).rejects.toThrow(
      'Pending agent persistence failed'
    )
    gate.resolve()
    await Promise.all([failure, drain])
    resumeAgentPersistence()
    await expect(withAgentPersistenceOperation(async () => 'retry')).resolves.toBe('retry')
  })
})
