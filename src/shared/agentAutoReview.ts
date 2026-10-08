import type { AgentProvider } from './agentTypes'

export const AUTO_REVIEW_POLICY_REVISION = 'desktop-reviewed-auto-v2'

export interface AgentAutoReviewEnrollment {
  policyRevision: string
  provider: AgentProvider
  accountRevision: string
  acknowledgedAt: string
}

export interface AgentDecisionAuditInspection {
  id: string
  policyRevision: string
  provider: AgentProvider
  accountRevision: string
  inspectedAt: string
  canAcknowledge: boolean
  reasonCode?: string
  rows: Array<{
    id: string
    tool: string
    targetType?: 'command' | 'memory'
    targetId?: string
    outcome: 'unknown'
    candidateRevision?: string
    currentTargetRevision?: string | null
    currentResourceRevision?: string
  }>
}

/** Privacy-safe local display. No provider explanation or request body belongs here. */
export interface AgentDecisionDisplay {
  id: string
  policyRevision: string
  provider?: AgentProvider
  model?: string
  reasonCode: string
  recommendation: 'allow' | 'ask' | 'deny'
  source: 'automatic' | 'manual' | 'human_once' | 'human_rejected'
  checks?: Array<{ name: string; probability: number }>
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    costUsd?: number
  }
  auditUncertain?: boolean
}

export const AUTO_REVIEW_DISCLOSURE =
  'Auto review can approve create/edit app-wide persistent memories and fully validated response-only message commands ' +
  'for your current request. Command saves change the live bot configuration. ' +
  'Deletes, moderation, roles, scripts, settings, interactions and bot state still need manual review. ' +
  'Your exact request, proposed memory or command text, action and minimal validation evidence go to the selected account: ' +
  'OpenAI gpt-6-luna, or OpenRouter and TypeSafe typesafe/jev-1.13. ' +
  'This can include private details in your request or proposed text. Known credentials are excluded, ' +
  'and recognized sensitive content stays local for manual review. The filter cannot identify every private detail; ' +
  'only enable this if you consent to sharing the review text with those recipients. ' +
  'Each eligible change uses an extra paid request, at most two per run, with no retries. ' +
  'Initial thresholds are uncalibrated heuristics; the model can be wrong. ' +
  'Uncertainty or an unavailable reviewer falls back to manual approval. ' +
  'Behavioral validation is bounded offline simulation, not a security sandbox or proof of live delivery.'

export function autoReviewReasonLabel(code: string): string {
  const labels: Record<string, string> = {
    enrollment_required:
      'A current acknowledgment is required. Review this change manually or reopen Auto review.',
    reviewer_unavailable:
      'The fixed reviewer is unavailable. You can review the exact change manually.',
    review_budget_exhausted:
      'The two-review run limit is reached. Further changes need manual approval.',
    audit_recovery_required:
      'The local audit needs recovery. Use Manual and inspect current resources before another change.',
    audit_or_binding_unavailable:
      'The audit or exact change binding could not be confirmed. Review the current state manually.',
    review_input_oversized:
      'The exact input is too large for review. It was not truncated; use manual approval.',
    review_configuration_or_audit_unavailable:
      'Reviewer configuration or audit persistence is unavailable. Review this change manually.',
    review_stale:
      'The action, resource or reviewer changed. Read current state and propose a fresh change.',
    privacy_known_secret: 'A known credential appears in the proposed review data. It stays local.',
    privacy_sensitive_or_uncertain:
      'A recognized private-content pattern was found. The review stays local.',
    privacy_registry_unavailable:
      'The local privacy preflight is unavailable. The review stays local.',
    provider_recommended_reject:
      'The model recommends rejection. The app still permits an exact one-time human review.',
    uncertain:
      'The model estimates did not meet every approval threshold. Review the exact change manually.',
    requirements_met:
      'Every model estimate met its configured initial threshold. This is not proof of authorization or safety.',
    timeout: 'The reviewer timed out. No retry was made; use manual approval.',
    rate_limit: 'The reviewer was rate limited. No retry was made; use manual approval.',
    refusal: 'The reviewer declined this request. Use manual approval.',
    transport: 'The reviewer could not be reached. No retry was made; use manual approval.'
  }
  return (
    labels[code] ??
    'This change is outside the automatic review profile or lacks complete review evidence. Use the exact manual diff.'
  )
}
