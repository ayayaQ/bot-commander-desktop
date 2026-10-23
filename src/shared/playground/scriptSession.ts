import type { PlaygroundState } from './types'
import type { ScriptSandbox, ScriptSandboxFactory } from './script'

/** One VM per case/session; functions and global bindings never cross a JSON boundary. */
export function createScriptSession(factory: ScriptSandboxFactory, startupSource = '') {
  let sandbox: ScriptSandbox | undefined
  let lastState: string | undefined
  let lastVariables: string | undefined
  let initialVariables: Record<string, unknown> = {}
  let environment = { time: 0, seed: 1 }
  const borrowedFactory: ScriptSandboxFactory = (state, options) => {
    if (!sandbox) {
      sandbox = factory({}, options)
      sandbox.configureEnvironment?.(environment.time, environment.seed)
      try {
        if (startupSource.trim()) sandbox.evaluate(startupSource, { wrapReturn: false })
        sandbox.set('botState', state)
        for (const [name, value] of Object.entries(initialVariables)) sandbox.set(name, value)
      } catch (error) {
        sandbox.dispose()
        sandbox = undefined
        throw error
      }
    } else if (JSON.stringify(state) !== lastState) sandbox.set('botState', state)
    lastState = JSON.stringify(state)
    const current = sandbox
    return {
      set: (name, value) => current.set(name, value),
      persistent: true,
      get: (name) => current.get(name),
      temp: (value) => current.temp(value),
      delete: (name) => current.delete(name),
      evaluate: (code, options) => current.evaluate(code, options),
      configureEnvironment: (time, seed) => current.configureEnvironment?.(time, seed),
      randomState: () => current.randomState?.() ?? 1,
      checkpoint: () => current.checkpoint(),
      state: () => {
        const value = current.state()
        lastState = JSON.stringify(value)
        return value
      },
      variables: (names) => {
        const values = current.variables(names)
        lastVariables = JSON.stringify(values)
        return values
      },
      dispose() {}
    }
  }
  return {
    factory: borrowedFactory,
    beginStep(state?: PlaygroundState) {
      sandbox?.beginStep?.()
      if (state) {
        initialVariables = state.variables
        environment = { time: state.clockMs, seed: state.randomSeed ?? 1 }
        if (!sandbox && startupSource.trim()) {
          const current = borrowedFactory(state.botState)
          state.randomSeed = current.randomState?.() ?? environment.seed
        }
        if (sandbox && JSON.stringify(state.variables) !== lastVariables) {
          for (const [name, value] of Object.entries(state.variables)) sandbox.set(name, value)
        }
        lastVariables = JSON.stringify(state.variables)
        sandbox?.configureEnvironment?.(state.clockMs, state.randomSeed ?? 1)
      }
    },
    dispose() {
      sandbox?.dispose()
      sandbox = undefined
    }
  }
}
