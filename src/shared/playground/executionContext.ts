import type { ScriptSandbox, ScriptSandboxFactory } from './script'
import type { TemplateContext } from './template'
import { validateBotState } from './sessionState'

/** One VM per command/action. A failed command discards both VM and cloned fixture. */
export function executionContext(base: TemplateContext, factory?: ScriptSandboxFactory) {
  let script: ScriptSandbox | undefined
  const names = new Set(Object.keys(base.state.variables))
  const getScript = () => {
    if (!factory) return undefined
    if (!script) {
      script = factory(base.state.botState)
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
      if (!vm) throw new Error('Script sandbox is unavailable')
      vm.set(name, value)
      if (name !== 'botState') names.add(name)
    }
  }
  return {
    context,
    commit() {
      if (!script) return
      const state = script.state()
      validateBotState(state)
      base.state.botState = state
      const variables = script.variables([...names])
      validateBotState(variables)
      base.state.variables = variables
    },
    dispose() {
      script?.dispose()
    }
  }
}
