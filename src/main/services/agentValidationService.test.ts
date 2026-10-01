import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { WorkerOptions } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import type { AgentValidationRequest } from '../../shared/agentValidationTypes'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import { createPlaygroundState } from '../../shared/playground/types'
import {
  AGENT_VALIDATION_MAX_TIMEOUT_MS,
  AGENT_VALIDATION_WORKER_RESOURCE_LIMITS,
  agentValidationTimeoutMs,
  agentValidationWorkerEntry,
  createAgentValidationService
} from './agentValidationService'
import type { AgentValidationWorker } from './agentValidationService'

function request(): AgentValidationRequest {
  const state = createPlaygroundState()
  return {
    candidateKind: 'command',
    candidate: decodeBCFDCommand({
      id: 'candidate',
      command: '!test',
      commandDescription: 'Offline candidate',
      type: 0,
      channelMessage: 'local',
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {}
    }).command,
    candidateHash: 'candidate-hash',
    baseRevision: 'revision',
    fixtureHash: 'fixture-hash',
    suite: {
      cases: [
        {
          name: 'local response',
          state,
          steps: [
            {
              kind: 'message',
              senderId: state.members[0].id,
              content: '!test',
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/effects/messages/0/content', equals: 'local' }
              ]
            }
          ]
        }
      ]
    }
  }
}

class TestWorker extends EventEmitter {
  terminate = vi.fn(async () => 0)
}

function fixture() {
  const workers: TestWorker[] = []
  const launches: { entry: URL; options: WorkerOptions }[] = []
  const validate = createAgentValidationService({
    timeoutMs: 100,
    workerEntry: pathToFileURL('/test/agentValidationWorker.mjs'),
    workerFactory(entry, options) {
      const worker = new TestWorker()
      workers.push(worker)
      launches.push({ entry, options })
      return worker as unknown as AgentValidationWorker
    }
  })
  const reply = (index: number, report = createNotRunAgentValidationReport(request(), 'test')) => {
    workers[index].emit('message', {
      requestId: launches[index].options.workerData.requestId,
      report
    })
  }
  return { validate, workers, launches, reply }
}

afterEach(() => vi.useRealTimers())

describe('disposable agent validation main bridge (headless)', () => {
  it('maps the main archive path to the explicitly unpacked worker artifact', () => {
    expect(agentValidationWorkerEntry('/resources/app.asar/out/main').href).toBe(
      'file:///resources/app.asar.unpacked/out/main/agentValidationWorker.mjs'
    )
    expect(agentValidationWorkerEntry('/resources/My App/app.asar/out/main').href).toBe(
      'file:///resources/My%20App/app.asar.unpacked/out/main/agentValidationWorker.mjs'
    )
    expect(agentValidationWorkerEntry('/resources/app.asar.unpacked/out/main').href).toBe(
      'file:///resources/app.asar.unpacked/out/main/agentValidationWorker.mjs'
    )
    expect(agentValidationWorkerEntry('/resources/My App/out/main').href).toBe(
      'file:///resources/My%20App/out/main/agentValidationWorker.mjs'
    )
  })

  it('bounds the outer deadline independently of QuickJS and case count', () => {
    const input = request()
    expect(agentValidationTimeoutMs(input)).toBe(2500)
    input.suite.cases[0].steps = Array(100).fill(input.suite.cases[0].steps[0])
    expect(agentValidationTimeoutMs(input)).toBe(AGENT_VALIDATION_MAX_TIMEOUT_MS)
  })

  it('launches a fresh restricted worker per suite and terminates before resolving', async () => {
    const { validate, workers, launches, reply } = fixture()
    const input = request()
    const controller = new AbortController()
    const pending = validate(input, controller.signal)
    expect(launches[0].entry.href).toBe('file:///test/agentValidationWorker.mjs')
    expect(launches[0].options).toEqual({
      workerData: { requestId: expect.any(String), request: input },
      env: {},
      execArgv: [],
      resourceLimits: AGENT_VALIDATION_WORKER_RESOURCE_LIMITS
    })
    const report = createNotRunAgentValidationReport(input, 'test completed')
    reply(0, report)
    expect(await pending).toEqual(report)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[0].eventNames()).toEqual([])
    controller.abort()
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    const again = validate(input)
    expect(workers).toHaveLength(2)
    expect(launches[1].options.workerData.requestId).not.toBe(
      launches[0].options.workerData.requestId
    )
    reply(1, report)
    await again
  })

  it('snapshots fallback metadata and fixtures before callers can change them', async () => {
    const { validate, launches, reply } = fixture()
    const input = request()
    const pending = validate(input)
    input.candidateHash = 'changed-after-launch'
    input.suite.cases[0].state.botState.changed = true
    expect(launches[0].options.workerData.request.candidateHash).toBe('candidate-hash')
    expect(launches[0].options.workerData.request.suite.cases[0].state.botState).toEqual({})
    reply(0)
    expect((await pending).candidateHash).toBe('candidate-hash')
  })

  it.each(['wrong-candidate', 'wrong-fixture', 'empty-pass'])(
    'rejects a report for %s even when the token matches',
    async (failure) => {
      const { validate, reply } = fixture()
      const pending = validate(request())
      const report = createNotRunAgentValidationReport(request(), 'test')
      if (failure === 'wrong-candidate') report.candidateHash = 'other-candidate'
      else if (failure === 'wrong-fixture') report.fixtureHash = 'other-fixture'
      else report.outcome = 'passed'
      reply(0, report)
      const result = await pending
      expect(result.outcome).toBe('not_run')
      expect(result.coverage.executed).toBe(0)
      expect(result.candidateHash).toBe('candidate-hash')
      expect(result.fixtureHash).toBe('fixture-hash')
    }
  )

  it('does not launch a worker for an already cancelled signal', async () => {
    const { validate, workers } = fixture()
    const controller = new AbortController()
    controller.abort()
    const report = await validate(request(), controller.signal)
    expect(workers).toEqual([])
    expect(report.outcome).toBe('not_run')
    expect(report.cancelled).toBe(true)
    expect(report.coverage.executed).toBe(0)
  })

  it('kills an in-flight worker on abort and ignores late results', async () => {
    const { validate, workers, reply } = fixture()
    const controller = new AbortController()
    const pending = validate(request(), controller.signal)
    const lateCallback = workers[0].listeners('message')[0]
    controller.abort()
    const report = await pending
    expect(report.outcome).toBe('not_run')
    expect(report.cancelled).toBe(true)
    expect(report.coverage.executed).toBe(0)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    reply(0)
    lateCallback({ requestId: 'stale', report: { outcome: 'passed' } })
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[0].eventNames()).toEqual([])
  })

  it('kills stalled workers at the outer deadline without claiming passes', async () => {
    vi.useFakeTimers()
    const { validate, workers } = fixture()
    const pending = validate(request())
    await vi.advanceTimersByTimeAsync(100)
    const report = await pending
    expect(report.outcome).toBe('not_run')
    expect(report.timedOut).toBe(true)
    expect(report.coverage.executed).toBe(0)
    expect(report.coverage.notRun).toBe(1)
    expect(workers[0].terminate).toHaveBeenCalledOnce()
    expect(workers[0].eventNames()).toEqual([])
  })

  it('ignores stale messages until this request returns its own report', async () => {
    const { validate, workers, reply } = fixture()
    const pending = validate(request())
    workers[0].emit('message', { requestId: 'another-suite', report: { outcome: 'passed' } })
    expect(workers[0].terminate).not.toHaveBeenCalled()
    const expected = createNotRunAgentValidationReport(request(), 'current report')
    reply(0, expected)
    expect(await pending).toEqual(expected)
  })

  it.each(['error', 'exit', 'invalid-report'])(
    'returns a not-run report and disposes after %s',
    async (failure) => {
      const { validate, workers, launches } = fixture()
      const pending = validate(request())
      if (failure === 'error') workers[0].emit('error', new Error('worker failure'))
      else if (failure === 'exit') workers[0].emit('exit', 1)
      else
        workers[0].emit('message', {
          requestId: launches[0].options.workerData.requestId
        })
      const report = await pending
      expect(report.outcome).toBe('not_run')
      expect(report.coverage.executed).toBe(0)
      expect(workers[0].terminate).toHaveBeenCalledOnce()
      expect(workers[0].eventNames()).toEqual([])
    }
  )

  it.each(['abort', 'timeout', 'report'])(
    'handles synchronous worker errors emitted during %s termination',
    async (shutdown) => {
      vi.useFakeTimers()
      const { validate, workers, reply } = fixture()
      const controller = new AbortController()
      const pending = validate(request(), controller.signal)
      workers[0].terminate.mockImplementation(async () => {
        expect(workers[0].listenerCount('error')).toBe(1)
        workers[0].emit('error', new Error('Error queued while terminating'))
        return 0
      })
      const expected = createNotRunAgentValidationReport(request(), 'finished reply')
      if (shutdown === 'abort') controller.abort()
      else if (shutdown === 'timeout') vi.advanceTimersByTime(100)
      else reply(0, expected)
      const report = await pending
      if (shutdown === 'report') expect(report).toEqual(expected)
      else expect(report[shutdown === 'abort' ? 'cancelled' : 'timedOut']).toBe(true)
      expect(workers[0].terminate).toHaveBeenCalledOnce()
      expect(workers[0].eventNames()).toEqual([])
    }
  )

  it.each(['abort', 'timeout', 'report'])(
    'drains a real worker queued throw safely during %s shutdown',
    async (shutdown) => {
      if (shutdown === 'timeout') vi.useFakeTimers()
      const input = request()
      const expected = createNotRunAgentValidationReport(input, 'finished worker reply')
      const ready = new Int32Array(new SharedArrayBuffer(4))
      const workers: Worker[] = []
      const uncaught: Error[] = []
      const recordUncaught = (error: Error) => uncaught.push(error)
      process.on('uncaughtException', recordUncaught)
      const validate = createAgentValidationService({
        timeoutMs: shutdown === 'timeout' ? 10 : 2000,
        workerFactory(_entry, options) {
          // This trusted error-only fixture runs in a real injected worker, never in
          // the main thread, and imports no application, Electron or live services.
          const source = `
            const { parentPort, workerData } = require('node:worker_threads')
            const ready = new Int32Array(workerData.ready)
            if (workerData.sendReport)
              parentPort.postMessage({ requestId: workerData.requestId, report: workerData.report })
            Atomics.store(ready, 0, 1)
            Atomics.notify(ready, 0)
            throw new Error('Queued worker failure')
          `
          const worker = new Worker(source, {
            ...options,
            eval: true,
            workerData: {
              ...options.workerData,
              ready: ready.buffer,
              sendReport: shutdown === 'report',
              report: expected
            }
          })
          workers.push(worker)
          return worker
        }
      })
      const controller = new AbortController()
      try {
        const pending = validate(input, controller.signal)
        // Wait synchronously for the worker's throw to be queued while its message/
        // error callbacks cannot yet run on this parent event loop. This recreates
        // cancellation and deadline races instead of relying on timing luck.
        expect(Atomics.wait(ready, 0, 0, 2000)).not.toBe('timed-out')
        Atomics.wait(ready, 0, 1, 100)
        if (shutdown === 'abort') controller.abort()
        else if (shutdown === 'timeout') vi.advanceTimersByTime(10)
        const report = await pending
        vi.useRealTimers()
        await new Promise<void>((resolve) => setImmediate(resolve))
        if (shutdown === 'report') expect(report).toEqual(expected)
        else expect(report[shutdown === 'abort' ? 'cancelled' : 'timedOut']).toBe(true)
        expect(uncaught).toEqual([])
        expect(workers[0].threadId).toBe(-1)
        expect(workers[0].listenerCount('error')).toBe(0)
        expect(workers[0].listenerCount('message')).toBe(0)
        expect(workers[0].listenerCount('exit')).toBe(0)
      } finally {
        vi.useRealTimers()
        process.off('uncaughtException', recordUncaught)
        await Promise.all(workers.map((worker) => worker.terminate()))
      }
    },
    10_000
  )

  it('fails closed when worker construction fails', async () => {
    const validate = createAgentValidationService({
      workerFactory() {
        throw new Error('worker unavailable')
      }
    })
    const report = await validate(request())
    expect(report.outcome).toBe('not_run')
    expect(report.coverage.executed).toBe(0)
  })
})
