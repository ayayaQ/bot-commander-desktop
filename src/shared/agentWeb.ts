export const AGENT_WEB_POLICY_REVISION = 'desktop-paid-web-v1'
export const AGENT_WEB_DISCLOSURE =
  'Queries and URLs are sent to DeepSeek and may incur charges. ' +
  'Auto review may approve only web retrieval needed for your current request, using the exact query or public HTTPS URL shown. ' +
  'The selected OpenAI or OpenRouter reviewer receives your request and the exact proposed web request and cost scope. ' +
  'DeepSeek receives the query and result-count/content choice, or the URL, plus ordinary API/network metadata; no original question or localization IP is added. ' +
  'The documented price is US$0.00075 per successful nonempty request, billed to your selected DeepSeek web account; actual billing is unverified and the estimate may change; it is not a billing cap. ' +
  'At most two automatic reviews are made per run across web and changes, with no retries or fallback. ' +
  'Private or uncertain review text stays local for exact manual review. Plan mode stays local-only.'

export interface AgentWebEnrollment {
  policyRevision: string
  accountRevision: string
}

/** Display/recovery facts, never reusable authorization. */
export interface AgentWebCallEvidence {
  runId: string
  operationDigest: string
  provider: 'deepseek'
  requestState: 'not_started' | 'unknown' | 'response_received'
  outcome: 'pending' | 'not-sent' | 'confirmed' | 'unknown'
  intentAt?: string
  settledAt?: string
  checkpointUnconfirmed?: boolean
}
