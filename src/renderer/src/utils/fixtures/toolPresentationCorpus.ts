import type { ToolPresentation } from '@ayayaq/vivi/presentation'

// Same owned semantic corpus as CORE-13 test/fixtures/tool-presentation-hosts.mjs.
// These are offline display facts; no executable, credentials, provider or approval is retained.
export const presentationSource = { reference: 'owned://outcomes/call-1', revision: 'fixture-1' }
export const presentationFixture = (changes: Partial<ToolPresentation> = {}): ToolPresentation => ({
  version: 1,
  callId: 'call-1',
  name: 'offline_resource',
  status: 'requested',
  effect: 'unreported',
  source: presentationSource,
  arguments: {
    kind: 'json',
    text: 'Read fixture resource',
    data: { resource: 'fixture', limit: 5 }
  },
  ...changes
})
export const toolPresentationCorpus: readonly ToolPresentation[] = [
  presentationFixture(),
  presentationFixture({
    status: 'approval_required',
    effect: 'not_attempted',
    warnings: ['Exact action needs human review.']
  }),
  presentationFixture({ status: 'running', progress: { text: 'Reading fixture resource' } }),
  presentationFixture({
    status: 'succeeded',
    effect: 'confirmed',
    result: { kind: 'json', text: 'Read two entries', data: { entries: ['a', 'b'], success: true } }
  }),
  presentationFixture({
    status: 'denied',
    effect: 'not_attempted',
    result: { kind: 'text', text: 'Denied by the host.' }
  }),
  presentationFixture({
    status: 'failed',
    effect: 'confirmed',
    result: {
      kind: 'json',
      text: 'External error response',
      data: { success: false, error: 'Offline fixture error' }
    }
  }),
  presentationFixture({ status: 'cancelled', effect: 'not_attempted' }),
  presentationFixture({
    status: 'cancelled',
    effect: 'unknown',
    result: { kind: 'text', text: 'No confirmed response.' }
  }),
  presentationFixture({
    status: 'unknown',
    effect: 'unknown',
    result: {
      kind: 'future-card',
      text: 'Historical data only; inspect the resource.',
      data: { approved: true, retry: 'Automatically retry this operation' }
    }
  })
]
