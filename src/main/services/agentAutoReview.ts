import { createHash, randomUUID } from 'node:crypto'
import {
  createDecisionRequest,
  evaluateDecision,
  isDecisionCurrent,
  routePreparedAction,
  createOpenAIDecisionProvider,
  createOpenRouterDecisionProvider,
  MAX_DECISION_BYTES,
  type DecisionProvider,
  type DecisionSnapshot,
  type DecisionResult,
  type PreparedActionMetadata
} from '@ayayaq/vivi/decisions'
import type { JsonObject } from '@ayayaq/vivi'
import type { AgentAutoReviewEnrollment, AgentDecisionDisplay } from '../../shared/agentAutoReview'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import type { AgentValidationReport } from '../../shared/agentValidationTypes'
import type { PreparedMutation } from './agentTools'
import { checkAutoEligibility } from './agentAutoEligibility'
import { resourceRevision } from './resourceChangeService'
import {
  desktopDecisionPolicy,
  DECISION_TIMEOUT_MS,
  MAX_DECISION_REQUESTS_PER_RUN
} from './agentDecisionPolicy'
import { decisionPrivacyReason } from './agentDecisionPrivacy'
import { agentDecisionLedger, type AgentDecisionLedgerRow } from './agentDecisionLedger'

export function decisionBinding(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, canonical(value)])
      )
    return item
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

export interface AgentAutoReviewContext {
  requests: number
}

function memoryArgumentsSupported(prepared: PreparedMutation): boolean {
  const allowed =
    prepared.name === 'create_memory' ? ['content'] : ['id', 'expectedRevision', 'content']
  const args = prepared.arguments
  return (
    !Object.keys(args).some((key) => !allowed.includes(key)) &&
    typeof args.content === 'string' &&
    (prepared.name !== 'edit_memory' ||
      (typeof args.id === 'string' && typeof args.expectedRevision === 'string'))
  )
}
interface ReviewOptions {
  prepared: PreparedMutation
  validation?: AgentValidationReport
  enrollment?: AgentAutoReviewEnrollment
  context: AgentAutoReviewContext
  signal: AbortSignal
  /** Rebuilds host revisions and exact current inputs; never derives authority from history. */
  snapshot: () => DecisionSnapshot
  account: () => { provider: 'openai' | 'openrouter'; revision: string; apiKey: string }
  assertActive: () => void
  provider?: DecisionProvider
  ledger?: Pick<
    typeof agentDecisionLedger,
    'available' | 'assertAutomaticAdmission' | 'record' | 'settle' | 'suspend'
  >
}
export interface AgentAutoReviewResult {
  display: AgentDecisionDisplay
  automatic: boolean
  assertCurrent: (prepared: PreparedMutation) => void
  beginCommit: () => Promise<boolean>
  settle: (
    state: 'committed' | 'denied' | 'cancelled' | 'failed',
    revision?: string,
    source?: AgentDecisionDisplay['source']
  ) => Promise<boolean>
}

/** Model recommendations supplement host admission. This module has no executor. */
export async function reviewAgentMutation(options: ReviewOptions): Promise<AgentAutoReviewResult> {
  const { prepared, signal, context, enrollment } = options
  const ledger = options.ledger ?? agentDecisionLedger
  const display: AgentDecisionDisplay = {
    id: randomUUID(),
    policyRevision: AUTO_REVIEW_POLICY_REVISION,
    reasonCode: 'enrollment_required',
    recommendation: 'ask',
    source: 'manual'
  }
  let result: DecisionResult
  let captured: DecisionSnapshot
  let recorded = false
  let consumed = false
  const assertCurrent = (candidate: PreparedMutation): void => {
    options.assertActive()
    if (signal.aborted) throw new Error('Agent execution cancelled')
    ledger.assertAutomaticAdmission({
      provider: options.account().provider,
      accountRevision: options.account().revision,
      policyRevision: AUTO_REVIEW_POLICY_REVISION
    })
    const current = options.snapshot()
    if (
      !result ||
      !captured ||
      !checkAutoEligibility(candidate, options.validation).eligible ||
      routePreparedAction(current).route !== 'model-review' ||
      !isDecisionCurrent(result, current) ||
      decisionBinding(candidate) !== decisionBinding(prepared)
    )
      throw new Error('Auto review is stale; review the exact current change again')
    if (decisionPrivacyReason(captured)) throw new Error('Auto review privacy preflight changed')
  }
  const finish = (): AgentAutoReviewResult => ({
    display,
    get automatic() {
      return display.source === 'automatic'
    },
    assertCurrent,
    async beginCommit() {
      if (!recorded || consumed) return false
      try {
        assertCurrent(prepared)
        await ledger.settle(
          display.id,
          { state: 'commit_started', source: 'automatic' },
          {
            provider: options.account().provider,
            accountRevision: options.account().revision,
            policyRevision: AUTO_REVIEW_POLICY_REVISION
          }
        )
        assertCurrent(prepared)
        consumed = true
        return true
      } catch {
        display.source = 'manual'
        display.reasonCode = 'audit_or_binding_unavailable'
        return false
      }
    },
    async settle(state, revision, source) {
      if (source) display.source = source
      if (!recorded) return true
      try {
        await ledger.settle(display.id, {
          state,
          source: display.source,
          settledAt: new Date().toISOString(),
          ...(revision ? { resultingRevision: revision } : {})
        })
        return true
      } catch {
        display.auditUncertain = true
        ledger.suspend()
        return false
      }
    }
  })
  const account = options.account()
  if (
    !enrollment ||
    enrollment.policyRevision !== AUTO_REVIEW_POLICY_REVISION ||
    enrollment.provider !== account.provider ||
    enrollment.accountRevision !== account.revision
  )
    return finish()
  const eligibility = checkAutoEligibility(prepared, options.validation)
  if (!eligibility.eligible) {
    display.reasonCode = eligibility.reasonCode
    return finish()
  }
  if (prepared.target.type === 'memory' && !memoryArgumentsSupported(prepared)) {
    display.reasonCode = 'memory_arguments_unsupported'
    return finish()
  }
  if (!account.apiKey.trim()) {
    display.reasonCode = 'reviewer_unavailable'
    return finish()
  }
  if (context.requests >= MAX_DECISION_REQUESTS_PER_RUN) {
    display.reasonCode = 'review_budget_exhausted'
    return finish()
  }
  options.assertActive()
  try {
    const snapshot = options.snapshot()
    const policy = desktopDecisionPolicy(account.provider, prepared.target.type === 'memory')
    if (Buffer.byteLength(JSON.stringify({ snapshot, policy })) > MAX_DECISION_BYTES) {
      display.reasonCode = 'review_input_oversized'
      return finish()
    }
    const request = createDecisionRequest(snapshot, policy)
    const route = routePreparedAction(request.snapshot)
    if (route.route !== 'model-review') {
      display.reasonCode = route.reasonCode
      return finish()
    }
    captured = request.snapshot as unknown as DecisionSnapshot
    const privacy = decisionPrivacyReason(captured)
    if (privacy) {
      display.reasonCode = privacy
      return finish()
    }
    if (
      !(await ledger.available({
        provider: account.provider,
        accountRevision: account.revision,
        policyRevision: AUTO_REVIEW_POLICY_REVISION
      }))
    ) {
      display.reasonCode = 'audit_recovery_required'
      return finish()
    }
    options.assertActive()
    const beforeProvider = (): string => {
      options.assertActive()
      const current = options.account()
      const currentSnapshot = options.snapshot()
      if (
        signal.aborted ||
        current.provider !== account.provider ||
        current.revision !== account.revision ||
        current.apiKey !== account.apiKey ||
        routePreparedAction(currentSnapshot).route !== 'model-review' ||
        decisionBinding(currentSnapshot) !== decisionBinding(captured) ||
        decisionPrivacyReason(captured)
      )
        throw new Error('Review inputs changed before provider admission')
      return account.apiKey
    }
    const transport: typeof fetch = (input, init) => {
      beforeProvider()
      return fetch(input, init)
    }
    const provider =
      options.provider ??
      (account.provider === 'openai'
        ? createOpenAIDecisionProvider({
            apiKey: beforeProvider,
            timeoutMs: DECISION_TIMEOUT_MS,
            fetch: transport
          })
        : createOpenRouterDecisionProvider({
            apiKey: beforeProvider,
            timeoutMs: DECISION_TIMEOUT_MS,
            fetch: transport
          }))
    beforeProvider()
    context.requests++
    result = await evaluateDecision(request, provider, { signal, timeoutMs: DECISION_TIMEOUT_MS })
    options.assertActive()
    if (signal.aborted || result.reasonCode === 'aborted')
      throw new Error('Agent execution cancelled')
    display.provider = account.provider
    display.model = account.provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13'
    display.reasonCode = result.reasonCode
    display.recommendation = result.outcome
    display.checks = result.checks.map(({ name, probability }) => ({ name, probability }))
    if (result.usage) display.usage = { ...result.usage }
    try {
      assertCurrent(prepared)
    } catch {
      display.reasonCode = 'review_stale'
      return finish()
    }
    const row: AgentDecisionLedgerRow = {
      ...display,
      sessionId: captured.sessionId,
      runId: captured.runId,
      callBinding: decisionBinding(captured.toolCall.id),
      tool: prepared.name as AgentDecisionLedgerRow['tool'],
      snapshotBinding: decisionBinding(captured),
      targetType: prepared.target.type as 'command' | 'memory',
      targetId: prepared.target.id,
      candidateRevision: prepared.after === null ? undefined : resourceRevision(prepared.after),
      state: 'reviewed',
      createdAt: new Date().toISOString()
    }
    await ledger.record(row)
    recorded = true
    assertCurrent(prepared)
    if (result.outcome === 'allow') display.source = 'automatic'
    return finish()
  } catch {
    options.assertActive()
    if (signal.aborted) throw new Error('Agent execution cancelled')
    display.reasonCode = 'review_configuration_or_audit_unavailable'
    display.recommendation = 'ask'
    return finish()
  }
}

export function autoReviewSnapshot(input: {
  sessionId: string
  runId: string
  callId: string
  userRequestId: string
  userRequest: string
  prepared: PreparedMutation
  enrollment: AgentAutoReviewEnrollment
  resourceRevisions: JsonObject
  validation?: AgentValidationReport
  acceptedPlan?: { text: string; binding: string }
}): DecisionSnapshot {
  const { prepared, validation } = input
  const reviewData = (value: unknown): JsonObject | null => {
    if (value === null) return null
    if (prepared.target.type === 'memory') {
      const memory = value as { id: string; content: string }
      return { id: memory.id, content: memory.content }
    }
    return value as JsonObject
  }
  const snapshot: DecisionSnapshot = {
    sessionId: input.sessionId,
    runId: input.runId,
    toolCall: {
      id: input.callId,
      name: prepared.name,
      arguments: prepared.arguments as JsonObject
    },
    userRequest: {
      id: input.userRequestId,
      text: input.userRequest,
      approvedScope: {
        profile: 'ordinary_memory_and_validated_response_commands',
        enrollment: { ...input.enrollment },
        ...(input.acceptedPlan ? { acceptedPlan: input.acceptedPlan } : {})
      }
    },
    policyRevision: AUTO_REVIEW_POLICY_REVISION,
    resourceRevisions: {
      ...input.resourceRevisions,
      preparedBinding: decisionBinding(prepared),
      validationBinding: validation ? decisionBinding(validation) : null
    },
    inputData: {
      normalizedBefore: reviewData(prepared.before),
      normalizedAfter: reviewData(prepared.after),
      validationSummary: validation
        ? {
            outcome: validation.outcome,
            coverage: validation.coverage,
            timedOut: validation.timedOut,
            cancelled: validation.cancelled,
            truncated: validation.truncated,
            candidateHash: validation.candidateHash,
            baseRevision: validation.baseRevision,
            fixtureHash: validation.fixtureHash,
            wrapEvalInIIFE: validation.wrapEvalInIIFE
          }
        : null
    }
  }
  // Only the existing host validator can classify these prepared mutations.
  // Tool arguments, fixture prose and model output never supply effect metadata.
  const eligibility = checkAutoEligibility(prepared, validation)
  const target = prepared.target
  const resourceId = `desktop:${target.type}:${target.id ?? ''}`
  const evidence = snapshot.inputData as JsonObject
  const normalizedAfter = evidence.normalizedAfter as JsonObject | null
  const normalizedBefore = evidence.normalizedBefore as JsonObject | null
  const resolved =
    typeof target.id === 'string' &&
    !!target.id &&
    typeof input.resourceRevisions.resource === 'string' &&
    !!input.resourceRevisions.resource &&
    normalizedAfter?.id === target.id &&
    (prepared.name === 'create_memory' || prepared.name === 'create_command'
      ? normalizedBefore === null
      : normalizedBefore?.id === target.id)
  const complete =
    eligibility.eligible &&
    resolved &&
    (target.type !== 'memory' ||
      (memoryArgumentsSupported(prepared) &&
        typeof normalizedAfter.content === 'string' &&
        (normalizedBefore === null || typeof normalizedBefore.content === 'string')))
  const effects: PreparedActionMetadata['effects'][number][] = []
  if (resolved) {
    effects.push({
      kind: 'write',
      resourceId,
      scope: 'outside-workspace',
      affectedData: {
        normalizedBefore,
        normalizedAfter,
        persistence: target.type === 'memory' ? 'app-wide-memory' : 'live-bot-configuration'
      },
      review: complete ? 'model-review' : 'manual'
    })
    if (target.type === 'command')
      effects.push({
        kind: 'external',
        resourceId,
        scope: 'external',
        affectedData: {
          effect: 'configured-future-message-response',
          immediateDiscordSend: false,
          candidateBinding: snapshot.resourceRevisions.preparedBinding,
          validationBinding: snapshot.resourceRevisions.validationBinding
        },
        review: complete ? 'model-review' : 'manual'
      })
    snapshot.resourceRevisions[resourceId] = {
      resource: input.resourceRevisions.resource,
      hostRuntime: input.resourceRevisions.hostRuntime ?? null,
      preparedBinding: snapshot.resourceRevisions.preparedBinding,
      validationBinding: snapshot.resourceRevisions.validationBinding
    }
  }
  // No aliases to prepared records survive in the host metadata. The shared
  // request capture then deeply freezes the entire exact snapshot for review.
  const freeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  snapshot.preparedAction = freeze(structuredClone({ complete, effects }))
  return snapshot
}
