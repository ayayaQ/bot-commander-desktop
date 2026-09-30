import { afterAll, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({ directory: '', error: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }))
vi.mock('./rendererConsole', () => ({
  rendererConsole: { error: mocks.error, warning: vi.fn(), success: vi.fn(), info: vi.fn() }
}))

import { getBotStateContext, getStartupJs, initializeBotState, readBotState } from './virtual'

afterAll(async () => {
  getBotStateContext().dispose()
  await fs.rm(mocks.directory, { recursive: true, force: true })
})

it('opens a repairable initial engine when saved startup throws, retaining durable state and source', async () => {
  mocks.directory = await fs.mkdtemp(join(tmpdir(), 'bc-runtime-startup-'))
  const source = 'globalThis.partialStartup = true; throw new Error("saved startup failed")'
  await fs.writeFile(join(mocks.directory, 'startup.js'), source)
  await fs.writeFile(join(mocks.directory, 'botState.json'), '{"durable":true}')

  await initializeBotState()

  expect(await readBotState()).toEqual({ durable: true })
  expect(getBotStateContext().getVariable('partialStartup')).toBeUndefined()
  expect(await getStartupJs()).toBe(source)
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('retained for repair'))
})
