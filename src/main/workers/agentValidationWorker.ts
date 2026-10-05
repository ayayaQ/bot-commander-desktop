import { parentPort, workerData } from 'node:worker_threads'
import type { AgentValidationRequest } from '../../shared/agentValidationTypes'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import { runAgentValidation } from '../../shared/playground/agentValidation'
import { loadScriptSandboxFactory } from '../../shared/playground/script'
import { PLAYGROUND_LIMITS } from '../../shared/playground/types'

// Trusted worker bootstrap only. User JavaScript runs inside QuickJS and receives
// no Node/Electron objects, module loader, callbacks, credentials or network access.
for (const name of [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'Worker',
  'SharedWorker'
]) {
  Object.defineProperty(globalThis, name, {
    value: function () {
      throw new Error(`Network and host workers are disabled in agent validation: ${name}`)
    },
    writable: false,
    configurable: false
  })
}
// Select the offline browser path in the Emscripten loader. Its Node path is also
// removed at build time. The only WASM input is the bundled inline data URL.
Object.defineProperty(globalThis, 'WorkerGlobalScope', {
  value: class WorkerGlobalScope {},
  writable: false,
  configurable: false
})

async function main(): Promise<void> {
  const { requestId, request } = workerData as {
    requestId: string
    request: AgentValidationRequest
  }
  try {
    if (JSON.stringify(request).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Agent validation request exceeds the offline playground limit')
    const factory = await loadScriptSandboxFactory()
    const report = runAgentValidation(request, factory)
    if (JSON.stringify(report).length > PLAYGROUND_LIMITS.requestBytes)
      throw new Error('Agent validation report exceeds the offline playground limit')
    parentPort?.postMessage({ requestId, report })
  } catch (error) {
    parentPort?.postMessage({
      requestId,
      report: createNotRunAgentValidationReport(
        request,
        error instanceof Error ? error.message : 'Agent validation worker failed'
      )
    })
  } finally {
    parentPort?.close()
  }
}

void main()
