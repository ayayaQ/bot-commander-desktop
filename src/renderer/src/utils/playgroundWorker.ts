import { runInteraction } from '../../../shared/playground/interactions'
import { runMessage } from '../../../shared/playground/engine'
import { PLAYGROUND_LIMITS } from '../../../shared/playground/types'
import type { PlaygroundRequest } from '../../../shared/playground/types'

// Disposable module worker. User code is data only: no eval, Function, QuickJS or host bridge.
self.onmessage = (event: MessageEvent<PlaygroundRequest>) => {
  try {
    if (JSON.stringify(event.data).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Playground request is too large')
    const request = event.data
    const result = 'commands' in request ? runMessage(request) : runInteraction(request)
    if (JSON.stringify(result).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Playground result is too large; reset the playground')
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Playground execution failed'
    })
  }
}
