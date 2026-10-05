import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import type {
  AgentValidationReport,
  AgentValidationRequest
} from '../../shared/agentValidationTypes'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'

export const AGENT_VALIDATION_WORKER_FILENAME = 'agentValidationWorker.mjs'
export const AGENT_VALIDATION_MAX_TIMEOUT_MS = 20_000
export const AGENT_VALIDATION_WORKER_RESOURCE_LIMITS = {
  maxOldGenerationSizeMb: 64,
  maxYoungGenerationSizeMb: 8,
  codeRangeSizeMb: 4,
  stackSizeMb: 4
} as const

export type AgentValidationWorker = Pick<Worker, 'on' | 'off' | 'terminate'>
export type AgentValidationWorkerFactory = (
  entry: URL,
  options: WorkerOptions
) => AgentValidationWorker
export type AgentValidationServiceOptions = {
  workerFactory?: AgentValidationWorkerFactory
  /** Tests can point at a freshly built production entry without loading Electron. */
  workerEntry?: URL
  /** May shorten the outer lifetime for tests, but can never extend the policy cap. */
  timeoutMs?: number
}

/** The standalone worker is unpacked so Node ESM loading never depends on ASAR hooks. */
export function agentValidationWorkerEntry(directory: string = __dirname): URL {
  const workerDirectory = directory.replace(/([\\/])app\.asar([\\/]|$)/, '$1app.asar.unpacked$2')
  return pathToFileURL(join(workerDirectory, AGENT_VALIDATION_WORKER_FILENAME))
}

export function agentValidationTimeoutMs(input: AgentValidationRequest): number {
  const steps = input.suite.cases.reduce((total, testCase) => total + testCase.steps.length, 0)
  return Math.min(AGENT_VALIDATION_MAX_TIMEOUT_MS, Math.max(1500, steps * 1500 + 1000))
}

/**
 * This bridge accepts only prepared snapshots. It has no persistence, settings,
 * provider, Discord, webhook, startup-script or renderer IPC dependency. One suite
 * gets one disposable worker; no user evaluator is ever called on the main thread.
 */
export function createAgentValidationService(options: AgentValidationServiceOptions = {}) {
  const factory =
    options.workerFactory ?? ((entry, workerOptions) => new Worker(entry, workerOptions))
  return async function validatePreparedResource(
    input: AgentValidationRequest,
    signal?: AbortSignal
  ): Promise<AgentValidationReport> {
    if (signal?.aborted)
      return createNotRunAgentValidationReport(input, 'Agent validation cancelled', {
        cancelled: true
      })
    // Freeze the lifecycle's fallback metadata and fixtures at launch. WorkerData
    // performs another structured clone across the thread boundary.
    try {
      input = structuredClone(input)
    } catch (error) {
      return createNotRunAgentValidationReport(
        input,
        error instanceof Error ? error.message : 'Agent validation snapshot could not be cloned'
      )
    }
    const requestId = randomUUID()
    let worker: AgentValidationWorker
    try {
      worker = factory(options.workerEntry ?? agentValidationWorkerEntry(), {
        workerData: { requestId, request: input },
        // Do not pass main-process secrets, preload scripts or debugging arguments.
        env: {},
        execArgv: [],
        resourceLimits: { ...AGENT_VALIDATION_WORKER_RESOURCE_LIMITS }
      })
    } catch (error) {
      return createNotRunAgentValidationReport(
        input,
        error instanceof Error ? error.message : 'Agent validation worker could not start'
      )
    }

    return new Promise((resolveReport) => {
      let settled = false
      const finish = (report: AgentValidationReport) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        worker.off('message', onMessage)
        // Keep the error listener installed until termination drains queued worker
        // events. Removing it here can turn an already queued error into an uncaught
        // main-process exception during an abort, timeout or successful reply.
        // Terminate before releasing the result, even after errors or successful exit.
        void worker
          .terminate()
          .catch(() => undefined)
          .finally(() => {
            worker.off('error', onError)
            worker.off('exit', onExit)
            resolveReport(report)
          })
      }
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object') return
        const reply = value as { requestId?: string; report?: AgentValidationReport }
        // A late response from another request can never become this suite's result.
        if (reply.requestId !== requestId) return
        if (
          !reply.report ||
          reply.report.version !== 1 ||
          reply.report.candidateKind !== input.candidateKind ||
          reply.report.candidateId !== input.candidate.id ||
          reply.report.candidateHash !== input.candidateHash ||
          reply.report.baseRevision !== input.baseRevision ||
          reply.report.fixtureHash !== input.fixtureHash ||
          typeof reply.report.wrapEvalInIIFE !== 'boolean' ||
          reply.report.wrapEvalInIIFE !== input.wrapEvalInIIFE ||
          !Array.isArray(reply.report.cases) ||
          !reply.report.coverage ||
          !['passed', 'failed', 'blocked', 'unmatched', 'unsupported', 'not_run'].includes(
            reply.report.outcome
          ) ||
          (reply.report.outcome === 'passed' && !(reply.report.coverage.executed > 0))
        ) {
          finish(
            createNotRunAgentValidationReport(
              input,
              'Agent validation worker returned an invalid report'
            )
          )
          return
        }
        finish(reply.report)
      }
      const onError = (error: Error) => {
        if (settled) return
        finish(createNotRunAgentValidationReport(input, error.message))
      }
      const onExit = (code: number) => {
        if (settled) return
        finish(
          createNotRunAgentValidationReport(
            input,
            `Agent validation worker exited before returning a report (${code})`
          )
        )
      }
      const onAbort = () => {
        finish(
          createNotRunAgentValidationReport(input, 'Agent validation cancelled', {
            cancelled: true
          })
        )
      }
      const configuredTimeout = options.timeoutMs ?? agentValidationTimeoutMs(input)
      const timeout = setTimeout(
        () =>
          finish(
            createNotRunAgentValidationReport(input, 'Agent validation time limit exceeded', {
              timedOut: true
            })
          ),
        Math.max(1, Math.min(AGENT_VALIDATION_MAX_TIMEOUT_MS, configuredTimeout))
      )
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Handle a signal aborted during worker construction before listener installation.
      if (signal?.aborted) onAbort()
    })
  }
}

export const validatePreparedResource = createAgentValidationService()
