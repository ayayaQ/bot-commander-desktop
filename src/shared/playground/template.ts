import { commitsTemplate, IncompleteSimulationError } from '../runtime/errors'
import { markIncomplete, recordFailure } from './failures'
import { Interpreter } from '../runtime/evaluator'
import { createFakeRuntime } from './runtimeContext'
import { PLAYGROUND_LIMITS } from './types'
import type { FakeMember, PlaygroundState } from './types'
import type { ScriptSandbox } from './script'
import type { CooldownCommand } from './sessionState'

export type TemplateContext = {
  state: PlaygroundState
  sender: FakeMember
  mentioned?: FakeMember
  content: string
  event?: import('../runtime/dispatch').CommandEvent
  trigger: string
  options?: Record<string, string | number | boolean>
  script?: ScriptSandbox
  wrapEvalInIIFE?: boolean
  setVariable?: (name: string, value: string) => void
  command?: CooldownCommand
  trace?: string[]
  commitTemplate?: () => void
  diagnostics?: string[]
}

/** Production language semantics, with a strictly local capability adapter. */
const queues = new WeakMap<TemplateContext, Promise<unknown>>()
export function evaluateTemplate(source: string, ctx: TemplateContext): Promise<string> {
  const result = (queues.get(ctx) ?? Promise.resolve()).then(
    () => evaluate(source, ctx),
    () => evaluate(source, ctx)
  )
  queues.set(ctx, result)
  return result
}
async function evaluate(source: string, ctx: TemplateContext): Promise<string> {
  if (typeof source !== 'string' || source.length > PLAYGROUND_LIMITS.template)
    throw new IncompleteSimulationError('Template exceeds the playground limit')
  const script = ctx.script
  const checkpoint = script?.checkpoint()
  let restored = false
  const restore = () => {
    restored = true
    checkpoint?.restore()
  }
  try {
    const { context, registry } = createFakeRuntime(ctx)
    const result = await new Interpreter(registry, PLAYGROUND_LIMITS).interpret(source, context)
    for (const error of result.errors) {
      ctx.trace?.push(`Inline diagnostic: ${error.message}`)
      ctx.diagnostics?.push(error.message)
    }
    if (!commitsTemplate(result)) restore()
    ctx.commitTemplate?.()
    return result.output
  } catch (error) {
    recordFailure(ctx.state, error)
    if (!restored) {
      try {
        restore()
        ctx.commitTemplate?.()
      } catch (rollbackError) {
        markIncomplete(
          ctx.state,
          rollbackError instanceof Error ? rollbackError.message : 'State rollback failed'
        )
        throw rollbackError
      }
    }
    throw error
  } finally {
    checkpoint?.dispose()
  }
}
