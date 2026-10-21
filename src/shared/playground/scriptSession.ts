import type { PlaygroundState } from './types'
import type { ScriptSandbox, ScriptSandboxFactory } from './script'

/** One VM per case/session; functions and global bindings never cross a JSON boundary. */
export function createScriptSession(factory: ScriptSandboxFactory, startupSource = '') {
  let sandbox: ScriptSandbox | undefined
  let environment = { time: 0, seed: 1 }
  const borrowedFactory: ScriptSandboxFactory = (state, options) => {
    if (!sandbox) {
      sandbox = factory({}, options)
      sandbox.configureEnvironment?.(environment.time, environment.seed)
      try {
        if (startupSource.trim()) sandbox.evaluate(startupSource, { wrapReturn: false })
        sandbox.set('botState', state)
      } catch (error) {
        sandbox.dispose()
        sandbox = undefined
        throw error
      }
    } else sandbox.set('botState', state)
    const current = sandbox
    return {
      set: (name, value) => current.set(name, value),
      get: (name) => current.get(name),
      temp: (value) => current.temp(value),
      delete: (name) => current.delete(name),
      evaluate: (code, options) => current.evaluate(code, options),
      configureEnvironment: (time, seed) => current.configureEnvironment?.(time, seed),
      randomState: () => current.randomState?.() ?? 1,
      state: () => current.state(),
      variables: (names) => current.variables(names),
      dispose() {}
    }
  }
  return {
    factory: borrowedFactory,
    beginStep(state?: PlaygroundState) {
      sandbox?.beginStep?.()
      if (state) {
        environment = { time: state.clockMs, seed: state.randomSeed ?? 1 }
        if (!sandbox && startupSource.trim()) {
          const current = borrowedFactory(state.botState)
          state.randomSeed = current.randomState?.() ?? environment.seed
        }
        sandbox?.configureEnvironment?.(state.clockMs, state.randomSeed ?? 1)
      }
    },
    dispose() {
      sandbox?.dispose()
      sandbox = undefined
    }
  }
}
