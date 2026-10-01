import { app } from 'electron'
import { join } from 'node:path'
import { parse } from 'acorn'
import { atomicWrite, readWithBackup } from '../services/atomicPersistence'
import { hasResourceMutationAdmission } from '../services/resourceChangeService'
import { rendererConsole } from './rendererConsole'
import {
  createQuickJSScriptContext,
  type ScriptContext,
  type ScriptExecutionOptions
} from './quickJsScriptContext'

let botStateContext: ScriptContext | undefined
let runtimeFailure: Error | undefined
let runtimeWork: Promise<void> = Promise.resolve()
let runtimeStopped = false
const STARTUP_JS_FILENAME = 'startup.js'

type BotState = Record<string, unknown>

export interface BotStateTransactionOptions<T> {
  // Interpreters report evaluation errors as data rather than throwing them.
  shouldCommit?: (result: T) => boolean
  onCommitted?: (state: BotState) => void
}

function debug(msg: unknown, level: 'info' | 'error' | 'warning' | 'success' = 'info') {
  const message = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)
  if (level === 'error') rendererConsole.error(message)
  else if (level === 'warning') rendererConsole.warning(message)
  else if (level === 'success') rendererConsole.success(message)
  else rendererConsole.info(message)
}

function serializeRuntime<T>(action: () => T | Promise<T>): Promise<T> {
  if (runtimeStopped && !hasResourceMutationAdmission())
    return Promise.reject(new Error('The app is shutting down; scripts are paused'))
  const next = runtimeWork.then(action)
  // A rejected save must not poison subsequent work, but its caller still sees the rejection.
  runtimeWork = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

function botStatePath(): string {
  return join(app.getPath('userData'), 'botState.json')
}

function getStartupJsPath(): string {
  return join(app.getPath('userData'), STARTUP_JS_FILENAME)
}

function decodeBotState(data: string): BotState {
  const state: unknown = JSON.parse(data)
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Saved bot state must be a JSON object')
  }
  return state as BotState
}

function encodeState(state: unknown): string {
  const data = JSON.stringify(state)
  if (typeof data !== 'string') throw new Error('Bot state cannot be serialized')
  decodeBotState(data)
  return data
}

function contextSnapshot(context: ScriptContext): string {
  return context.serializeVariable?.('botState') ?? encodeState(context.getVariable('botState'))
}

function decodeStartupJs(js: string): string {
  parse(js, { ecmaVersion: 'latest', sourceType: 'script' })
  return js
}

async function readSavedState(): Promise<BotState> {
  try {
    return await readWithBackup(botStatePath(), decodeBotState)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function getStartupJs(): Promise<string> {
  try {
    return await readWithBackup(getStartupJsPath(), decodeStartupJs)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export async function setStartupJs(js: string): Promise<void> {
  decodeStartupJs(js)
  await atomicWrite(getStartupJsPath(), js, { validate: decodeStartupJs })
}

export async function runStartupJs(context: ScriptContext, source?: string): Promise<void> {
  const js = source ?? (await getStartupJs())
  if (js.trim()) context.run(js, { timeoutMs: 5000, wrapReturn: false })
}

async function prepareContext(source?: string): Promise<ScriptContext> {
  // Do not run any saved script while unrecoverable durable state requires repair.
  const state = await readSavedState()
  const candidate = await createQuickJSScriptContext({ initialContext: { botState: {} }, debug })
  try {
    // Preserve the existing startup semantics: initialize globals, then load durable state.
    await runStartupJs(candidate, source)
    // Validate guest-installed descriptors/proxies before host assignment can invoke a setter.
    contextSnapshot(candidate)
    candidate.setVariable('botState', state)
    contextSnapshot(candidate)
    return candidate
  } catch (error) {
    candidate.dispose()
    throw error
  }
}

function replaceContext(candidate: ScriptContext): void {
  const previous = botStateContext
  botStateContext = candidate
  runtimeFailure = undefined
  // Once a ready context is published, failure to dispose the old one cannot undo the commit.
  try {
    previous?.dispose()
  } catch (error) {
    console.error('Error disposing previous JavaScript context:', error)
  }
}

export function restartJsEngine(): Promise<void> {
  return serializeRuntime(async () => replaceContext(await prepareContext()))
}

export function initializeBotState(): Promise<void> {
  return serializeRuntime(async () => {
    if (botStateContext) {
      replaceContext(await prepareContext())
      return
    }
    try {
      replaceContext(await prepareContext())
    } catch (error) {
      // A saved startup script must not prevent opening the app to repair that script.
      // The fallback still validates durable bot state; corrupt state is never silently reset.
      let fallback: ScriptContext
      try {
        fallback = await prepareContext('')
      } catch (fallbackError) {
        runtimeFailure = new AggregateError(
          [error, fallbackError],
          `The JavaScript runtime could not initialize: ${String(fallbackError)}. Bot-state reads, writes, and scripts are disabled. The saved files were retained. Copy ${botStatePath()} and ${botStatePath()}.bak somewhere safe, repair or restore a valid JSON object, then use Restart JS Engine in the Bot State view. Do not delete the files unless you intend to discard the saved state.`
        )
        throw runtimeFailure
      }
      replaceContext(fallback)
      rendererConsole.error(
        `Startup JavaScript could not run. The saved script was retained for repair, and startup globals are disabled: ${String(error)}`
      )
    }
  })
}

/** Validate the replacement engine before saving startup.js or disposing the active engine. */
export function updateStartupJsAndRestart(js: string): Promise<void> {
  return serializeRuntime(async () => {
    decodeStartupJs(js)
    const candidate = await prepareContext(js)
    try {
      await atomicWrite(getStartupJsPath(), js, { validate: decodeStartupJs })
    } catch (error) {
      candidate.dispose()
      throw error
    }
    replaceContext(candidate)
  })
}

export function loadBotState(shouldApply: () => boolean = () => true): Promise<void> {
  return serializeRuntime(async () => {
    if (!shouldApply()) return
    const state = await readSavedState()
    // A Discord connection may have been replaced while the state file was being read.
    if (!shouldApply()) return
    getBotStateContext().setVariable('botState', state)
  })
}

export function pauseRuntime(): void {
  runtimeStopped = true
}

export function resumeRuntime(): void {
  runtimeStopped = false
}

export function stopRuntimeAndCheckpoint(): Promise<void> {
  runtimeStopped = true
  const next = runtimeWork.then(async () => {
    // Recovery-only startup never admitted scripts or mutations. Preserve its files on quit.
    if (!botStateContext && runtimeFailure) return
    const snapshot = contextSnapshot(getBotStateContext())
    await atomicWrite(botStatePath(), snapshot, { validate: decodeBotState })
  })
  runtimeWork = next.catch(() => undefined)
  return next
}

export function saveBotState(): Promise<void> {
  return serializeRuntime(async () => {
    const snapshot = contextSnapshot(getBotStateContext())
    await atomicWrite(botStatePath(), snapshot, { validate: decodeBotState })
  })
}

/**
 * All scripts using the shared VM must enter this queue before touching it. Holding the queue
 * through persistence prevents a failed older write from rolling back a later successful edit.
 * Callbacks must use the supplied context, not recursively call another queued runtime API.
 */
export function withBotStateTransaction<T>(
  action: (context: ScriptContext) => T | Promise<T>,
  options: BotStateTransactionOptions<T> = {}
): Promise<T> {
  return serializeRuntime(async () => {
    const context = getBotStateContext()
    const before = contextSnapshot(context)
    const checkpoint = context.checkpointVariable?.('botState')
    let rollbackAttempted = false
    const restore = (cause: unknown) => {
      rollbackAttempted = true
      try {
        if (checkpoint) checkpoint.restore()
        else context.setVariable('botState', decodeBotState(before))
      } catch (aliasError) {
        try {
          // Irreversible descriptors/freeze may block in-place restoration. Recover the
          // visible JSON state with the VM's pristine setter, and disclose broken aliases.
          context.setVariable('botState', decodeBotState(before))
        } catch (visibleError) {
          runtimeFailure = new AggregateError(
            [cause, aliasError, visibleError],
            'Bot state rollback failed; restart the JavaScript engine before continuing'
          )
          throw runtimeFailure
        }
        throw new AggregateError(
          [cause, aliasError],
          'Bot state was restored, but JavaScript alias rollback was incomplete; restart the engine'
        )
      }
    }
    try {
      const result = await action(context)
      if (options.shouldCommit && !options.shouldCommit(result)) {
        restore(new Error('Interpreter reported an evaluation error'))
        return result
      }
      // Serialize before awaiting the write, so the checkpoint is a stable immutable snapshot.
      const after = contextSnapshot(context)
      if (after !== before) {
        await atomicWrite(botStatePath(), after, { validate: decodeBotState })
        try {
          options.onCommitted?.(decodeBotState(after))
        } catch (error) {
          // A notification failure cannot roll back a state change already committed to disk.
          console.error('Could not notify committed bot state:', error)
        }
      }
      return result
    } catch (error) {
      if (!rollbackAttempted) restore(error)
      throw error
    } finally {
      checkpoint?.dispose()
    }
  })
}

export function readBotState(): Promise<BotState> {
  return serializeRuntime(() => decodeBotState(contextSnapshot(getBotStateContext())))
}

export function setBotState(state: BotState): Promise<void> {
  // Detach caller-owned data immediately, before it can change while this request is queued.
  const snapshot = encodeState(state)
  return withBotStateTransaction((context) => {
    context.setVariable('botState', decodeBotState(snapshot))
  })
}

export function updateBotState(update: (current: BotState) => BotState): Promise<void> {
  return withBotStateTransaction((context) => {
    const next = update(decodeBotState(contextSnapshot(context)))
    context.setVariable('botState', decodeBotState(encodeState(next)))
  })
}

export function evaluateBotState(code: string, options?: ScriptExecutionOptions): Promise<unknown> {
  return withBotStateTransaction((context) => context.evaluate(code, options))
}

/** Synchronous compatibility access. Mutations must use the queued transaction APIs above. */
export function getBotStateContext(): ScriptContext {
  if (runtimeFailure) throw runtimeFailure
  if (!botStateContext) throw new Error('Bot state JavaScript engine has not been initialized')
  return botStateContext
}
