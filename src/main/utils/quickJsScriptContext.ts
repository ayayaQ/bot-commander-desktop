import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
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

export interface ScriptContext {
  getVariable(name: string): unknown
  setVariable(name: string, value: unknown): void
  deleteVariable(name: string): void
  getVariableNames(): string[]
  evaluate(code: string, options?: ScriptExecutionOptions): unknown
  run(code: string, options?: ScriptExecutionOptions): void
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
  const scriptContext = new QuickJSScriptContext(runtime, context)

  if (options.debug) {
    scriptContext.exposeDebug(options.debug)
  }

  for (const [name, value] of Object.entries(options.initialContext ?? {})) {
    scriptContext.setVariable(name, value)
  }

  return scriptContext
}

export class QuickJSScriptContext implements ScriptContext {
  constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext
  ) {}

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
    if (value === undefined) {
      this.runHostCode(`globalThis[${JSON.stringify(name)}] = undefined`)
      return
    }

    const code = `globalThis[${JSON.stringify(name)}] = JSON.parse(${JSON.stringify(
      JSON.stringify(value)
    )})`
    this.runHostCode(code)
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

  dispose(): void {
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
