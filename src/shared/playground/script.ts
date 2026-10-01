import { QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from 'quickjs-emscripten-core'
import { QuickJSFFI } from '@jitl/quickjs-wasmfile-release-sync/ffi'
import moduleLoader from '@jitl/quickjs-wasmfile-release-sync/emscripten-module'
import wasmDataUrl from '@jitl/quickjs-wasmfile-release-sync/wasm?url&inline'

export interface ScriptSandboxOptions {
  /** Epoch milliseconds. Share this deadline between all commands in one request. */
  deadline?: number
  /** May shorten, but never extend, the 750ms lifetime. */
  timeoutMs?: number
}

export interface ScriptSandbox {
  set(name: string, value: unknown): void
  temp(value: string): string
  get(name: string): string
  delete(name: string): void
  evaluate(code: string, options?: { wrapReturn?: boolean }): string
  state(): Record<string, unknown>
  variables(names: string[]): Record<string, unknown>
  dispose(): void
}

export type ScriptSandboxFactory = (
  botState: Record<string, unknown>,
  options?: ScriptSandboxOptions
) => ScriptSandbox

const MEMORY_BYTES = 8 * 1024 * 1024
// The WASM build needs C-stack headroom during overflow unwinding. 128KB is
// deliberately below the 512KB policy ceiling; 512KB can abort JS_FreeRuntime.
const STACK_BYTES = 128 * 1024
const LIFETIME_MS = 750
const MAX_STRING = 32_768
const MAX_JSON = 65_536
const MAX_DEPTH = 32
const MAX_VALUES = 10_000

let bundledModule: Promise<QuickJSWASMModule> | undefined

/**
 * Vite MUST inline the WASM in the worker bundle. A non-inline URL is an error;
 * there is deliberately no fetch, filesystem, importScripts, or remote fallback.
 * The Emscripten loader receives bytes explicitly and never needs its file loader.
 */
export async function loadScriptSandboxFactory(): Promise<ScriptSandboxFactory> {
  bundledModule ??= (async () => {
    const prefix = /^data:application\/wasm;base64,/
    if (!prefix.test(wasmDataUrl)) throw new Error('Playground WASM must be bundled inline')
    const encoded = wasmDataUrl.replace(prefix, '')
    const decoded = atob(encoded)
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0))
    const module = await moduleLoader({ wasmBinary: bytes.buffer })
    module.type = 'sync'
    return new QuickJSWASMModule(module, new QuickJSFFI(module))
  })()
  return createScriptSandboxFactory(await bundledModule)
}

/** Separate module injection keeps Node tests on the normal Node WASM loader. */
export function createScriptSandboxFactory(module: QuickJSWASMModule): ScriptSandboxFactory {
  return (botState, options) => new OfflineScriptSandbox(module, botState, options)
}

export async function createScriptSandbox(
  botState: Record<string, unknown>,
  options?: ScriptSandboxOptions
): Promise<ScriptSandbox> {
  return (await loadScriptSandboxFactory())(botState, options)
}

// Only this trusted bootstrap is evaluated before user code. Its functions are held
// by host handles, never placed on globals. Capture intrinsics so user modifications
// to JSON, String, Object, Array, Reflect, or their prototypes cannot bypass checks.
const BOOTSTRAP = `(() => {
  const global = globalThis
  const string = String
  const parse = JSON.parse
  const stringify = JSON.stringify
  const own = Object.prototype.hasOwnProperty
  const ownKeys = Reflect.ownKeys
  const descriptor = Object.getOwnPropertyDescriptor
  const define = Object.defineProperty
  const create = Object.create
  const prototype = Object.getPrototypeOf
  const setPrototype = Object.setPrototypeOf
  const objectPrototype = Object.prototype
  const arrayPrototype = Array.prototype
  const isArray = Array.isArray
  const finite = Number.isFinite
  const integer = Number.isInteger
  const ErrorClass = Error
  const SetClass = Set
  const setHas = Set.prototype.has
  const setAdd = Set.prototype.add
  const setDelete = Set.prototype.delete
  const apply = Reflect.apply
  const fail = () => { throw new ErrorClass('botState must contain only plain JSON data') }
  // No proxies may enter from the host, and scripts cannot construct one. This
  // prevents transparent proxies from masquerading as ordinary JSON objects.
  define(global, 'Proxy', { value: undefined, writable: false, configurable: false })
  define(global, 'botState', { value: {}, writable: true, configurable: false })
  let temporaryCounter = 0
  const boundedText = output => {
    if (output.length > ${MAX_STRING}) throw new ErrorClass('Script output exceeds the playground limit')
    return output
  }
  const text = value => {
    if (value === undefined) return ''
    if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
      return boundedText(string(value))
    // QuickJS context.dump JSON-serializes objects (including Date/toJSON), falling
    // back to their string form when serialization fails. Production then applies
    // host String to that dumped value. Keep all user callbacks inside this VM and
    // its shared interrupt/memory/stack limits; never dump a user object into the host.
    let json
    try { json = stringify(value) } catch { json = undefined }
    if (json === undefined) json = string(value)
    if (json.length > ${MAX_JSON}) throw new ErrorClass('Script result exceeds the playground limit')
    let dumped
    try { dumped = parse(json) } catch { return boundedText(json) }
    let count = 0
    const dumpText = (item, depth) => {
      if (++count > ${MAX_VALUES} || depth > ${MAX_DEPTH})
        throw new ErrorClass('Script result exceeds the playground limit')
      if (item === null || typeof item !== 'object') return boundedText(string(item))
      if (!isArray(item)) {
        // JSON data cannot contain callable methods. An own toString shadows the
        // host Object prototype and makes ordinary String conversion fail there too.
        if (apply(own, item, ['toString'])) throw new ErrorClass('Cannot convert object to primitive value')
        return '[object Object]'
      }
      let output = ''
      for (let index = 0; index < item.length; index++) {
        if (index) output += ','
        if (item[index] !== null) output += dumpText(item[index], depth + 1)
        boundedText(output)
      }
      return output
    }
    return dumpText(dumped, 0)
  }
  const serialize = state => {
    const seen = new SetClass()
    let count = 0
    const clone = (value, depth) => {
      if (++count > ${MAX_VALUES} || depth > ${MAX_DEPTH}) fail()
      if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
      if (typeof value === 'number') { if (!finite(value)) fail(); return value }
      if (typeof value !== 'object') fail()
      if (apply(setHas, seen, [value])) fail()
      apply(setAdd, seen, [value])
      const array = isArray(value)
      const proto = prototype(value)
      if (array ? proto !== arrayPrototype && proto !== null : proto !== objectPrototype && proto !== null) fail()
      const output = array ? [] : create(null)
      if (array) setPrototype(output, null)
      const keys = ownKeys(value)
      let length = 0
      if (array) {
        const lengthDescriptor = descriptor(value, 'length')
        length = lengthDescriptor.value
        if (!integer(length) || length < 0 || length > ${MAX_VALUES}) fail()
        if (keys.length !== length + 1) fail() // Reject sparse arrays and extra properties.
      }
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]
        if (array && key === 'length') continue
        if (typeof key !== 'string') fail()
        if (array && (!integer(+key) || +key < 0 || +key >= length || string(+key) !== key)) fail()
        const entry = descriptor(value, key)
        if (!entry || !apply(own, entry, ['value']) || !entry.enumerable) fail()
        define(output, key, { value: clone(entry.value, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      apply(setDelete, seen, [value])
      return output
    }
    if (state === null || typeof state !== 'object' || isArray(state)) fail()
    const output = stringify(clone(state, 0))
    if (output.length > ${MAX_JSON}) throw new ErrorClass('botState exceeds the playground limit')
    return output
  }
  return {
    text,
    temp: value => {
      let name
      do {
        if (temporaryCounter > ${MAX_VALUES}) throw new ErrorClass('Temporary script bindings exceed the playground limit')
        name = '__playground_bcfd_' + temporaryCounter++
      } while (descriptor(global, name))
      define(global, name, { value, writable: true, enumerable: true, configurable: true })
      return name
    },
    get: name => text(global[name]),
    set: (name, json) => {
      const value = json === undefined ? undefined : parse(json)
      if (name === 'botState') global.botState = value
      else define(global, name, { value, writable: true, enumerable: true, configurable: true })
    },
    remove: name => { if (!delete global[name]) throw new ErrorClass('Cannot delete protected script variable') },
    snapshot: () => serialize(global.botState),
    variables: json => {
      const names = parse(json)
      const values = create(null)
      for (let index = 0; index < names.length; index++) {
        const name = names[index]
        const entry = descriptor(global, name)
        if (!entry) continue
        if (!apply(own, entry, ['value'])) fail()
        if (entry.value === undefined) continue
        define(values, name, { value: entry.value, enumerable: true })
      }
      return serialize(values)
    },
    error: value => {
      if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
        const message = descriptor(value, 'message')
        if (message && typeof message.value === 'string') return message.value.slice(0, 500)
        return 'Script execution failed'
      }
      return string(value).slice(0, 500)
    }
  }
})()`

class OfflineScriptSandbox implements ScriptSandbox {
  private readonly runtime: QuickJSRuntime
  private readonly context: QuickJSContext
  private readonly deadline: number
  private readonly helpers = new Map<string, QuickJSHandle>()
  private disposed = false
  private failed = false

  constructor(
    module: QuickJSWASMModule,
    botState: Record<string, unknown>,
    options: ScriptSandboxOptions = {}
  ) {
    if (options.timeoutMs != null && !Number.isFinite(options.timeoutMs))
      throw new Error('Invalid script timeout')
    if (options.deadline != null && !Number.isFinite(options.deadline))
      throw new Error('Invalid script deadline')
    const timeout = Math.max(0, Math.min(options.timeoutMs ?? LIFETIME_MS, LIFETIME_MS))
    const remaining =
      options.deadline == null ? timeout : Math.min(timeout, options.deadline - Date.now())
    this.deadline = performance.now() + remaining
    this.runtime = module.newRuntime()
    this.runtime.setMemoryLimit(MEMORY_BYTES)
    this.runtime.setMaxStackSize(STACK_BYTES)
    // Never remove this handler, including during getters, conversions, error
    // reporting, JSON validation, and serialization. All share one lifetime.
    this.runtime.setInterruptHandler(() => performance.now() >= this.deadline)
    try {
      this.context = this.runtime.newContext()
      this.assertActive()
      const toolkit = this.unwrap(this.context.evalCode(BOOTSTRAP, 'playground-bootstrap.js'))
      try {
        for (const name of [
          'text',
          'temp',
          'get',
          'set',
          'remove',
          'snapshot',
          'variables',
          'error'
        ]) {
          this.helpers.set(name, this.context.getProp(toolkit, name))
        }
      } finally {
        toolkit.dispose()
      }
      this.set('botState', botState)
      this.state()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  set(name: string, value: unknown): void {
    this.guard(() => {
      this.checkName(name)
      const json = value === undefined ? undefined : hostJson(value)
      const nameHandle = this.context.newString(name)
      let valueHandle = this.context.undefined
      try {
        valueHandle = json === undefined ? this.context.undefined : this.context.newString(json)
        this.call('set', [nameHandle, valueHandle]).dispose()
      } finally {
        nameHandle.dispose()
        if (valueHandle !== this.context.undefined) valueHandle.dispose()
      }
    })
  }

  temp(value: string): string {
    return this.guard(() => {
      if (typeof value !== 'string' || value.length > MAX_STRING)
        throw new Error('Temporary script value exceeds the playground limit')
      const input = this.context.newString(value)
      try {
        const name = this.call('temp', [input])
        try {
          return this.context.getString(name)
        } finally {
          name.dispose()
        }
      } finally {
        input.dispose()
      }
    })
  }

  get(name: string): string {
    return this.guard(() => this.withName('get', name))
  }

  delete(name: string): void {
    this.guard(() => {
      this.withName('remove', name)
    })
  }

  evaluate(code: string, options: { wrapReturn?: boolean } = {}): string {
    return this.guard(() => {
      if (typeof code !== 'string' || code.length > 65_536)
        throw new Error('Script exceeds the playground limit')
      const wrapped = options.wrapReturn !== false
      const value = this.unwrap(
        this.context.evalCode(
          wrapped ? `(function() {\n${code}\n})()` : code,
          'playground-eval.js',
          { type: 'global' }
        )
      )
      try {
        if (!wrapped) return ''
        const text = this.call('text', [value])
        try {
          return this.context.getString(text)
        } finally {
          text.dispose()
        }
      } finally {
        value.dispose()
      }
    })
  }

  state(): Record<string, unknown> {
    return this.guard(() => {
      const snapshot = this.call('snapshot')
      try {
        return JSON.parse(this.context.getString(snapshot))
      } finally {
        snapshot.dispose()
      }
    })
  }

  variables(names: string[]): Record<string, unknown> {
    return this.guard(() => {
      const input = this.context.newString(hostJson(names))
      try {
        const snapshot = this.call('variables', [input])
        try {
          return JSON.parse(this.context.getString(snapshot))
        } finally {
          snapshot.dispose()
        }
      } finally {
        input.dispose()
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const handle of this.helpers.values()) handle.dispose()
    this.helpers.clear()
    this.context?.dispose()
    this.runtime.dispose()
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Script sandbox is disposed')
    if (this.failed) throw new Error('Script sandbox failed; discard this command')
    if (performance.now() >= this.deadline) throw new Error('Script execution time limit exceeded')
  }

  private guard<T>(operation: () => T): T {
    try {
      this.assertActive()
      const result = operation()
      this.assertActive()
      return result
    } catch (error) {
      this.failed = true
      throw error
    }
  }

  private withName(method: string, name: string): string {
    this.checkName(name)
    const handle = this.context.newString(name)
    try {
      const result = this.call(method, [handle])
      try {
        return method === 'get' ? this.context.getString(result) : ''
      } finally {
        result.dispose()
      }
    } finally {
      handle.dispose()
    }
  }

  private checkName(name: string): void {
    if (typeof name !== 'string' || name.length > MAX_STRING)
      throw new Error('Script variable name exceeds the playground limit')
  }

  private call(method: string, args: QuickJSHandle[] = []): QuickJSHandle {
    return this.unwrap(
      this.context.callFunction(this.helpers.get(method)!, this.context.undefined, args)
    )
  }

  private unwrap(result: ReturnType<QuickJSContext['evalCode']>): QuickJSHandle {
    if (result.error) {
      let message =
        performance.now() >= this.deadline
          ? 'Script execution time limit exceeded'
          : 'Script execution failed'
      try {
        const formatter = this.helpers.get('error')
        if (formatter && performance.now() < this.deadline) {
          const converted = this.context.callFunction(
            formatter,
            this.context.undefined,
            result.error
          )
          if (converted.error) converted.error.dispose()
          else {
            try {
              message = this.context.getString(converted.value)
            } finally {
              converted.value.dispose()
            }
          }
        }
      } finally {
        result.error.dispose()
      }
      throw new Error(message)
    }
    return result.value
  }
}

/**
 * Host inputs are structured-cloned JSON data from the worker message, never live
 * host objects/proxies. Inspect descriptors so even accidental accessors/toJSON
 * callbacks are rejected rather than invoked by the host JSON serializer.
 */
function hostJson(value: unknown): string {
  const seen = new Set<object>()
  let count = 0
  const clone = (input: unknown, depth: number): unknown => {
    const invalid = () => {
      throw new Error('Script inputs must contain only plain JSON data')
    }
    if (++count > MAX_VALUES || depth > MAX_DEPTH) return invalid()
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number') return Number.isFinite(input) ? input : invalid()
    if (typeof input !== 'object') return invalid()
    if (seen.has(input)) return invalid()
    seen.add(input)
    const array = Array.isArray(input)
    const proto = Object.getPrototypeOf(input)
    if (
      array
        ? proto !== Array.prototype && proto !== null
        : proto !== Object.prototype && proto !== null
    )
      return invalid()
    const descriptors = Object.getOwnPropertyDescriptors(input)
    const keys = Reflect.ownKeys(descriptors)
    const output: unknown[] | Record<string, unknown> = array ? [] : Object.create(null)
    if (array) Object.setPrototypeOf(output, null)
    const length = array ? (descriptors.length.value as number) : 0
    if (array && keys.length !== length + 1) return invalid()
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string') return invalid()
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || +key >= length)) return invalid()
      const entry = descriptors[key]
      if (!('value' in entry) || !entry.enumerable) return invalid()
      Object.defineProperty(output, key, { value: clone(entry.value, depth + 1), enumerable: true })
    }
    seen.delete(input)
    return output
  }
  const json = JSON.stringify(clone(value, 0))
  if (json.length > MAX_JSON) throw new Error('Script input exceeds the playground limit')
  return json
}
