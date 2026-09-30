import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ScriptContext } from './quickJsScriptContext'

const mocks = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => mocks.directory } }))
vi.mock('./rendererConsole', () => ({
  rendererConsole: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() }
}))
vi.mock('../services/atomicPersistence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/atomicPersistence')>()
  return {
    ...actual,
    atomicWrite: vi.fn(actual.atomicWrite),
    readWithBackup: vi.fn(actual.readWithBackup)
  }
})
vi.mock('./quickJsScriptContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quickJsScriptContext')>()
  return { ...actual, createQuickJSScriptContext: vi.fn(actual.createQuickJSScriptContext) }
})

import { atomicWrite, readWithBackup } from '../services/atomicPersistence'
import { createQuickJSScriptContext } from './quickJsScriptContext'
import {
  evaluateBotState,
  getBotStateContext,
  getStartupJs,
  initializeBotState,
  loadBotState,
  readBotState,
  restartJsEngine,
  stopRuntimeAndCheckpoint,
  resumeRuntime,
  pauseRuntime,
  setBotState,
  setStartupJs,
  updateBotState,
  updateStartupJsAndRestart,
  withBotStateTransaction
} from './virtual'

const write = vi.mocked(atomicWrite)
const read = vi.mocked(readWithBackup)
const create = vi.mocked(createQuickJSScriptContext)
const directories: string[] = []

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  write.mockClear()
  read.mockClear()
  create.mockClear()
  mocks.directory = await fs.mkdtemp(join(tmpdir(), 'bc-runtime-state-'))
  directories.push(mocks.directory)
  await initializeBotState()
})

afterAll(async () => {
  getBotStateContext().dispose()
  await Promise.all(
    directories.map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('serialized runtime bot state checkpoints', () => {
  it('commits an immutable caller snapshot and returns detached read snapshots', async () => {
    const gate = deferred()
    const entered = deferred()
    const first = withBotStateTransaction(async () => {
      entered.resolve()
      await gate.promise
    })
    await entered.promise
    const input = { nested: { count: 1 } }
    const save = setBotState(input)
    input.nested.count = 999
    gate.resolve()
    await first
    await save

    const state = await readBotState()
    expect(state).toEqual({ nested: { count: 1 } })
    ;(state.nested as { count: number }).count = 20
    expect(await readBotState()).toEqual({ nested: { count: 1 } })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      nested: { count: 1 }
    })
  })

  it('rolls back evaluation failure, preserving pre-existing object and array aliases', async () => {
    await setBotState({ nested: { count: 1 }, values: [1, 2] })
    await evaluateBotState(
      'globalThis.alias = botState.nested; globalThis.valuesAlias = botState.values',
      { wrapReturn: false }
    )
    write.mockClear()

    await expect(
      evaluateBotState(
        'botState.nested.count = 9; botState.values.push(3); botState.extra = true; throw new Error("script failed")'
      )
    ).rejects.toThrow('script failed')
    expect(await readBotState()).toEqual({ nested: { count: 1 }, values: [1, 2] })
    expect(
      await evaluateBotState(
        'return alias === botState.nested && valuesAlias === botState.values && alias.count === 1 && valuesAlias.length === 2'
      )
    ).toBe(true)
    expect(write).not.toHaveBeenCalled()
  })

  it('holds later mutations and reads until a failed write has rolled back', async () => {
    await setBotState({ count: 0 })
    const entered = deferred()
    const gate = deferred()
    write.mockImplementationOnce(async () => {
      entered.resolve()
      await gate.promise
    })

    const first = evaluateBotState('botState.count += 1; return botState.count')
    const failure = expect(first).rejects.toThrow('disk failed')
    await entered.promise
    const second = evaluateBotState('botState.count += 1; return botState.count')
    const stateRead = readBotState()
    let readSettled = false
    void stateRead.then(() => {
      readSettled = true
    })
    await Promise.resolve()
    expect(readSettled).toBe(false)
    expect(getBotStateContext().getVariable('botState')).toEqual({ count: 1 })

    gate.reject(new Error('disk failed'))
    await failure
    expect(await second).toBe(1)
    expect(await stateRead).toEqual({ count: 1 })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      count: 1
    })
  })

  it('serializes async commands and checkpoints each completed mutation exactly once', async () => {
    const gate = deferred()
    const entered = deferred()
    const first = withBotStateTransaction(async (context) => {
      context.run('botState.count = 1')
      entered.resolve()
      await gate.promise
      context.run('botState.count += 1')
    })
    await entered.promise
    const second = updateBotState((state) => ({ ...state, count: Number(state.count) + 1 }))
    expect(write).not.toHaveBeenCalled()
    gate.resolve()
    await first
    await second

    expect(write.mock.calls.map((call) => JSON.parse(call[1]))).toEqual([
      { count: 2 },
      { count: 3 }
    ])
    expect(await readBotState()).toEqual({ count: 3 })
  })

  it('rolls back interpreters that return error data instead of throwing', async () => {
    const result = await withBotStateTransaction(
      (context) => {
        context.run('botState.shouldNotPersist = true')
        return { errors: ['JavaScript failed'], output: '[BCFD Error]' }
      },
      { shouldCommit: (result) => result.errors.length === 0 }
    )

    expect(result.output).toBe('[BCFD Error]')
    expect(await readBotState()).toEqual({})
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    'botState.bad = undefined',
    'botState.bad = function () {}',
    'botState.bad = NaN',
    'botState.bad = 1n',
    'botState.bad = botState',
    'botState.bad = new Date()',
    'botState.bad = [, 1]',
    'botState.bad = []; botState.bad.extra = true',
    'Object.defineProperty(botState, "bad", { get() { return 1 }, configurable: true, enumerable: true })'
  ])('rejects lossy JSON state and rolls back: %s', async (script) => {
    await expect(evaluateBotState(script)).rejects.toThrow(/botState/)
    expect(await readBotState()).toEqual({})
    expect(write).not.toHaveBeenCalled()
  })

  it('restores object prototypes on rollback', async () => {
    await setBotState({ nested: { count: 1 } })
    await expect(
      evaluateBotState('Object.setPrototypeOf(botState.nested, { injected: true })')
    ).rejects.toThrow('non-JSON object')
    expect(await readBotState()).toEqual({ nested: { count: 1 } })
    expect(
      await evaluateBotState('return Object.getPrototypeOf(botState.nested) === Object.prototype')
    ).toBe(true)
  })

  it('ignores inherited toJSON hooks when serializing durable JSON snapshots', async () => {
    await evaluateBotState(`
      Object.prototype.toJSON = function () { return { corrupted: true } }
      Array.prototype.toJSON = function () { return ['corrupted'] }
      botState.nested = { count: 1 }
      botState.values = [1, 2]
    `)
    expect(await readBotState()).toEqual({ nested: { count: 1 }, values: [1, 2] })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      nested: { count: 1 },
      values: [1, 2]
    })
  })

  it.each(['Array', 'Object'])(
    'keeps rollback bookkeeping independent of inherited numeric setters on %s.prototype',
    async (prototype) => {
      await setBotState({ count: 1, nested: { value: 2 }, values: [3] })
      await evaluateBotState(
        `
        globalThis.alias = botState.nested;
        globalThis.valuesAlias = botState.values;
        Object.defineProperty(${prototype}.prototype, '0', {
          get() { return undefined }, set(value) {}, configurable: true
        });
      `,
        { wrapReturn: false }
      )
      write.mockClear()
      await expect(
        evaluateBotState(`
        botState.count = 9;
        botState.nested.value = 8;
        botState.values[0] = 7;
        throw new Error('evaluation failed');
      `)
      ).rejects.toThrow('evaluation failed')
      expect(await readBotState()).toEqual({ count: 1, nested: { value: 2 }, values: [3] })
      expect(
        await evaluateBotState(
          'return alias === botState.nested && valuesAlias === botState.values && alias.value === 2 && valuesAlias[0] === 3'
        )
      ).toBe(true)
      expect(write).not.toHaveBeenCalled()
      write.mockRejectedValueOnce(new Error('disk failed'))
      await expect(
        evaluateBotState('botState.count = 9; botState.nested.value = 8; botState.values[0] = 7')
      ).rejects.toThrow('disk failed')
      expect(await readBotState()).toEqual({ count: 1, nested: { value: 2 }, values: [3] })
      expect(
        await evaluateBotState(
          'return alias === botState.nested && valuesAlias === botState.values && alias.value === 2 && valuesAlias[0] === 3'
        )
      ).toBe(true)
      expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual(
        { count: 1, nested: { value: 2 }, values: [3] }
      )
    }
  )

  it('rejects root accessors before they can bypass rollback or consume host assignments', async () => {
    await setBotState({ count: 1 })
    await expect(
      evaluateBotState(`
      globalThis.backing = botState;
      Object.defineProperty(globalThis, 'botState', {
        get() { return backing }, set(value) { backing = value }, configurable: true
      });
    `)
    ).rejects.toThrow('own data property')
    expect(await readBotState()).toEqual({ count: 1 })
    await expect(evaluateBotState('botState.count = 9; throw new Error("failed")')).rejects.toThrow(
      'failed'
    )
    expect(await readBotState()).toEqual({ count: 1 })
    await setBotState({ count: 2 })
    expect(await readBotState()).toEqual({ count: 2 })
  })

  it.each([
    'new Proxy(botState, {})',
    'Proxy.revocable(botState, {}).proxy',
    'new Proxy(botState, { ownKeys() { return [] } })'
  ])('rejects tracked proxy state from %s without invoking misleading traps', async (source) => {
    await setBotState({ count: 1 })
    await evaluateBotState(
      `WeakSet.prototype.has = function () { return false }; WeakSet.prototype.add = function () { return this }`
    )
    await expect(evaluateBotState(`botState.nested = ${source}`)).rejects.toThrow('Proxy')
    expect(await readBotState()).toEqual({ count: 1 })
    await expect(evaluateBotState(`botState = ${source}`)).rejects.toThrow('Proxy')
    expect(await readBotState()).toEqual({ count: 1 })
    expect(await evaluateBotState('return new Proxy({ unrelated: true }, {}).unrelated')).toBe(true)
    expect(getBotStateContext().getVariableNames()).not.toContain('__bcfd_private_proxy_check__')
  })

  it('rejects startup accessors before a host setter runs and retains the previous engine', async () => {
    await setBotState({ count: 1 })
    const active = getBotStateContext()
    await expect(
      updateStartupJsAndRestart(`
      Object.defineProperty(globalThis, 'botState', {
        get() { return { count: 1 } }, set(value) { throw new Error('setter must not run') }, configurable: true
      });
    `)
    ).rejects.toThrow('own data property')
    expect(getBotStateContext()).toBe(active)
    expect(await readBotState()).toEqual({ count: 1 })
  })

  it('closes runtime ingress and checkpoints the final accepted queued state before shutdown', async () => {
    const entered = deferred()
    const gate = deferred()
    const accepted = withBotStateTransaction(async (context) => {
      entered.resolve()
      await gate.promise
      context.run('botState.count = 4')
    })
    await entered.promise
    const checkpoint = stopRuntimeAndCheckpoint()
    try {
      await expect(evaluateBotState('botState.count = 9')).rejects.toThrow('shutting down')
      gate.resolve()
      await accepted
      await checkpoint
    } finally {
      resumeRuntime()
    }
    expect(await readBotState()).toEqual({ count: 4 })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      count: 4
    })
  })

  it('lets previously admitted resource jobs finish after new runtime ingress is paused', async () => {
    const {
      withResourceMutationLock,
      stopResourceMutations,
      resumeResourceMutations,
      drainResourceMutations
    } = await import('../services/resourceChangeService')
    const entered = deferred()
    const gate = deferred()
    const accepted = withResourceMutationLock('bot-state', async () => {
      entered.resolve()
      await gate.promise
      await setBotState({ count: 6 })
    })
    await entered.promise
    stopResourceMutations()
    pauseRuntime()
    try {
      await expect(evaluateBotState('botState.count = 9')).rejects.toThrow('shutting down')
      gate.resolve()
      await drainResourceMutations()
      await accepted
      await stopRuntimeAndCheckpoint()
    } finally {
      resumeRuntime()
      resumeResourceMutations()
    }
    expect(await readBotState()).toEqual({ count: 6 })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      count: 6
    })
  })

  it('does not trust user-modified array iterators or Set prototype methods', async () => {
    await setBotState({ nested: { count: 1 }, values: [1, 2] })
    await evaluateBotState(`
      Array.prototype[Symbol.iterator] = function* () {}
      Array.prototype.push = function () { throw new Error('hijacked push') }
      Set.prototype.has = function () { return false }
      Set.prototype.add = function () { throw new Error('hijacked add') }
      Set.prototype.delete = function () { throw new Error('hijacked delete') }
      botState.nested.count = 2
    `)
    expect(await readBotState()).toEqual({ nested: { count: 2 }, values: [1, 2] })
    await expect(
      evaluateBotState('botState.nested.count = 9; throw new Error("failed")')
    ).rejects.toThrow('failed')
    expect(await readBotState()).toEqual({ nested: { count: 2 }, values: [1, 2] })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      nested: { count: 2 },
      values: [1, 2]
    })
  })

  it('uses pristine JSON.parse for host assignments and rollback fallback', async () => {
    await evaluateBotState('JSON.parse = function () { return { hijacked: true } }')
    await setBotState({ intended: true })
    expect(await readBotState()).toEqual({ intended: true })
  })

  it('recovers visible JSON but explicitly reports incomplete alias rollback after freeze', async () => {
    await setBotState({ nested: { count: 1 } })
    await evaluateBotState('globalThis.alias = botState.nested', { wrapReturn: false })
    await expect(
      evaluateBotState(
        'botState.nested.count = 9; Object.freeze(botState.nested); throw new Error("failed")'
      )
    ).rejects.toThrow('alias rollback was incomplete')
    expect(await readBotState()).toEqual({ nested: { count: 1 } })
    // The error truthfully identifies the alias that cannot be repaired after irreversible freeze.
    expect(await evaluateBotState('return alias.count')).toBe(9)
    await restartJsEngine()
    expect(await readBotState()).toEqual({ nested: { count: 1 } })
  })

  it('recovers visible JSON and reports incomplete rollback for new nonconfigurable data', async () => {
    await setBotState({ count: 1 })
    write.mockRejectedValueOnce(new Error('disk failed'))
    await expect(
      evaluateBotState(
        'Object.defineProperty(botState, "stuck", { value: true, configurable: false, enumerable: true })'
      )
    ).rejects.toThrow('alias rollback was incomplete')
    expect(await readBotState()).toEqual({ count: 1 })
    expect(JSON.parse(await fs.readFile(join(mocks.directory, 'botState.json'), 'utf8'))).toEqual({
      count: 1
    })
  })

  it('blocks unhealthy runtime reads and writes until restart when even global rollback fails', async () => {
    await setBotState({ count: 1 })
    await expect(
      evaluateBotState(
        'Object.defineProperty(globalThis, "botState", { writable: false, configurable: false }); botState.count = 9; throw new Error("failed")'
      )
    ).rejects.toThrow('restart the JavaScript engine')
    await expect(readBotState()).rejects.toThrow('restart the JavaScript engine')
    await expect(evaluateBotState('return botState.count')).rejects.toThrow(
      'restart the JavaScript engine'
    )
    expect(() => getBotStateContext()).toThrow('restart the JavaScript engine')
    await restartJsEngine()
    expect(await readBotState()).toEqual({ count: 1 })
  })

  it('does not read or mutate state for an already stale load owner', async () => {
    await setBotState({ count: 1 })
    read.mockClear()
    await loadBotState(() => false)
    expect(read).not.toHaveBeenCalled()
    expect(await readBotState()).toEqual({ count: 1 })
  })

  it('rechecks load ownership after the state file read before touching the VM', async () => {
    await setBotState({ count: 1 })
    const gate = deferred()
    const entered = deferred()
    let current = true
    read.mockImplementationOnce(async (_path, decode) => {
      entered.resolve()
      await gate.promise
      return decode('{"count":9}')
    })
    const loading = loadBotState(() => current)
    await entered.promise
    current = false
    gate.resolve()
    await loading
    expect(await readBotState()).toEqual({ count: 1 })
  })

  it('recovers a valid backup state without promoting corrupt primary contents', async () => {
    await fs.writeFile(join(mocks.directory, 'botState.json'), '{corrupt')
    await fs.writeFile(join(mocks.directory, 'botState.json.bak'), '{"recovered":true}')
    await restartJsEngine()
    expect(await readBotState()).toEqual({ recovered: true })
    await evaluateBotState('botState.updated = true')
    expect(await fs.readFile(join(mocks.directory, 'botState.json.bak'), 'utf8')).toBe(
      '{"recovered":true}'
    )
  })
})

describe('staged JavaScript engine replacement', () => {
  async function retainCurrentOnFailure(action: () => Promise<void>) {
    await setBotState({ kept: true })
    const active = getBotStateContext()
    const dispose = vi.spyOn(active, 'dispose')
    await expect(action()).rejects.toThrow()
    expect(getBotStateContext()).toBe(active)
    expect(dispose).not.toHaveBeenCalled()
    expect(await readBotState()).toEqual({ kept: true })
  }

  it('keeps the active engine if replacement creation fails', async () => {
    await retainCurrentOnFailure(async () => {
      create.mockRejectedValueOnce(new Error('creation failed'))
      await restartJsEngine()
    })
  })

  it('keeps the active engine and disposes the candidate on state load failure', async () => {
    let candidate: ScriptContext | undefined
    const actual =
      await vi.importActual<typeof import('./quickJsScriptContext')>('./quickJsScriptContext')
    await retainCurrentOnFailure(async () => {
      create.mockImplementationOnce(async (options) => {
        candidate = await actual.createQuickJSScriptContext(options)
        vi.spyOn(candidate, 'dispose')
        return candidate as Awaited<ReturnType<typeof createQuickJSScriptContext>>
      })
      await fs.writeFile(join(mocks.directory, 'botState.json'), 'null')
      await fs.rm(join(mocks.directory, 'botState.json.bak'), { force: true })
      await restartJsEngine()
    })
    expect(candidate?.dispose).toHaveBeenCalledOnce()
  })

  it('keeps the active engine if startup throws or times out', async () => {
    await setStartupJs('throw new Error("startup failed")')
    await retainCurrentOnFailure(() => restartJsEngine())
    await setStartupJs('while (true) {}')
    await retainCurrentOnFailure(() => restartJsEngine())
  }, 15000)

  it('preserves startup.js and the active engine when replacement startup fails', async () => {
    await setStartupJs('globalThis.original = true')
    await retainCurrentOnFailure(() =>
      updateStartupJsAndRestart('throw new Error("new startup failed")')
    )
    expect(await getStartupJs()).toBe('globalThis.original = true')
  })

  it('preserves startup.js and the active engine when the startup file commit fails', async () => {
    await setStartupJs('globalThis.original = true')
    await retainCurrentOnFailure(async () => {
      write.mockRejectedValueOnce(new Error('disk failed'))
      await updateStartupJsAndRestart('globalThis.replacement = true')
    })
    expect(await getStartupJs()).toBe('globalThis.original = true')
  })

  it('only publishes a fully initialized replacement after its startup file is durable', async () => {
    await setBotState({ durable: true })
    const active = getBotStateContext()
    const dispose = vi.spyOn(active, 'dispose')
    await updateStartupJsAndRestart(
      'globalThis.replacement = true; botState.discardedStartupMutation = true'
    )
    expect(getBotStateContext()).not.toBe(active)
    expect(dispose).toHaveBeenCalledOnce()
    expect(getBotStateContext().getVariable('replacement')).toBe(true)
    expect(await readBotState()).toEqual({ durable: true })
    expect(await getStartupJs()).toContain('globalThis.replacement = true')
  })

  it('loads syntactically valid startup backup when the primary is malformed', async () => {
    await fs.writeFile(join(mocks.directory, 'startup.js'), 'this is invalid javascript')
    await fs.writeFile(
      join(mocks.directory, 'startup.js.bak'),
      'globalThis.recoveredStartup = true'
    )
    await restartJsEngine()
    expect(getBotStateContext().getVariable('recoveredStartup')).toBe(true)
  })
})
