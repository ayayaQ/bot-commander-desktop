import { createDeepSeekWebProvider } from '@ayayaq/vivi/web/deepseek'
import { WebProviderError } from '@ayayaq/vivi/web'
import type { WebRequestIntent } from '@ayayaq/vivi/web'
import type { AgentWebCallEvidence } from '../../shared/agentWeb'
import type { PreparedWebOperation } from './agentWebPolicy'
import { agentWebOutcomes } from './agentWebOutcomes'
import { assertAgentMcpPrivacy } from './agentDecisionPrivacy'

let nextWebDispatch = 0
async function reserveWebDispatch(signal: AbortSignal): Promise<void> {
  const at = Math.max(Date.now(), nextWebDispatch)
  nextWebDispatch = at + 210
  if (at <= Date.now()) return
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new Error('Web admission cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, at - Date.now())
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Main-process only; renderer/model inputs cannot choose a key, endpoint or transport. */
export async function executeAgentWeb(options: {
  prepared: PreparedWebOperation
  sessionId: string
  runId: string
  callId: string
  apiKey: string
  signal: AbortSignal
  assertCurrent: () => void
  checkpoint: (evidence: AgentWebCallEvidence) => Promise<void>
  fetch?: typeof fetch
  outcomes?: typeof agentWebOutcomes
}): Promise<{ result: Record<string, unknown>; evidence: AgentWebCallEvidence }> {
  const p = options.prepared
  const outcomes = options.outcomes || agentWebOutcomes
  let evidence: AgentWebCallEvidence = {
    runId: options.runId,
    operationDigest: p.operationDigest,
    provider: 'deepseek',
    requestState: 'not_started',
    outcome: 'not-sent'
  }
  let intended = false
  let received = false
  let didDispatch = false
  let admission: Promise<void> | undefined
  const row = () => ({ ...evidence, sessionId: options.sessionId, callId: options.callId })
  const assertCurrent = (intent?: WebRequestIntent) => {
    options.signal.throwIfAborted()
    options.assertCurrent()
    assertAgentMcpPrivacy(p.intent)
    if (intent && JSON.stringify(intent) !== JSON.stringify(p.intent))
      throw new Error('Exact web request changed before dispatch')
  }
  const rawFetch = options.fetch || globalThis.fetch
  const provider = createDeepSeekWebProvider({
    apiKey: options.apiKey,
    fetch: (input, init) => {
      // The async admission hook may yield again before core dispatch. No await is
      // permitted between this exact host guard and invoking the captured transport.
      assertCurrent()
      init?.signal?.throwIfAborted()
      outcomes.assertWritable()
      didDispatch = true
      return rawFetch(input, init)
    },
    timeoutMs: 60_000,
    maxResponseBytes: 2 * 1024 * 1024,
    maxContentChars: 8_000,
    beforeRequest: (intent, hookSignal) =>
      (admission = (async () => {
        assertCurrent(intent)
        await reserveWebDispatch(hookSignal)
        hookSignal.throwIfAborted()
        assertCurrent(intent)
        evidence = {
          ...evidence,
          outcome: 'pending',
          requestState: 'unknown',
          intentAt: new Date().toISOString()
        }
        await outcomes.intent(row())
        intended = true
        await options.checkpoint(evidence)
        hookSignal.throwIfAborted()
        assertCurrent(intent)
        outcomes.assertWritable()
      })())
  })
  let result: Record<string, unknown>
  try {
    assertCurrent()
    const response =
      p.intent.operation === 'search'
        ? await provider.search(p.intent.request, options.signal)
        : await provider.fetch(p.intent.request, options.signal)
    received = true
    // Known credentials echoed by an untrusted provider never enter the session/model.
    assertAgentMcpPrivacy(response)
    evidence = {
      ...evidence,
      outcome: 'confirmed',
      requestState: 'response_received',
      settledAt: new Date().toISOString()
    }
    result = {
      source: 'web_provider',
      provider: 'deepseek',
      untrusted: true,
      success: true,
      ...response,
      requestState: evidence.requestState,
      billing: 'unverified locally',
      retry: false
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) {
      // Retain source URLs/citations and provenance, then remove optional full content first.
      if ('results' in response)
        result.results = response.results.map((item) => ({
          ...item,
          content: '',
          localTruncation: [...(item.localTruncation as string[]), 'content']
        }))
      if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024)
        throw new Error('Web output exceeds host bound')
    }
  } catch (error) {
    const requestState = !didDispatch
      ? 'not_started'
      : error instanceof WebProviderError
        ? error.requestState
        : received
          ? 'response_received'
          : intended
            ? 'unknown'
            : 'not_started'
    evidence = {
      ...evidence,
      requestState,
      outcome:
        requestState === 'not_started'
          ? 'not-sent'
          : requestState === 'response_received'
            ? 'confirmed'
            : 'unknown',
      settledAt: new Date().toISOString()
    }
    result = {
      source: 'web_provider',
      provider: 'deepseek',
      untrusted: true,
      success: false,
      requestState,
      error: {
        code: error instanceof WebProviderError ? error.code : 'host_preflight_or_result',
        message:
          requestState === 'not_started'
            ? 'Web request was not sent. Check its exact approval, configuration and privacy requirements.'
            : 'Web request may have reached DeepSeek and may be billed. No retry was made; inspect this outcome before another attempt.'
      },
      unknownOutcome: requestState === 'unknown',
      doNotRetry: requestState !== 'not_started',
      retry: false
    }
  }
  // A timed-out core hook may still be draining a durable write. It cannot dispatch,
  // and the owner must wait for it before the not-sent settlement.
  await admission?.catch(() => undefined)
  if (intended) {
    try {
      await outcomes.settle(row())
    } catch {
      evidence.checkpointUnconfirmed = true
      result.checkpointUnconfirmed = true
      result.doNotRetry = true
    }
  }
  try {
    await options.checkpoint(evidence)
  } catch {
    evidence.checkpointUnconfirmed = true
    result.checkpointUnconfirmed = true
    result.doNotRetry = true
  }
  return { result, evidence }
}
