import { createScriptSession } from '../../../shared/playground/scriptSession'
import { runAgentValidation } from '../../../shared/playground/agentValidation'
import type { AgentValidationRequest } from '../../../shared/agentValidationTypes'
import { runInteraction } from '../../../shared/playground/interactions'
import { runMessage } from '../../../shared/playground/engine'
import { PLAYGROUND_LIMITS } from '../../../shared/playground/types'
import type { PlaygroundRequest } from '../../../shared/playground/types'
import { loadScriptSandboxFactory } from '../../../shared/playground/script'
import { playgroundFeedback } from './playgroundControls'

// Disposable offline worker. JavaScript executes only in the locally bundled QuickJS VM.
let busy = false
let scriptSession: ReturnType<typeof createScriptSession> | undefined
let startupSource: string | undefined
self.onmessage = async (
  event: MessageEvent<PlaygroundRequest | { kind: 'validation'; request: AgentValidationRequest }>
) => {
  if (busy) return
  busy = true
  try {
    if (JSON.stringify(event.data).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Playground request is too large')
    const request = event.data
    const createSandbox = await loadScriptSandboxFactory()
    if (request.kind === 'validation') {
      const report = await runAgentValidation(request.request, createSandbox)
      self.postMessage({ report })
      return
    }
    if (!scriptSession || startupSource !== request.state.startupSource) {
      scriptSession?.dispose()
      startupSource = request.state.startupSource
      scriptSession = createScriptSession(createSandbox, startupSource)
    }
    scriptSession.beginStep(request.state)
    const factory = scriptSession.factory
    const result =
      'content' in request
        ? await runMessage(request, factory)
        : await runInteraction(request, factory)
    // Keep the small UI notices while omitting full candidate-validation coverage.
    // The complete response, including feedback, still uses the existing byte limit.
    result.feedback = playgroundFeedback(result)
    delete result.resources
    if (JSON.stringify(result).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Playground result is too large; reset the playground')
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Playground execution failed'
    })
  } finally {
    busy = false
  }
}
