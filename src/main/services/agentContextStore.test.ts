import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextCheckpoint } from '@ayayaq/vivi'
import { createAgentContextStore } from './agentContextStore'

let directory: string
const checkpoint: ContextCheckpoint = {
  version: 1,
  source: {
    id: 'desktop/session/session-one',
    revision: 'a'.repeat(64),
    projectionRevision: 'a'.repeat(64),
    messageCount: 2
  },
  summary: 'Older task background. This is not approval or evidence of a tool outcome.',
  createdAt: '2026-10-15T10:00:00.000Z'
}
const notice = vi.fn()
const assertAllowed = vi.fn()
const path = (sessionId: string) => join(directory, `${sessionId}.json`)
const store = () => createAgentContextStore({ path, notice, assertAllowed })

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'agent-context-'))
  notice.mockReset()
  assertAllowed.mockReset()
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

describe('separate source-bound desktop context checkpoints', () => {
  it('round-trips a versioned checkpoint independently of canonical raw history', async () => {
    await store().save('session-one', checkpoint)
    expect(await store().load('session-one')).toEqual(checkpoint)
    expect(notice).not.toHaveBeenCalled()
    const loaded = await store().load('session-one')
    loaded!.summary = 'Changed copy'
    expect((await store().load('session-one'))!.summary).toBe(checkpoint.summary)
    expect(assertAllowed).toHaveBeenCalled()
  })

  it('ignores a missing, corrupt, incompatible or cross-session checkpoint safely', async () => {
    expect(await store().load('session-one')).toBeUndefined()
    expect(notice).not.toHaveBeenCalled()
    for (const raw of [
      '{',
      JSON.stringify({ version: 2, sessionId: 'session-one', checkpoint }),
      JSON.stringify({ version: 1, sessionId: 'someone-else', checkpoint })
    ]) {
      await fs.writeFile(path('session-one'), raw)
      expect(await store().load('session-one')).toBeUndefined()
      expect(await fs.readFile(path('session-one'), 'utf8')).toBe(raw)
    }
    expect(notice).toHaveBeenCalledTimes(3)
  })

  it('checks privacy before committing a generated summary and retains the prior checkpoint on failure', async () => {
    await store().save('session-one', checkpoint)
    assertAllowed.mockImplementation((value) => {
      if (JSON.stringify(value).includes('credential')) throw new Error('private')
    })
    await expect(
      store().save('session-one', { ...checkpoint, summary: 'credential' })
    ).rejects.toThrow('private')
    expect((await store().load('session-one'))!.summary).toBe(checkpoint.summary)
  })

  it('rejects malformed and oversized checkpoints before writing and removes only derived files', async () => {
    await expect(
      store().save('session-one', {
        ...checkpoint,
        source: { ...checkpoint.source, messageCount: 0 }
      })
    ).rejects.toThrow()
    await expect(
      store().save('session-one', { ...checkpoint, summary: 'x'.repeat(256 * 1024) })
    ).rejects.toThrow('too large')
    await store().save('session-one', checkpoint)
    await store().save('session-one', checkpoint)
    await fs.writeFile(join(directory, 'canonical.json'), 'raw evidence')
    await store().forget('session-one')
    expect(await store().load('session-one')).toBeUndefined()
    await expect(fs.stat(`${path('session-one')}.bak`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(join(directory, 'canonical.json'), 'utf8')).toBe('raw evidence')
  })
})

it('serializes deletion behind an admitted checkpoint and prevents late resurrection', async () => {
  const active = store()
  const writing = active.save('session-one', checkpoint)
  await Promise.allSettled([writing, active.forget('session-one')])
  expect(await active.load('session-one')).toBeUndefined()
  await expect(fs.stat(path('session-one'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(active.save('session-one', checkpoint)).rejects.toThrow('being deleted')
})
