import { runInteraction } from '../../../shared/playground/interactions'
import { runMessage } from '../../../shared/playground/engine'
import { PLAYGROUND_LIMITS } from '../../../shared/playground/types'
import type { PlaygroundRequest } from '../../../shared/playground/types'
import { loadScriptSandboxFactory } from '../../../shared/playground/script'

// Disposable offline worker. JavaScript executes only in the locally bundled QuickJS VM.
let busy = false
self.onmessage = async (event: MessageEvent<PlaygroundRequest>) => {
  if (busy) return
  busy = true
  try {
    if (JSON.stringify(event.data).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Playground request is too large')
    const request = event.data
    const createSandbox = await loadScriptSandboxFactory()
    // One deadline includes scripts, global reads, result conversion and state extraction.
    const deadline = Date.now() + 1000
    const factory = (state: Record<string, unknown>) => createSandbox(state, { deadline })
    const result =
      'commands' in request ? runMessage(request, factory) : runInteraction(request, factory)
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
