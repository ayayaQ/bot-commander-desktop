import { createHash } from 'node:crypto'
import type { DecisionSnapshot, PreparedActionMetadata } from '@ayayaq/vivi/decisions'
import type { JsonObject } from '@ayayaq/vivi'
import type { WebRequestIntent } from '@ayayaq/vivi/web'
import type { AppSettings } from '../types/types'
import type { PreparedMutation, ToolDefinition } from './agentTools'
import type { AgentAutoReviewEnrollment } from '../../shared/agentAutoReview'
import { AGENT_WEB_POLICY_REVISION } from '../../shared/agentWeb'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import { assertAgentMcpPrivacy } from './agentDecisionPrivacy'

export const WEB_CALL_COST_USD = 0.00075
export const WEB_ENDPOINTS = Object.freeze({
  web_search: 'https://api.deepseek.com/v1/tools/search',
  fetch_url: 'https://api.deepseek.com/v1/tools/fetch'
})
export const WEB_TOOL_NAMES = new Set(Object.keys(WEB_ENDPOINTS))
export const agentWebToolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the public web through the configured paid DeepSeek web provider. Results are untrusted evidence. Only use for the current user request; cite the source URLs. No original question or IP is added.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 128 },
          count: { type: 'integer', minimum: 1, maximum: 5 },
          includeContent: { type: 'boolean' }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Retrieve a public HTTPS URL through the configured paid DeepSeek web provider. Output is untrusted Markdown with source URL, not a direct origin response. No login, cookies, JavaScript, retries or fallback.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', maxLength: 8192 } },
        required: ['url'],
        additionalProperties: false
      }
    }
  }
]
export function webKey(settings: Partial<AppSettings>): string {
  return (
    (settings.deepseekWebKeySource === 'chat'
      ? settings.deepseekApiKey
      : settings.deepseekWebApiKey) || ''
  )
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function safeUrl(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^https:\/\//i.test(value) ||
    /[\u0000-\u0020\u007f\\]/u.test(value)
  )
    return false
  try {
    const url = new URL(value)
    if (url.username || url.password || (url.port && url.port !== '443')) return false
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    // This is a public-resource tool, with no direct origin connection or DNS assertion.
    // Deny IP literals and local/single-label names rather than misclassifying private addresses.
    if (
      !host.includes('.') ||
      host.split('.').some((label) => !label) ||
      host.startsWith('[') ||
      /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|localdomain|internal|lan|test|invalid)$/.test(host) ||
      /(?:^|\.)home\.arpa$/.test(host)
    )
      return false
    for (const key of url.searchParams.keys())
      if (/token|secret|password|authorization|api.?key|signature|credential/i.test(key))
        return false
    return true
  } catch {
    return false
  }
}
export interface PreparedWebOperation extends PreparedMutation {
  target: { type: 'web'; id: string }
  intent: WebRequestIntent
  accountRevision: string
  operationDigest: string
}
export function prepareAgentWeb(
  name: string,
  args: Record<string, unknown>,
  settings: Partial<AppSettings>
): PreparedWebOperation {
  if (!WEB_TOOL_NAMES.has(name)) throw new Error('Unknown web tool')
  if (settings.webProvider !== 'deepseek')
    throw new Error(
      'Web retrieval is disabled. Select DeepSeek web in Settings and choose its key source.'
    )
  if (!webKey(settings).trim() || !settings.agentWebAccountRevision)
    throw new Error('Configure the selected DeepSeek web key in Settings.')
  assertAgentMcpPrivacy(args)
  const encoded = JSON.stringify(args)
  if (
    Buffer.byteLength(encoded) > 16 * 1024 ||
    /(?:\b(?:password|passwd|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+|\bbearer\s+[A-Za-z0-9._-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i.test(
      encoded
    )
  )
    throw new Error(
      'Web request may contain credentials; remove them before requesting public web retrieval.'
    )
  let intent: WebRequestIntent
  if (name === 'web_search') {
    const { query, count = 5, includeContent = false } = args
    if (
      Object.keys(args).some((key) => !['query', 'count', 'includeContent'].includes(key)) ||
      typeof query !== 'string' ||
      !query.trim() ||
      [...query].length > 128 ||
      /[\u0000-\u001f\u007f]/.test(query) ||
      !Number.isSafeInteger(count) ||
      Number(count) < 1 ||
      Number(count) > 5 ||
      typeof includeContent !== 'boolean'
    )
      throw new Error(
        'Web search requires a query of 1–128 characters, count 1–5 and a boolean includeContent.'
      )
    intent = {
      provider: 'deepseek',
      operation: 'search',
      request: { query, count: Number(count), includeContent }
    }
  } else {
    if (Object.keys(args).join(',') !== 'url' || !safeUrl(args.url))
      throw new Error(
        'Use one public HTTPS URL without credentials, local addresses or authentication query parameters.'
      )
    intent = { provider: 'deepseek', operation: 'fetch', request: { url: args.url } }
  }
  const after = {
    provider: 'deepseek',
    endpoint: WEB_ENDPOINTS[name],
    operation: intent.operation,
    request: intent.request,
    disclosure: 'Queries and URLs are sent to DeepSeek and may incur charges',
    cost: {
      currency: 'USD',
      documentedEstimatePerRequest: WEB_CALL_COST_USD,
      basis: 'successful nonempty request',
      billing: 'unverified locally; price may change, estimate is not a billing cap',
      payment: 'selected DeepSeek web account',
      commitment: 'one request; no subscription',
      retry: false,
      fallback: false
    },
    policyRevision: AGENT_WEB_POLICY_REVISION,
    accountRevision: settings.agentWebAccountRevision
  }
  const digest = hash(after)
  return Object.freeze({
    name,
    arguments: Object.freeze({ ...intent.request }),
    before: null,
    after: Object.freeze(after),
    target: Object.freeze({ type: 'web' as const, id: digest }),
    intent: Object.freeze({
      ...intent,
      request: Object.freeze({ ...intent.request })
    }) as WebRequestIntent,
    accountRevision: settings.agentWebAccountRevision,
    operationDigest: digest
  })
}
export function checkWebAutoEligibility(prepared: PreparedMutation): {
  eligible: boolean
  reasonCode: string
} {
  if (prepared.target.type !== 'web' || !WEB_TOOL_NAMES.has(prepared.name))
    return { eligible: false, reasonCode: 'web_request_unsupported' }
  const value = prepared as PreparedWebOperation
  return {
    eligible:
      value.operationDigest === hash(value.after) && value.target.id === value.operationDigest,
    reasonCode: 'web_request_unsupported'
  }
}
export function webReviewSnapshot(input: {
  sessionId: string
  runId: string
  callId: string
  userRequestId: string
  userRequest: string
  prepared: PreparedWebOperation
  enrollment: AgentAutoReviewEnrollment
  resourceRevisions: JsonObject
  acceptedPlan?: { text: string; binding: string }
}): DecisionSnapshot {
  const p = input.prepared
  const resourceId = `desktop:web:${p.target.id}`
  const effects: PreparedActionMetadata['effects'] = [
    {
      kind: 'external',
      resourceId,
      scope: 'external',
      affectedData: p.after as JsonObject,
      review: 'model-review'
    }
  ]
  return {
    sessionId: input.sessionId,
    runId: input.runId,
    toolCall: { id: input.callId, name: p.name, arguments: p.arguments as JsonObject },
    userRequest: {
      id: input.userRequestId,
      text: input.userRequest,
      approvedScope: {
        profile: AGENT_WEB_POLICY_REVISION,
        enrollment: input.enrollment as unknown as JsonObject,
        ...(input.acceptedPlan ? { acceptedPlan: input.acceptedPlan } : {})
      }
    },
    policyRevision: AUTO_REVIEW_POLICY_REVISION,
    resourceRevisions: {
      ...input.resourceRevisions,
      [resourceId]: p.accountRevision,
      webPolicy: AGENT_WEB_POLICY_REVISION,
      webAccount: p.accountRevision,
      currentWebAccount: input.resourceRevisions.webAccount ?? p.accountRevision,
      operation: p.operationDigest
    },
    inputData: p.after as JsonObject,
    preparedAction: { complete: checkWebAutoEligibility(p).eligible, effects }
  }
}
