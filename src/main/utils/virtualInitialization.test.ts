import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({ directory: '', error: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }))
vi.mock('./rendererConsole', () => ({
  rendererConsole: { error: mocks.error, warning: vi.fn(), success: vi.fn(), info: vi.fn() }
}))

vi.mock('./quickJsScriptContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quickJsScriptContext')>()
  return { ...actual, createQuickJSScriptContext: vi.fn(actual.createQuickJSScriptContext) }
})

let runtime: typeof import('./virtual')
beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.directory = await fs.mkdtemp(join(tmpdir(), 'bc-runtime-startup-'))
  runtime = await import('./virtual')
})

afterEach(async () => {
  try {
    runtime.getBotStateContext().dispose()
  } catch {
    // Recovery-only startup intentionally has no usable context to dispose.
  }
  await fs.rm(mocks.directory, { recursive: true, force: true })
})

it('opens a repairable initial engine when saved startup throws, retaining durable state and source', async () => {
  const source = 'globalThis.partialStartup = true; throw new Error("saved startup failed")'
  await fs.writeFile(join(mocks.directory, 'startup.js'), source)
  await fs.writeFile(join(mocks.directory, 'botState.json'), '{"durable":true}')

  await runtime.initializeBotState()

  expect(await runtime.readBotState()).toEqual({ durable: true })
  expect(runtime.getBotStateContext().getVariable('partialStartup')).toBeUndefined()
  expect(await runtime.getStartupJs()).toBe(source)
  expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('retained for repair'))
})

it.each(['{"count":', '[]', 'null'])(
  'retains invalid initial state (%s), blocks all runtime access, and can quit without rewriting it',
  async (bytes) => {
    const path = join(mocks.directory, 'botState.json')
    await fs.writeFile(path, bytes)
    await fs.writeFile(join(mocks.directory, 'startup.js'), 'globalThis.shouldNotRun = true')
    await expect(runtime.initializeBotState()).rejects.toThrow('saved files were retained')
    const { createQuickJSScriptContext } = await import('./quickJsScriptContext')
    expect(createQuickJSScriptContext).not.toHaveBeenCalled()
    expect(() => runtime.getBotStateContext()).toThrow('Restart JS Engine')
    await expect(runtime.readBotState()).rejects.toThrow('disabled')
    await expect(runtime.setBotState({})).rejects.toThrow('disabled')
    await expect(runtime.evaluateBotState('botState.reset = true')).rejects.toThrow('disabled')
    await expect(runtime.saveBotState()).rejects.toThrow('disabled')
    await runtime.stopRuntimeAndCheckpoint()
    runtime.resumeRuntime()
    await expect(runtime.readBotState()).rejects.toThrow('disabled')
    expect(await fs.readFile(path, 'utf8')).toBe(bytes)
    expect(await fs.readdir(mocks.directory)).toEqual(['botState.json', 'startup.js'])
  }
)

it.each([true, false])(
  'does not reset invalid backup data (primary exists: %s), and recovers only after explicit file repair',
  async (primaryExists) => {
    const path = join(mocks.directory, 'botState.json')
    if (primaryExists) await fs.writeFile(path, '{broken')
    await fs.writeFile(`${path}.bak`, '[]')
    await expect(runtime.initializeBotState()).rejects.toThrow('disabled')
    await expect(runtime.restartJsEngine()).rejects.toThrow()
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('[]')
    if (primaryExists) expect(await fs.readFile(path, 'utf8')).toBe('{broken')
    else await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })

    await fs.writeFile(`${path}.bak`, '{"repaired":true}')
    await runtime.restartJsEngine()
    expect(await runtime.readBotState()).toEqual({ repaired: true })
    await runtime.evaluateBotState('botState.next = 1')
    expect(JSON.parse(await fs.readFile(path, 'utf8'))).toEqual({ repaired: true, next: 1 })
    expect(await fs.readFile(`${path}.bak`, 'utf8')).toBe('{"repaired":true}')
  }
)

it('loads a valid backup on first startup while retaining the corrupt primary until a later save', async () => {
  const path = join(mocks.directory, 'botState.json')
  await fs.writeFile(path, '{broken')
  await fs.writeFile(`${path}.bak`, '{"recovered":true}')
  await runtime.initializeBotState()
  expect(await runtime.readBotState()).toEqual({ recovered: true })
  expect(await fs.readFile(path, 'utf8')).toBe('{broken')
  expect(mocks.error).not.toHaveBeenCalled()
})
