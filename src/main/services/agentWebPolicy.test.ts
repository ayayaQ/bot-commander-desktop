import { describe, expect, it, vi } from 'vitest'
import type { DecisionProvider } from '@ayayaq/vivi/decisions'
import { routePreparedAction } from '@ayayaq/vivi/decisions'
import { prepareAgentWeb, webKey, webReviewSnapshot } from './agentWebPolicy'
import { AGENT_WEB_POLICY_REVISION } from '../../shared/agentWeb'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import { registerAgentDecisionSecret } from './agentDecisionPrivacy'
import { reviewAgentMutation } from './agentAutoReview'
vi.mock('./agentDecisionLedger', () => ({ agentDecisionLedger: {} }))
const settings = {
  webProvider: 'deepseek' as const,
  deepseekWebKeySource: 'separate' as const,
  deepseekApiKey: 'chat-fixture',
  deepseekWebApiKey: 'web-fixture',
  agentWebAccountRevision: 'web-revision'
}
const account = {
  provider: 'openai' as const,
  revision: 'review-revision',
  apiKey: 'review-fixture'
}
function fixture() {
  const prepared = prepareAgentWeb(
    'web_search',
    { query: 'Electron sandbox documentation' },
    settings
  )
  const enrollment = {
    policyRevision: AUTO_REVIEW_POLICY_REVISION,
    provider: account.provider,
    accountRevision: account.revision,
    acknowledgedAt: new Date().toISOString(),
    web: {
      policyRevision: AGENT_WEB_POLICY_REVISION,
      accountRevision: settings.agentWebAccountRevision
    }
  }
  let revisions = { account: account.revision, webAccount: settings.agentWebAccountRevision }
  const snapshot = () =>
    webReviewSnapshot({
      sessionId: 'session',
      runId: 'run',
      callId: 'call',
      userRequestId: 'request',
      userRequest: 'Check how Electron sandbox works',
      prepared,
      enrollment,
      resourceRevisions: revisions
    })
  const provider: DecisionProvider = {
    id: 'openai',
    model: 'gpt-6-luna',
    evaluate: vi.fn(async (request) => ({
      model: 'gpt-6-luna',
      answers: request.policy.checks.map((check) => ({
        name: check.name,
        type: 'predicate' as const,
        probability: 1
      })),
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 }
    }))
  }
  const ledger = {
    available: vi.fn(async () => true),
    assertAutomaticAdmission: vi.fn(),
    record: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    suspend: vi.fn()
  }
  const options = {
    prepared,
    enrollment,
    context: { requests: 0 },
    signal: new AbortController().signal,
    account: () => account,
    assertActive: () => {},
    snapshot,
    provider,
    ledger
  }
  return {
    prepared,
    enrollment,
    snapshot,
    provider,
    ledger,
    options,
    changeAccount: () => {
      revisions = { ...revisions, webAccount: 'new-account' }
    }
  }
}
describe('desktop exact paid web scope', () => {
  it('defaults disabled and never infers web key reuse from chat', () => {
    expect(() =>
      prepareAgentWeb('web_search', { query: 'hello' }, { deepseekApiKey: 'chat' })
    ).toThrow('disabled')
    expect(webKey({ ...settings, deepseekWebApiKey: '' })).toBe('')
    expect(webKey({ ...settings, deepseekWebKeySource: 'chat' })).toBe('chat-fixture')
  })
  it('binds generated query, count, content, endpoint, estimate and account independently', () => {
    const f = fixture()
    expect(f.prepared.arguments).toEqual({
      query: 'Electron sandbox documentation',
      count: 5,
      includeContent: false
    })
    expect(f.prepared.after).toMatchObject({
      provider: 'deepseek',
      endpoint: 'https://api.deepseek.com/v1/tools/search',
      cost: { documentedEstimatePerRequest: 0.00075, retry: false, fallback: false }
    })
    expect(routePreparedAction(f.snapshot()).route).toBe('model-review')
    for (const change of [
      { query: 'different' },
      { query: 'Electron sandbox documentation', count: 2 },
      { query: 'Electron sandbox documentation', includeContent: true }
    ])
      expect(prepareAgentWeb('web_search', change, settings).operationDigest).not.toBe(
        f.prepared.operationDigest
      )
    expect(
      prepareAgentWeb('web_search', f.prepared.arguments, {
        ...settings,
        agentWebAccountRevision: 'other'
      }).operationDigest
    ).not.toBe(f.prepared.operationDigest)
    expect(JSON.stringify(f.snapshot())).not.toMatch(/chat-fixture|web-fixture|review-fixture/)
    expect(() => {
      ;(f.prepared.intent.request as { query: string }).query = 'replacement'
    }).toThrow()
  })
  it.each([
    'http://example.com',
    'https://localhost/x',
    'https://localhost./x',
    'https://localhost../x',
    'https://example.local../x',
    'https://example..com/x',
    'https://example.local./x',
    'https://printer.home.arpa/x',
    'https://example.localdomain/x',
    'https://intranet./x',
    'https://127.0.0.1/x',
    'https://[::1]/',
    'https://user:pw@example.com/',
    'https://example.com/?token=abc',
    'https://example.internal/',
    'https://example.com:444/'
  ])('rejects non-public or credential-bearing URL %s', (url) => {
    expect(() => prepareAgentWeb('fetch_url', { url }, settings)).toThrow()
  })
  it('preserves full public HTTPS path/query and rejects extra sensitive/body fields', () => {
    expect(
      prepareAgentWeb('fetch_url', { url: 'https://example.com/help?a=1&b=2' }, settings).intent
        .request
    ).toEqual({ url: 'https://example.com/help?a=1&b=2' })
    expect(
      prepareAgentWeb('fetch_url', { url: 'https://example.com./help?a=1' }, settings).intent
        .request
    ).toEqual({ url: 'https://example.com./help?a=1' })
    registerAgentDecisionSecret('never-send-fixture')
    expect(() =>
      prepareAgentWeb('web_search', { query: 'never%2dsend%2dfixture' }, settings)
    ).toThrow('credential')
    expect(() =>
      prepareAgentWeb('web_search', { query: 'safe', original_question: 'private' }, settings)
    ).toThrow()
    expect(() => prepareAgentWeb('web_search', { query: '😀'.repeat(129) }, settings)).toThrow()
    expect(() => prepareAgentWeb('web_search', { query: 'safe', count: 6 }, settings)).toThrow()
  })
  it('does not expand old Auto consent and shares the existing two-review budget', async () => {
    const f = fixture()
    delete (f.enrollment as { web?: unknown }).web
    const result = await reviewAgentMutation(f.options)
    expect(result.automatic).toBe(false)
    expect(result.display.reasonCode).toBe('web_enrollment_required')
    expect(f.provider.evaluate).not.toHaveBeenCalled()
    const fresh = fixture()
    fresh.options.context.requests = 2
    expect((await reviewAgentMutation(fresh.options)).display.reasonCode).toBe(
      'review_budget_exhausted'
    )
    expect(fresh.provider.evaluate).not.toHaveBeenCalled()
  })
  it('lets the reviewer assess relevance instead of literal matching and rejects changed scope', async () => {
    const f = fixture()
    const result = await reviewAgentMutation(f.options)
    expect(result.automatic).toBe(true)
    expect(await result.beginCommit()).toBe(true)
    const request = vi.mocked(f.provider.evaluate).mock.calls[0][0]
    expect(request.policy.checks[0].instructions).toContain('does not need to have literally typed')
    expect(request.policy.checks[1].instructions).toContain('not an enforceable billing cap')
    f.changeAccount()
    expect(() => result.assertCurrent(f.prepared)).toThrow('stale')
  })
})
