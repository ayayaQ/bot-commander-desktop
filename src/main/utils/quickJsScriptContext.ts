import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime
} from 'quickjs-emscripten'

export interface ScriptExecutionOptions {
  timeoutMs?: number
  wrapReturn?: boolean
}

export interface ScriptExecutionErrorDetails {
  name?: string
  message: string
  stack?: string
  fileName?: string
  lineNumber?: number
  columnNumber?: number
}

export class ScriptExecutionError extends Error {
  constructor(readonly details: ScriptExecutionErrorDetails) {
    super(formatScriptExecutionError(details))
    this.name = details.name ?? 'ScriptExecutionError'
  }
}

export interface ScriptVariableCheckpoint {
  restore(): void
  dispose(): void
}

export interface ScriptContext {
  getVariable(name: string): unknown
  setVariable(name: string, value: unknown): void
  deleteVariable(name: string): void
  getVariableNames(): string[]
  evaluate(code: string, options?: ScriptExecutionOptions): unknown
  run(code: string, options?: ScriptExecutionOptions): void
  checkpointVariable?(name: string): ScriptVariableCheckpoint
  serializeVariable?(name: string): string
  dispose(): void
}

export interface QuickJSScriptContextOptions {
  initialContext?: Record<string, unknown>
  memoryLimitBytes?: number
  maxStackSizeBytes?: number
  debug?: (msg: unknown, level?: 'info' | 'error' | 'warning' | 'success') => void
}

const DEFAULT_MEMORY_LIMIT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_STACK_SIZE_BYTES = 512 * 1024
const DEFAULT_TIMEOUT_MS = 1000

export async function createQuickJSScriptContext(
  options: QuickJSScriptContextOptions = {}
): Promise<QuickJSScriptContext> {
  const QuickJS = await getQuickJS()
  const runtime = QuickJS.newRuntime()
  runtime.setMemoryLimit(options.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT_BYTES)
  runtime.setMaxStackSize(options.maxStackSizeBytes ?? DEFAULT_MAX_STACK_SIZE_BYTES)

  const context = runtime.newContext()
  let scriptContext: QuickJSScriptContext | undefined
  try {
    scriptContext = new QuickJSScriptContext(runtime, context)
    if (options.debug) scriptContext.exposeDebug(options.debug)
    for (const [name, value] of Object.entries(options.initialContext ?? {})) {
      scriptContext.setVariable(name, value)
    }
    return scriptContext
  } catch (error) {
    if (scriptContext) scriptContext.dispose()
    else {
      context.dispose()
      runtime.dispose()
    }
    throw error
  }
}

export class QuickJSScriptContext implements ScriptContext {
  private readonly checkpointFactory: QuickJSHandle
  private readonly serializeVariableFunction: QuickJSHandle
  private readonly assignVariableFunction: QuickJSHandle

  constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext
  ) {
    // Track guest-created proxies before guest code can obtain an untracked constructor.
    // Proxies remain usable outside botState; their traps are not a safe checkpoint contract.
    const proxyTracker = context.evalCode(
      `(function () {
      const NativeProxy = Proxy
      const nativeRevocable = Proxy.revocable
      const define = Object.defineProperty
      const TypeErrorClass = TypeError
      const proxies = new WeakSet()
      const add = Function.prototype.call.bind(WeakSet.prototype.add)
      const has = Function.prototype.call.bind(WeakSet.prototype.has)
      const GuestProxy = function Proxy(target, handler) {
        if (!new.target) throw new TypeErrorClass('Proxy requires new')
        const proxy = new NativeProxy(target, handler)
        add(proxies, proxy)
        return proxy
      }
      define(GuestProxy, 'prototype', { value: undefined })
      define(GuestProxy, 'revocable', {
        value: function revocable(target, handler) {
          const result = nativeRevocable(target, handler)
          add(proxies, result.proxy)
          return result
        }, writable: true, configurable: true
      })
      globalThis.Proxy = GuestProxy
      return function (value) { return has(proxies, value) }
    })()`,
      'bcfd-host.js'
    )
    if (proxyTracker.error) {
      const error = this.createScriptExecutionError(proxyTracker.error)
      proxyTracker.error.dispose()
      throw error
    }
    // This temporary reference is deleted before any guest startup/initial-context code runs.
    context.setProp(context.global, '__bcfd_private_proxy_check__', proxyTracker.value)
    proxyTracker.value.dispose()
    // Capture pristine helpers before user scripts can replace globals. A checkpoint keeps
    // original objects alive and restores them in place, including references held by aliases.
    const result = context.evalCode(
      `(function () {
      const isProxy = globalThis.__bcfd_private_proxy_check__
      const descriptors = Object.getOwnPropertyDescriptors
      const keys = Reflect.ownKeys
      const define = Object.defineProperty
      const remove = Reflect.deleteProperty
      const getOwn = Object.getOwnPropertyDescriptor
      const getPrototype = Object.getPrototypeOf
      const setPrototype = Object.setPrototypeOf
      const owns = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
      const global = globalThis
      const SetClass = Set
      const setHas = Function.prototype.call.bind(Set.prototype.has)
      const setAdd = Function.prototype.call.bind(Set.prototype.add)
      return function (name) {
        const original = getOwn(global, name)
        if (!original || !owns(original, 'value')) throw new Error('botState must be an own data property')
        const visited = new SetClass()
        const entries = []
        // Numeric setters on guest prototypes must not swallow checkpoint bookkeeping.
        setPrototype(entries, null)
        function capture(value) {
          if (isProxy(value)) throw new Error('botState contains a Proxy')
          if (value === null || typeof value !== 'object' || setHas(visited, value)) return
          setAdd(visited, value)
          const properties = descriptors(value)
          entries[entries.length] = [value, properties, getPrototype(value)]
          const names = keys(properties)
          for (let i = 0; i < names.length; i++) {
            const key = names[i]
            if (owns(properties[key], 'value')) capture(properties[key].value)
          }
        }
        if (original && owns(original, 'value')) capture(original.value)
        return function () {
          for (let i = 0; i < entries.length; i++) {
            const value = entries[i][0]
            const properties = entries[i][1]
            const originalPrototype = entries[i][2]
            const names = keys(value)
            for (let j = 0; j < names.length; j++) {
              const key = names[j]
              if (!owns(properties, key) && !remove(value, key)) {
                throw new Error('Unable to roll back bot state property')
              }
            }
            const originals = keys(properties)
            for (let j = 0; j < originals.length; j++) {
              const key = originals[j]
              define(value, key, properties[key])
            }
            setPrototype(value, originalPrototype)
          }
          if (original) define(global, name, original)
          else if (!remove(global, name)) throw new Error('Unable to roll back bot state')
        }
      }
    })()`,
      'bcfd-host.js'
    )
    if (result.error) {
      const error = this.createScriptExecutionError(result.error)
      result.error.dispose()
      throw error
    }
    this.checkpointFactory = result.value
    const serializer = context.evalCode(
      `(function () {
      const stringify = JSON.stringify
      const isProxy = globalThis.__bcfd_private_proxy_check__
      const descriptors = Object.getOwnPropertyDescriptors
      const keys = Reflect.ownKeys
      const prototype = Object.getPrototypeOf
      const getOwn = Object.getOwnPropertyDescriptor
      const objectPrototype = Object.prototype
      const isArray = Array.isArray
      const create = Object.create
      const setPrototype = Object.setPrototypeOf
      const define = Object.defineProperty
      const toNumber = Number
      const toString = String
      const integer = Number.isInteger
      const owns = Function.prototype.call.bind(Object.prototype.hasOwnProperty)
      const finite = Number.isFinite
      const SetClass = Set
      const setHas = Function.prototype.call.bind(Set.prototype.has)
      const setAdd = Function.prototype.call.bind(Set.prototype.add)
      const setDelete = Function.prototype.call.bind(Set.prototype.delete)
      const global = globalThis
      return function (name) {
        const original = getOwn(global, name)
        if (!original || !owns(original, 'value')) throw new Error('botState must be an own data property')
        const value = original.value
        if (isProxy(value)) throw new Error('botState contains a Proxy')
        if (value === null || typeof value !== 'object' || isArray(value)) {
          throw new Error('botState must be a JSON object')
        }
        const ancestors = new SetClass()
        function validate(item) {
          if (isProxy(item)) throw new Error('botState contains a Proxy')
          if (item === null || typeof item === 'string' || typeof item === 'boolean') return item
          if (typeof item === 'number' && finite(item)) return item
          if (typeof item !== 'object') throw new Error('botState contains a non-JSON value')
          if (setHas(ancestors, item)) throw new Error('botState contains a circular reference')
          if (!isArray(item) && prototype(item) !== objectPrototype && prototype(item) !== null) {
            throw new Error('botState contains a non-JSON object')
          }
          setAdd(ancestors, item)
          const properties = descriptors(item)
          const copy = isArray(item) ? [] : create(null)
          if (isArray(item)) setPrototype(copy, null)
          const names = keys(properties)
          for (let i = 0; i < names.length; i++) {
            const key = names[i]
            const property = properties[key]
            if (isArray(item) && key === 'length') continue
            if (typeof key !== 'string' || !property.enumerable || !owns(property, 'value')) {
              throw new Error('botState contains a non-JSON property')
            }
            if (isArray(item) && (toString(toNumber(key)) !== key || toNumber(key) < 0 ||
                !integer(toNumber(key)) || toNumber(key) >= item.length)) {
              throw new Error('botState contains an array property that JSON would discard')
            }
            define(copy, key, { value: validate(property.value), enumerable: true, writable: true, configurable: true })
          }
          if (isArray(item)) {
            for (let i = 0; i < item.length; i++) {
              if (!owns(properties, toString(i))) throw new Error('botState contains a sparse array')
            }
          }
          setDelete(ancestors, item)
          return copy
        }
        return stringify(validate(value))
      }
    })()`,
      'bcfd-host.js'
    )
    if (serializer.error) {
      const error = this.createScriptExecutionError(serializer.error)
      serializer.error.dispose()
      this.checkpointFactory.dispose()
      throw error
    }
    this.serializeVariableFunction = serializer.value
    const assign = context.evalCode(
      `(function () {
      const parse = JSON.parse
      const global = globalThis
      return function (name, json) {
        'use strict'
        global[name] = json === undefined ? undefined : parse(json)
      }
    })()`,
      'bcfd-host.js'
    )
    if (assign.error) {
      const error = this.createScriptExecutionError(assign.error)
      assign.error.dispose()
      this.checkpointFactory.dispose()
      this.serializeVariableFunction.dispose()
      throw error
    }
    this.assignVariableFunction = assign.value
    const cleanup = context.evalCode(
      'delete globalThis.__bcfd_private_proxy_check__',
      'bcfd-host.js'
    )
    if (cleanup.error) {
      const error = this.createScriptExecutionError(cleanup.error)
      cleanup.error.dispose()
      this.checkpointFactory.dispose()
      this.serializeVariableFunction.dispose()
      this.assignVariableFunction.dispose()
      throw error
    }
    cleanup.value.dispose()
  }

  exposeDebug(
    debug: (msg: unknown, level?: 'info' | 'error' | 'warning' | 'success') => void
  ): void {
    const debugHandle = this.context.newFunction('debug', (msgHandle, levelHandle) => {
      const message = msgHandle ? this.context.dump(msgHandle) : undefined
      const rawLevel = levelHandle ? this.context.dump(levelHandle) : undefined
      const level = this.isDebugLevel(rawLevel) ? rawLevel : 'info'
      debug(message, level)
      return this.context.undefined
    })

    this.context.setProp(this.context.global, 'debug', debugHandle)
    debugHandle.dispose()
  }

  getVariable(name: string): unknown {
    const handle = this.context.getProp(this.context.global, name)
    try {
      return this.context.dump(handle)
    } finally {
      handle.dispose()
    }
  }

  setVariable(name: string, value: unknown): void {
    const nameHandle = this.context.newString(name)
    const jsonHandle =
      value === undefined ? undefined : this.context.newString(JSON.stringify(value))
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEFAULT_TIMEOUT_MS))
    try {
      const result = this.context.callFunction(
        this.assignVariableFunction,
        this.context.undefined,
        nameHandle,
        jsonHandle ?? this.context.undefined
      )
      if (result.error) {
        const error = this.createScriptExecutionError(result.error)
        result.error.dispose()
        throw error
      }
      result.value.dispose()
    } finally {
      nameHandle.dispose()
      jsonHandle?.dispose()
      this.runtime.removeInterruptHandler()
    }
  }

  deleteVariable(name: string): void {
    const code = `delete globalThis[${JSON.stringify(name)}]`
    this.runHostCode(code)
  }

  getVariableNames(): string[] {
    const result = this.context.getOwnPropertyNames(this.context.global)
    if (result.error) {
      const error = this.createScriptExecutionError(result.error)
      result.error.dispose()
      throw error
    }

    try {
      return result.value.map((handle) => String(this.context.dump(handle)))
    } finally {
      result.value.dispose()
    }
  }

  evaluate(code: string, options: ScriptExecutionOptions = {}): unknown {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const isWrapped = options.wrapReturn !== false
    const source = isWrapped ? `(function() {\n${code}\n})()` : code

    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs))
    try {
      const result = this.context.evalCode(source, 'bcfd-eval.js', { type: 'global' })
      if (result.error) {
        const error = this.createScriptExecutionError(result.error, isWrapped ? 1 : 0, code)
        result.error.dispose()
        throw error
      }

      try {
        return this.context.dump(result.value)
      } finally {
        result.value.dispose()
      }
    } finally {
      this.runtime.removeInterruptHandler()
    }
  }

  run(code: string, options: ScriptExecutionOptions = {}): void {
    this.evaluate(code, options)
  }

  serializeVariable(name: string): string {
    const nameHandle = this.context.newString(name)
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEFAULT_TIMEOUT_MS))
    try {
      const result = this.context.callFunction(
        this.serializeVariableFunction,
        this.context.undefined,
        nameHandle
      )
      if (result.error) {
        const error = this.createScriptExecutionError(result.error)
        result.error.dispose()
        throw error
      }
      try {
        return this.context.getString(result.value)
      } finally {
        result.value.dispose()
      }
    } finally {
      nameHandle.dispose()
      this.runtime.removeInterruptHandler()
    }
  }

  checkpointVariable(name: string): ScriptVariableCheckpoint {
    const nameHandle = this.context.newString(name)
    this.runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + DEFAULT_TIMEOUT_MS))
    let restoreHandle: QuickJSHandle
    try {
      const result = this.context.callFunction(
        this.checkpointFactory,
        this.context.undefined,
        nameHandle
      )
      if (result.error) {
        const error = this.createScriptExecutionError(result.error)
        result.error.dispose()
        throw error
      }
      restoreHandle = result.value
    } finally {
      nameHandle.dispose()
      this.runtime.removeInterruptHandler()
    }
    let disposed = false
    return {
      restore: () => {
        if (disposed) throw new Error('Script checkpoint has already been disposed')
        this.runtime.setInterruptHandler(
          shouldInterruptAfterDeadline(Date.now() + DEFAULT_TIMEOUT_MS)
        )
        try {
          const result = this.context.callFunction(restoreHandle, this.context.undefined)
          if (result.error) {
            const error = this.createScriptExecutionError(result.error)
            result.error.dispose()
            throw error
          }
          result.value.dispose()
        } finally {
          this.runtime.removeInterruptHandler()
        }
      },
      dispose: () => {
        if (!disposed) restoreHandle.dispose()
        disposed = true
      }
    }
  }

  dispose(): void {
    this.checkpointFactory.dispose()
    this.serializeVariableFunction.dispose()
    this.assignVariableFunction.dispose()
    this.context.dispose()
    this.runtime.dispose()
  }

  private runHostCode(code: string): void {
    const result = this.context.evalCode(code, 'bcfd-host.js', { type: 'global' })
    if (result.error) {
      const error = this.createScriptExecutionError(result.error)
      result.error.dispose()
      throw error
    }
    result.value.dispose()
  }

  private createScriptExecutionError(
    errorHandle: Parameters<QuickJSContext['dump']>[0],
    lineOffset = 0,
    sourceCode?: string
  ): ScriptExecutionError {
    const dumped = this.context.dump(errorHandle)
    const details = this.scriptErrorDetails(dumped)
    const stackLocation = this.locationFromStack(details.stack)

    if (details.lineNumber == null && stackLocation?.lineNumber != null) {
      details.lineNumber = stackLocation.lineNumber
    }
    if (details.columnNumber == null && stackLocation?.columnNumber != null) {
      details.columnNumber = stackLocation.columnNumber
    }

    if (lineOffset > 0 && details.lineNumber != null && details.lineNumber > lineOffset) {
      details.lineNumber -= lineOffset
    }

    this.addSourceHint(details, sourceCode)

    return new ScriptExecutionError(details)
  }

  private scriptErrorDetails(error: unknown): ScriptExecutionErrorDetails {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    }

    if (typeof error === 'string') {
      return { message: error }
    }

    if (error && typeof error === 'object') {
      const source = error as Record<string, unknown>
      const message = typeof source.message === 'string' ? source.message : JSON.stringify(source)
      const details: ScriptExecutionErrorDetails = { message }

      if (typeof source.name === 'string') details.name = source.name
      if (typeof source.stack === 'string') details.stack = source.stack
      if (typeof source.fileName === 'string') details.fileName = source.fileName
      if (typeof source.lineNumber === 'number') details.lineNumber = source.lineNumber
      if (typeof source.columnNumber === 'number') details.columnNumber = source.columnNumber

      return details
    }

    return { message: String(error) }
  }

  private locationFromStack(stack?: string): { lineNumber: number; columnNumber: number } | null {
    if (!stack) return null

    const match = stack.match(/bcfd-eval\.js:(\d+):(\d+)/)
    if (!match) return null

    return {
      lineNumber: Number(match[1]),
      columnNumber: Number(match[2])
    }
  }

  private addSourceHint(details: ScriptExecutionErrorDetails, sourceCode?: string): void {
    if (!sourceCode || details.message !== 'not a function' || details.lineNumber == null) return

    const line = sourceCode.split('\n')[details.lineNumber - 1]
    const callee = line ? this.findCalledFunctionName(line) : null
    if (callee) {
      details.message = `"${callee}" is not a function`
    }
  }

  private findCalledFunctionName(line: string): string | null {
    const propertyCalls = [...line.matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)]
    if (propertyCalls.length > 0) {
      return propertyCalls[propertyCalls.length - 1][1]
    }

    const calls = [...line.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
    if (calls.length === 0) return null

    const ignoredKeywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return'])
    for (let i = calls.length - 1; i >= 0; i--) {
      const name = calls[i][1]
      if (!ignoredKeywords.has(name)) {
        return name
      }
    }

    return null
  }

  private isDebugLevel(level: unknown): level is 'info' | 'error' | 'warning' | 'success' {
    return level === 'info' || level === 'error' || level === 'warning' || level === 'success'
  }
}

function formatScriptExecutionError(details: ScriptExecutionErrorDetails): string {
  const name = details.name && details.name !== 'Error' ? `${details.name}: ` : ''
  const location =
    details.lineNumber != null
      ? ` at line ${details.lineNumber}${
          details.columnNumber != null ? `, column ${details.columnNumber}` : ''
        }`
      : ''

  return `${name}${details.message}${location}`
}
