import { IncompleteSimulationError } from '../runtime/errors'
import type { ScriptSandbox, ScriptSandboxFactory } from './script'
import type { TemplateContext } from './template'
import { validateBotState } from './sessionState'

/** Borrow a case VM; commit bot state after each successful template. */
export function executionContext(base: TemplateContext, factory?: ScriptSandboxFactory) {
  let script: ScriptSandbox | undefined
  const names = new Set(Object.keys(base.state.variables))
  const getScript = () => {
    if (!factory) return undefined
    if (!script) {
      script = factory(base.state.botState)
      if (!script.persistent)
        for (const [name, value] of Object.entries(base.state.variables)) script.set(name, value)
    }
    return script
  }
  const context: TemplateContext = {
    ...base,
    get script() {
      return getScript()
    },
    setVariable(name, value) {
      const vm = getScript()
      if (!vm) throw new IncompleteSimulationError('Script sandbox is unavailable')
      vm.set(name, value)
      if (name !== 'botState') names.add(name)
    }
  }
  const scope = {
    context,
    commit() {
      if (!script) return
      const state = script.state()
      validateBotState(state)
      let variables: Record<string, unknown>
      try {
        variables = script.variables([...names])
      } catch (error) {
        throw new IncompleteSimulationError(
          `Cannot snapshot script variables: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      validateBotState(variables)
      base.state.botState = state
      base.state.variables = variables
    },
    dispose() {
      script?.dispose()
    }
  }
  context.commitTemplate = () => scope.commit()
  return scope
}
