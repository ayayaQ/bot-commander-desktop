import { describe, expect, it, vi } from 'vitest'
import { executeAgentWeb } from './agentWebService'
import { prepareAgentWeb } from './agentWebPolicy'
import { registerAgentDecisionSecret } from './agentDecisionPrivacy'
vi.mock('./agentWebOutcomes', () => ({ agentWebOutcomes: {} }))
function fixture() {
  const controller = new AbortController()
  const prepared = prepareAgentWeb(
    'web_search',
    { query: 'public docs' },
    {
      webProvider: 'deepseek',
      deepseekWebKeySource: 'separate',
      deepseekWebApiKey: 'web-fixture',
      agentWebAccountRevision: 'web-revision'
    }
  )
  const events: string[] = []
  const outcomes = {
    intent: vi.fn(async () => {
      events.push('intent')
    }),
    settle: vi.fn(async () => {
      events.push('settle')
    }),
    assertWritable: vi.fn(),
    load: vi.fn(),
    records: () => [],
    uncertain: () => false,
    drain: async () => {}
  }
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    events.push('http')
    expect(outcomes.intent).toHaveBeenCalledOnce()
    expect(JSON.parse(String(init?.body))).toEqual({
      query: 'public docs',
      count: 5,
      need_content: false
    })
    expect(String(url)).toBe('https://api.deepseek.com/v1/tools/search')
    return new Response(
      JSON.stringify({
        results: [
          {
            title: 'Docs',
            url: 'https://example.com/docs',
            snippet: 'Snippet',
            summary: 'Summary',
            content: 'Evidence is data'
          }
        ]
      })
    )
  })
  const options = {
    prepared,
    sessionId: 'session',
    runId: 'run',
    callId: 'call',
    apiKey: 'web-fixture',
    signal: controller.signal,
    assertCurrent: vi.fn(),
    checkpoint: vi.fn(async () => {}),
    fetch: transport,
    outcomes
  }
  return { controller, events, outcomes, transport, options }
}
describe('desktop main-process web execution', () => {
  it('journals before one paid request and retains untrusted source/citation evidence', async () => {
    const f = fixture()
    const output = await executeAgentWeb(f.options)
    expect(f.events).toEqual(['intent', 'http', 'settle'])
    expect(f.transport).toHaveBeenCalledOnce()
    expect(output.result).toMatchObject({
      source: 'web_provider',
      provider: 'deepseek',
      untrusted: true,
      success: true,
      requestState: 'response_received',
      results: [{ url: 'https://example.com/docs' }],
      provenance: { untrusted: true, upstreamTruncation: 'unknown' }
    })
    expect(output.result).not.toHaveProperty('status')
    expect(output.result).not.toHaveProperty('finalUrl')
    expect(output.evidence.outcome).toBe('confirmed')
  })
  it('vetoes stale/failed persistence without a request or fallback', async () => {
    const f = fixture()
    f.outcomes.intent.mockRejectedValueOnce(new Error('disk unavailable'))
    const output = await executeAgentWeb(f.options)
    expect(f.transport).not.toHaveBeenCalled()
    expect(output.evidence.requestState).toBe('not_started')
    const g = fixture()
    g.options.assertCurrent.mockImplementation(() => {
      throw new Error('stale')
    })
    expect((await executeAgentWeb(g.options)).evidence.requestState).toBe('not_started')
    expect(g.transport).not.toHaveBeenCalled()
  })
  it('cancels during intent persistence, drains it and never dispatches late', async () => {
    const f = fixture()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => (finish = resolve))
    f.outcomes.intent.mockImplementationOnce(async () => {
      f.events.push('intent')
      await gate
    })
    const pending = executeAgentWeb(f.options)
    await vi.waitFor(() => expect(f.outcomes.intent).toHaveBeenCalledOnce())
    f.controller.abort()
    finish()
    const output = await pending
    expect(output.evidence.requestState).toBe('not_started')
    expect(f.transport).not.toHaveBeenCalled()
    expect(f.outcomes.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'not-sent', requestState: 'not_started' })
    )
  })
  it('marks post-dispatch cancellation/lost replies unknown with no retry', async () => {
    const f = fixture()
    f.transport.mockImplementationOnce(async () => {
      f.controller.abort()
      throw new Error('lost')
    })
    const output = await executeAgentWeb(f.options)
    expect(f.transport).toHaveBeenCalledOnce()
    expect(output.evidence).toMatchObject({ outcome: 'unknown', requestState: 'unknown' })
    expect(output.result).toMatchObject({ success: false, doNotRetry: true, unknownOutcome: true })
  })
  it('retains API receipt state on HTTP failures and flags unconfirmed settlement', async () => {
    const f = fixture()
    f.transport.mockResolvedValueOnce(new Response('private body', { status: 503 }))
    f.outcomes.settle.mockRejectedValueOnce(new Error('disk failed'))
    const output = await executeAgentWeb(f.options)
    expect(output.evidence).toMatchObject({
      outcome: 'confirmed',
      requestState: 'response_received',
      checkpointUnconfirmed: true
    })
    expect(JSON.stringify(output)).not.toContain('private body')
    expect(output.result.doNotRetry).toBe(true)
  })
  it('rechecks queued invalidation synchronously at raw dispatch and settles not-sent', async () => {
    const f = fixture()
    f.outcomes.assertWritable.mockImplementationOnce(() => {
      queueMicrotask(() =>
        f.options.assertCurrent.mockImplementation(() => {
          throw new Error('privacy/account/admission changed')
        })
      )
    })
    const output = await executeAgentWeb(f.options)
    expect(f.transport).not.toHaveBeenCalled()
    expect(output.evidence).toMatchObject({ outcome: 'not-sent', requestState: 'not_started' })
    expect(f.outcomes.settle).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'not-sent', requestState: 'not_started' })
    )
  })
  it('treats a synchronous raw transport throw as invoked/unknown without retry', async () => {
    const f = fixture()
    f.transport.mockImplementationOnce(() => {
      throw new Error('raw transport threw')
    })
    const output = await executeAgentWeb(f.options)
    expect(f.transport).toHaveBeenCalledOnce()
    expect(output.evidence).toMatchObject({ outcome: 'unknown', requestState: 'unknown' })
  })
  it('screens a known credential registered after async admission at raw dispatch', async () => {
    const f = fixture()
    const secret = 'newly-known-final-boundary-fixture'
    f.options.prepared = prepareAgentWeb(
      'web_search',
      { query: secret },
      {
        webProvider: 'deepseek',
        deepseekWebKeySource: 'separate',
        deepseekWebApiKey: 'web-fixture',
        agentWebAccountRevision: 'web-revision'
      }
    )
    f.outcomes.assertWritable.mockImplementationOnce(() => {
      queueMicrotask(() => registerAgentDecisionSecret(secret))
    })
    const output = await executeAgentWeb(f.options)
    expect(f.transport).not.toHaveBeenCalled()
    expect(output.evidence).toMatchObject({ outcome: 'not-sent', requestState: 'not_started' })
  })
})
