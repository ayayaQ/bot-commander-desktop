import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})

function run(code: string, state: Record<string, unknown> = {}) {
  const vm = factory(state)
  try {
    return { output: vm.evaluate(code), state: vm.state() }
  } finally {
    vm.dispose()
  }
}

describe('offline playground QuickJS sandbox', () => {
  it('converts eval results with the production return wrapper and persists JSON data', () => {
    expect(
      run(
        'botState.count++; botState.nested = { items: [true, null, "ok"] }; return botState.count',
        { count: 1 }
      )
    ).toEqual({ output: '2', state: { count: 2, nested: { items: [true, null, 'ok'] } } })
    expect(run('return undefined').output).toBe('')
    expect(run('return null').output).toBe('null')
    expect(run('return [1, 2]').output).toBe('1,2')
  })

  it('rejects invalid deadlines rather than disabling interrupts', () => {
    expect(() => factory({}, { timeoutMs: NaN })).toThrow(/timeout/)
    expect(() => factory({}, { deadline: NaN })).toThrow(/deadline/)
    expect(() => factory({}, { timeoutMs: Infinity })).toThrow(/timeout/)
  })

  it('shares variables within one sandbox and resets them in a new command', () => {
    const vm = factory({})
    try {
      vm.set('message', 'hi " quoted')
      expect(vm.evaluate('return message')).toBe('hi " quoted')
      expect(vm.get('message')).toBe('hi " quoted')
      vm.set('value', undefined)
      expect(vm.get('value')).toBe('')
      vm.evaluate('globalThis.counter = 9')
      expect(vm.get('counter')).toBe('9')
      vm.delete('counter')
      expect(vm.get('counter')).toBe('')
      expect(vm.evaluate('var localOnly = 1')).toBe('')
      expect(vm.get('localOnly')).toBe('')
    } finally {
      vm.dispose()
      vm.dispose()
    }
    expect(run('return typeof message').output).toBe('undefined')
  })

  it('allocates temporary bindings without colliding with explicitly set variables', () => {
    const vm = factory({})
    try {
      vm.set('__playground_bcfd_0', 'preserved')
      vm.evaluate(
        'Object.defineProperty(globalThis, "__playground_bcfd_1", { get() { while(true) {} }, configurable: true })'
      )
      const name = vm.temp('temporary')
      expect(name).toBe('__playground_bcfd_2')
      expect(vm.get(name)).toBe('temporary')
      vm.delete(name)
      expect(vm.variables(['__playground_bcfd_0'])).toEqual({ __playground_bcfd_0: 'preserved' })
    } finally {
      vm.dispose()
    }
  })

  it('exposes no host capabilities or module loader', () => {
    expect(
      run(
        'return [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof window, typeof document, typeof importScripts, typeof electron, typeof debug, typeof Proxy].join(",")'
      ).output
    ).toBe(Array(11).fill('undefined').join(','))
    expect(() => run('return process.env')).toThrow()
  })

  it.each([
    'botState.x = undefined',
    'botState.x = () => 1',
    'botState.x = 1n',
    'botState.x = Infinity',
    'botState.x = NaN',
    'botState.x = Symbol("x")',
    'botState[Symbol("x")] = 1',
    'botState.x = new Date()',
    'botState.x = new Map()',
    'botState.x = botState',
    'botState.x = [,1]',
    'botState.x = []; botState.x.extra = 1',
    'Object.defineProperty(botState, "x", { get() { while (true) {} }, enumerable: true })',
    'Object.defineProperty(botState, "x", { value: 1, enumerable: false })',
    'botState = []',
    'botState = null'
  ])('rejects non-JSON bot state: %s', (code) => {
    const vm = factory({})
    try {
      vm.evaluate(code)
      expect(() => vm.state()).toThrow(/plain JSON data/)
    } finally {
      vm.dispose()
    }
  })

  it('does not invoke host accessors or toJSON callbacks', () => {
    let called = false
    const value = {
      get x() {
        called = true
        throw new Error('getter invoked')
      }
    }
    expect(() => factory(value)).toThrow(/plain JSON data/)
    expect(called).toBe(false)
    expect(() =>
      factory({
        toJSON() {
          called = true
          return {}
        }
      })
    ).toThrow(/plain JSON data/)
    expect(called).toBe(false)
  })

  it('captured intrinsics withstand global/prototype tampering', () => {
    expect(
      run(
        'String = () => "wrong"; JSON.stringify = () => "{}"; Object.prototype.value = 42; RegExp.prototype.test = () => true; botState.list = [1,2]; return 3'
      )
    ).toEqual({ output: '3', state: { list: [1, 2] } })
    const vm = factory({})
    try {
      vm.evaluate(
        'Object.prototype.value = 42; Object.defineProperty(botState, "x", Object.assign(Object.create(null), { get() { return 1 }, enumerable: true }))'
      )
      expect(() => vm.state()).toThrow(/plain JSON data/)
    } finally {
      vm.dispose()
    }
  })

  it.each([
    ['eval', 'while (true) {}'],
    ['conversion', 'return { toString() { while (true) {} } }'],
    [
      'error conversion',
      'throw { get message() { while (true) {} }, toString() { while (true) {} } }'
    ]
  ])('bounds %s and poisons failed commands', (_, code) => {
    const vm = factory({}, { timeoutMs: 40 })
    const started = performance.now()
    try {
      expect(() => vm.evaluate(code)).toThrow()
      expect(performance.now() - started).toBeLessThan(1000)
      expect(() => vm.state()).toThrow(/failed|time limit/)
    } finally {
      vm.dispose()
    }
  })

  it('bounds get conversion and refuses calls after the overall lifetime', async () => {
    const vm = factory({}, { timeoutMs: 40 })
    try {
      vm.evaluate('globalThis.bad = { toString() { while (true) {} } }')
      expect(() => vm.get('bad')).toThrow(/time limit|interrupted/)
    } finally {
      vm.dispose()
    }
    const expired = factory({}, { timeoutMs: 20 })
    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(() => expired.set('x', '1')).toThrow(/time limit/)
    } finally {
      expired.dispose()
    }
  })

  it('bounds state serialization and stack/memory exhaustion', () => {
    const vm = factory({}, { timeoutMs: 40 })
    try {
      vm.evaluate('for (let i=0; i<3000; i++) botState["x"+i] = i')
      expect(() => {
        while (true) vm.state()
      }).toThrow(/time limit|interrupted/)
    } finally {
      vm.dispose()
    }
    expect(() => run('function loop() { return loop() }; return loop()')).toThrow()
    expect(() => run('return "x".repeat(20_000_000)')).toThrow(/out of memory/)
    expect(run('return 7').output).toBe('7')
  })

  it('snapshots only tracked JSON variables and omits deleted/undefined values', () => {
    const vm = factory({})
    try {
      vm.set('saved', { count: 1 })
      vm.set('unused', 'gone')
      vm.delete('unused')
      vm.set('nothing', undefined)
      vm.evaluate('saved.count++; globalThis.untracked = 8')
      expect(vm.variables(['saved', 'unused', 'nothing'])).toEqual({ saved: { count: 2 } })
      vm.evaluate('saved = () => 1')
      expect(() => vm.variables(['saved'])).toThrow(/plain JSON data/)
    } finally {
      vm.dispose()
    }
  })

  it('discards mutated state when a command fails and leaves initial state untouched', () => {
    const initial = { count: 1 }
    expect(() => run('botState.count = 8; throw new Error("no commit")', initial)).toThrow(
      'no commit'
    )
    expect(initial).toEqual({ count: 1 })
    expect(run('return botState.count', initial)).toEqual({ output: '1', state: initial })
  })
})
