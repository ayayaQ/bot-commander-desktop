import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  routePreparedAction,
  type DecisionProvider,
  type DecisionRequest
} from '@ayayaq/vivi/decisions'
import type { AgentAutoReviewEnrollment } from '../../shared/agentAutoReview'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import { reviewAgentMutation, autoReviewSnapshot, decisionBinding } from './agentAutoReview'
import type { PreparedMutation } from './agentTools'
import { registerAgentDecisionSecret } from './agentDecisionPrivacy'
import { DECISION_TIMEOUT_MS, desktopDecisionPolicy } from './agentDecisionPolicy'

vi.mock('./agentDecisionLedger', () => ({ agentDecisionLedger: {} }))

function fixture(providerId: 'openai' | 'openrouter' = 'openai', probability = 1) {
  const controller = new AbortController()
  const account = {
    provider: providerId,
    revision: 'account-fixture-1',
    apiKey: 'offline-judge-fixture'
  }
  registerAgentDecisionSecret(account.apiKey)
  const enrollment: AgentAutoReviewEnrollment = {
    policyRevision: AUTO_REVIEW_POLICY_REVISION,
    provider: providerId,
    accountRevision: account.revision,
    acknowledgedAt: '2026-10-08T01:00:00.000Z'
  }
  const prepared: PreparedMutation = {
    name: 'create_memory',
    arguments: { content: 'Prefer concise answers' },
    before: null,
    after: {
      id: 'memory-fixture',
      content: 'Prefer concise answers',
      createdAt: '',
      updatedAt: '',
      createdBy: 'agent',
      updatedBy: 'agent'
    },
    target: { type: 'memory', id: 'memory-fixture' }
  }
  let resource = 'resource-fixture-1'
  const snapshot = () =>
    autoReviewSnapshot({
      sessionId: 'agent-fixture',
      runId: 'run-fixture',
      callId: 'call-fixture',
      userRequestId: 'request-fixture',
      userRequest: 'Remember that I prefer concise answers.',
      prepared,
      enrollment,
      resourceRevisions: {
        resource,
        account: account.revision,
        enrollment: decisionBinding(enrollment)
      }
    })
  const provider: DecisionProvider = {
    id: providerId,
    model: providerId === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13',
    evaluate: vi.fn(async (request: DecisionRequest) => ({
      model: provider.model,
      answers: request.policy.checks.map((check) => ({
        name: check.name,
        type: 'predicate' as const,
        probability
      })),
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, costUsd: 0.0001 }
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
    snapshot,
    account: () => account,
    context: { requests: 0 },
    signal: controller.signal,
    assertActive: () => {
      if (controller.signal.aborted) throw new Error('cancelled')
    },
    provider,
    ledger
  }
  return {
    options,
    controller,
    account,
    enrollment,
    prepared,
    provider,
    ledger,
    setResource: (value: string) => {
      resource = value
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('bounded desktop Auto review with offline providers', () => {
  it('captures immutable app-wide memory effects with exact host revisions', async () => {
    const f = fixture()
    const snapshot = f.options.snapshot()
    expect(routePreparedAction(snapshot)).toEqual({
      route: 'model-review',
      reasonCode: 'model_review_required'
    })
    expect(snapshot.preparedAction).toEqual({
      complete: true,
      effects: [
        {
          kind: 'write',
          resourceId: 'desktop:memory:memory-fixture',
          scope: 'outside-workspace',
          affectedData: {
            normalizedBefore: null,
            normalizedAfter: { id: 'memory-fixture', content: 'Prefer concise answers' },
            persistence: 'app-wide-memory'
          },
          review: 'model-review'
        }
      ]
    })
    expect(snapshot.resourceRevisions['desktop:memory:memory-fixture']).toMatchObject({
      resource: 'resource-fixture-1',
      preparedBinding: snapshot.resourceRevisions.preparedBinding,
      validationBinding: null
    })
    expect(Object.isFrozen(snapshot.preparedAction)).toBe(true)
    expect(Object.isFrozen(snapshot.preparedAction!.effects)).toBe(true)
    expect(Object.isFrozen(snapshot.preparedAction!.effects[0].affectedData)).toBe(true)
    const review = await reviewAgentMutation(f.options)
    expect(review.automatic).toBe(true)
    const request = vi.mocked(f.provider.evaluate).mock.calls[0][0]
    expect(Object.isFrozen(request.snapshot.preparedAction!.effects[0].affectedData)).toBe(true)
    f.prepared.after = { ...(f.prepared.after as object), content: 'Prefer examples' }
    expect(request.snapshot.preparedAction).toEqual(snapshot.preparedAction)
    expect(() => review.assertCurrent(f.prepared)).toThrow('stale')
  })

  it.each(['missing', 'incomplete', 'manual', 'blocked', 'ordinary-read'] as const)(
    'keeps a %s prepared route local without a reviewer request',
    async (change) => {
      const f = fixture()
      const original = f.options.snapshot
      f.options.snapshot = () => {
        const snapshot = structuredClone(original())
        if (change === 'missing') delete snapshot.preparedAction
        else if (change === 'incomplete') snapshot.preparedAction = { complete: false, effects: [] }
        else
          snapshot.preparedAction = {
            ...snapshot.preparedAction!,
            effects: [{ ...snapshot.preparedAction!.effects[0], review: change }]
          }
        return snapshot
      }
      expect((await reviewAgentMutation(f.options)).automatic).toBe(false)
      expect(f.provider.evaluate).not.toHaveBeenCalled()
      expect(f.ledger.record).not.toHaveBeenCalled()
    }
  )

  it('requires complete prepared identity and current resource evidence', async () => {
    const f = fixture()
    delete (f.prepared.after as { id?: string }).id
    expect(f.options.snapshot().preparedAction!.complete).toBe(false)
    expect((await reviewAgentMutation(f.options)).automatic).toBe(false)
    expect(f.provider.evaluate).not.toHaveBeenCalled()
  })

  it('rechecks exact effect routing before the one-time commit journal', async () => {
    const f = fixture()
    const review = await reviewAgentMutation(f.options)
    expect(review.automatic).toBe(true)
    const original = f.options.snapshot
    f.options.snapshot = () => {
      const snapshot = structuredClone(original())
      snapshot.preparedAction = {
        ...snapshot.preparedAction!,
        effects: [{ ...snapshot.preparedAction!.effects[0], review: 'manual' }]
      }
      return snapshot
    }
    expect(await review.beginCommit()).toBe(false)
    expect(review.automatic).toBe(false)
    expect(f.ledger.settle).not.toHaveBeenCalled()
  })

  it.each([
    ['openai', 0.995, true, 'requirements_met'],
    ['openai', 0.9949, false, 'uncertain'],
    ['openai', 0.05, false, 'provider_recommended_reject'],
    ['openrouter', 0.999, true, 'requirements_met'],
    ['openrouter', 0.9989, false, 'uncertain'],
    ['openrouter', 0.05, false, 'provider_recommended_reject']
  ] as const)('uses explicit %s boundary %s', async (provider, probability, automatic, reason) => {
    const f = fixture(provider, probability)
    const result = await reviewAgentMutation(f.options)
    expect(result.automatic).toBe(automatic)
    expect(result.display.reasonCode).toBe(reason)
    expect(f.provider.evaluate).toHaveBeenCalledTimes(1)
    expect(result.display.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      totalTokens: 25,
      costUsd: 0.0001
    })
  })

  it('journals before an automatic write, consumes once and settles separately', async () => {
    const f = fixture()
    const review = await reviewAgentMutation(f.options)
    expect(review.automatic).toBe(true)
    expect(f.ledger.record).toHaveBeenCalledTimes(1)
    expect(await review.beginCommit()).toBe(true)
    expect(await review.beginCommit()).toBe(false)
    expect(f.ledger.settle).toHaveBeenCalledWith(
      review.display.id,
      {
        state: 'commit_started',
        source: 'automatic'
      },
      {
        provider: 'openai',
        accountRevision: 'account-fixture-1',
        policyRevision: AUTO_REVIEW_POLICY_REVISION
      }
    )
    expect(await review.settle('committed', '0123456789abcdef')).toBe(true)
    expect(f.ledger.settle).toHaveBeenLastCalledWith(
      review.display.id,
      expect.objectContaining({ state: 'committed', resultingRevision: '0123456789abcdef' })
    )
    const audit = JSON.stringify(f.ledger.record.mock.calls)
    expect(audit).not.toContain('Prefer concise')
    expect(audit).not.toContain('Remember that')
    expect(audit).not.toContain(f.account.apiKey)
  })

  it.each(['missing', 'policy', 'account', 'provider'] as const)(
    'keeps %s enrollment manual without a judge request',
    async (change) => {
      const f = fixture()
      if (change === 'missing')
        delete (f.options as { enrollment?: AgentAutoReviewEnrollment }).enrollment
      if (change === 'policy') f.enrollment.policyRevision = 'older-policy'
      if (change === 'account') f.enrollment.accountRevision = 'different-account'
      if (change === 'provider') f.enrollment.provider = 'openrouter'
      const review = await reviewAgentMutation(f.options)
      expect(review.automatic).toBe(false)
      expect(review.display.reasonCode).toBe('enrollment_required')
      expect(f.provider.evaluate).not.toHaveBeenCalled()
    }
  )

  it.each([
    'delete_memory',
    'create_interaction',
    'edit_bot_state',
    'edit_startup_js',
    'edit_developer_prompt'
  ])('keeps %s outside model authority', async (name) => {
    const f = fixture()
    f.prepared.name = name
    expect((await reviewAgentMutation(f.options)).automatic).toBe(false)
    expect(f.provider.evaluate).not.toHaveBeenCalled()
  })

  it('enforces the request-count budget and missing reviewer fallback', async () => {
    const f = fixture()
    f.options.context.requests = 2
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe(
      'review_budget_exhausted'
    )
    f.options.context.requests = 0
    f.account.apiKey = ''
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe('reviewer_unavailable')
    expect(f.provider.evaluate).not.toHaveBeenCalled()
  })

  it('keeps a known secret or flagged private content local', async () => {
    const f = fixture()
    f.prepared.arguments.content = f.account.apiKey
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe('privacy_known_secret')
    f.prepared.arguments.content = 'This medical condition should be remembered'
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe(
      'privacy_sensitive_or_uncertain'
    )
    expect(f.provider.evaluate).not.toHaveBeenCalled()
    expect(f.ledger.record).not.toHaveBeenCalled()
  })

  it('keeps undeclared or coerced memory arguments Manual before a provider request', async () => {
    const f = fixture()
    f.prepared.arguments.unrelated = 'Unnecessary context'
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe(
      'memory_arguments_unsupported'
    )
    delete f.prepared.arguments.unrelated
    f.prepared.arguments.content = 123
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe(
      'memory_arguments_unsupported'
    )
    expect(f.provider.evaluate).not.toHaveBeenCalled()
  })

  it('minimizes legacy memory evidence while binding the complete prepared record', async () => {
    const f = fixture()
    f.prepared.name = 'edit_memory'
    f.prepared.arguments = {
      id: 'memory-fixture',
      expectedRevision: 'ordinary-revision',
      content: 'Prefer concise answers'
    }
    f.prepared.before = {
      id: 'memory-fixture',
      content: 'Prefer examples',
      unrelatedLegacy: 'Unnecessary context'
    }
    f.prepared.after = { ...(f.prepared.after as object), unrelatedLegacy: 'Unnecessary context' }
    const snapshot = f.options.snapshot()
    expect(JSON.stringify(snapshot.inputData)).not.toContain('Unnecessary context')
    expect(JSON.stringify(snapshot.preparedAction)).not.toContain('Unnecessary context')
    const originalBinding = snapshot.resourceRevisions.preparedBinding
    const localAfter = f.prepared.after as Record<string, unknown>
    localAfter.unrelatedLegacy = 'Changed local context'
    expect(f.options.snapshot().resourceRevisions.preparedBinding).not.toBe(originalBinding)
  })

  it('keeps large exact review evidence local without truncation', async () => {
    const f = fixture()
    const originalSnapshot = f.options.snapshot
    const evidence = { plainFixture: 'x'.repeat(70_000) }
    f.options.snapshot = () => ({ ...originalSnapshot(), inputData: evidence })
    const review = await reviewAgentMutation(f.options)
    expect(review.automatic).toBe(false)
    expect(review.display.reasonCode).toBe('review_input_oversized')
    expect(evidence).toEqual({ plainFixture: 'x'.repeat(70_000) })
    expect(f.provider.evaluate).not.toHaveBeenCalled()
  })

  it.each(['resource', 'account', 'arguments', 'enrollment'] as const)(
    'invalidates changed %s while reviewing',
    async (change) => {
      const f = fixture()
      let release: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const original = f.provider.evaluate
      f.provider.evaluate = vi.fn(async (request, signal) => {
        await gate
        return original(request, signal)
      })
      const pending = reviewAgentMutation(f.options)
      await vi.waitFor(() => expect(f.provider.evaluate).toHaveBeenCalledTimes(1))
      if (change === 'resource') f.setResource('resource-fixture-2')
      if (change === 'account') f.account.revision = 'account-fixture-2'
      if (change === 'arguments') f.prepared.arguments.content = 'Different exact content'
      if (change === 'enrollment') f.enrollment.acknowledgedAt = '2026-10-08T02:00:00.000Z'
      release!()
      const result = await pending
      expect(result.automatic).toBe(false)
      expect(result.display.reasonCode).toBe('review_stale')
      expect(await result.beginCommit()).toBe(false)
      expect(f.ledger.record).not.toHaveBeenCalled()
    }
  )

  it('rechecks after the asynchronous precommit ledger write', async () => {
    const f = fixture()
    const result = await reviewAgentMutation(f.options)
    f.ledger.settle.mockImplementationOnce(async () => {
      f.setResource('changed-while-queued')
    })
    expect(await result.beginCommit()).toBe(false)
    expect(result.automatic).toBe(false)
  })

  it('falls back manually on refused or unknown-confidence output', async () => {
    const f = fixture()
    f.provider.evaluate = vi.fn(async (request) => ({
      model: f.provider.model,
      answers: request.policy.checks.map((check) => ({
        name: check.name,
        type: 'refusal' as const
      })),
      usage: { inputTokens: 20, outputTokens: 5 }
    }))
    const refused = await reviewAgentMutation(f.options)
    expect(refused.automatic).toBe(false)
    expect(refused.display.reasonCode).toBe('refusal')
    f.provider.evaluate = vi.fn(async () => ({
      model: f.provider.model,
      answers: [],
      usage: { inputTokens: 20, outputTokens: 5 }
    }))
    expect((await reviewAgentMutation(f.options)).display.reasonCode).toBe('invalid_response')
  })

  it('cancellation suppresses a late allow, without a retry or manual prompt', async () => {
    const f = fixture()
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = f.provider.evaluate
    f.provider.evaluate = vi.fn(async (request, signal) => {
      await gate
      return original(request, signal)
    })
    const pending = reviewAgentMutation(f.options)
    const cancelled = expect(pending).rejects.toThrow('cancelled')
    await vi.waitFor(() => expect(f.provider.evaluate).toHaveBeenCalledTimes(1))
    f.controller.abort()
    await cancelled
    release!()
    await Promise.resolve()
    expect(f.ledger.record).not.toHaveBeenCalled()
    expect(f.provider.evaluate).toHaveBeenCalledTimes(1)
  })

  it('uses one bounded deadline and manual fallback when output arrives late', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.provider.evaluate = vi.fn(
      async () => new Promise<Awaited<ReturnType<DecisionProvider['evaluate']>>>(() => {})
    )
    const pending = reviewAgentMutation(f.options)
    await vi.advanceTimersByTimeAsync(DECISION_TIMEOUT_MS + 1)
    const review = await pending
    expect(review.automatic).toBe(false)
    expect(review.display.reasonCode).toBe('timeout')
    expect(f.provider.evaluate).toHaveBeenCalledTimes(1)
  })

  it('keeps precommit audit failures manual and reports postcommit audit uncertainty', async () => {
    const before = fixture()
    before.ledger.record.mockRejectedValueOnce(new Error('offline store unavailable'))
    expect((await reviewAgentMutation(before.options)).automatic).toBe(false)
    const after = fixture()
    const review = await reviewAgentMutation(after.options)
    expect(await review.beginCommit()).toBe(true)
    after.ledger.settle.mockRejectedValueOnce(new Error('offline settlement unavailable'))
    expect(await review.settle('committed', '0123456789abcdef')).toBe(false)
    expect(review.display.auditUncertain).toBe(true)
    expect(after.ledger.suspend).toHaveBeenCalledTimes(1)
  })

  it('binds an explicitly accepted plan while excluding conversation history', async () => {
    const f = fixture()
    const snapshot = autoReviewSnapshot({
      sessionId: 'agent-fixture',
      runId: 'run-fixture',
      callId: 'call-fixture',
      userRequestId: 'request-fixture',
      userRequest: 'Implement the plan.',
      prepared: f.prepared,
      enrollment: f.enrollment,
      resourceRevisions: { resource: 'r1' },
      acceptedPlan: { text: 'Remember this preference.', binding: 'approved-plan-binding' }
    })
    expect(snapshot.userRequest.approvedScope).toMatchObject({
      acceptedPlan: { text: 'Remember this preference.', binding: 'approved-plan-binding' }
    })
    expect(Object.keys(snapshot)).not.toContain('history')
    expect(desktopDecisionPolicy('openai', true).checks.map((check) => check.name)).toContain(
      'durable_memory_intent'
    )
  })
})
