import { runPlaygroundSimulation } from '../../../shared/playgroundEngine'
import type { PlaygroundRequest } from '../../../shared/playground'

// No user JavaScript runs here. Inputs are data, and the only evaluator is the
// explicit offline allowlist. A fresh worker is created and terminated per run.
self.onmessage = (event: MessageEvent<PlaygroundRequest>) => {
  try {
    self.postMessage({ result: runPlaygroundSimulation(event.data) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
