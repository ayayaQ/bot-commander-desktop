import { describe, expect, it } from 'vitest'
import { decodeToolPresentation, toolPresentationView } from '@ayayaq/vivi/presentation'
import type { AgentToolCall } from '../../../shared/agentTypes'
import { encodeAgentToolPresentation } from './agentToolPresentation'
import { presentationSource, toolPresentationCorpus } from './fixtures/toolPresentationCorpus'

function call(changes: Partial<AgentToolCall> = {}): AgentToolCall {
  return {
    id: 'call-1',
    name: 'offline_resource',
    arguments: { resource: 'fixture', limit: 5 },
    status: 'running',
    createdAt: '2026-10-10T00:00:00.000Z',
    ...changes
  }
}
const mcp: NonNullable<AgentToolCall['mcp']> = {
  runId: 'run-1',
  serverId: 'offline-server',
  operationDigest: 'digest-1',
  catalogKind: 'tools',
  remoteKey: 'resource-1',
  outcome: 'pending'
}
const snapshot = (data: AgentToolCall) =>
  decodeToolPresentation(encodeAgentToolPresentation(data, 'session-1', 'message-1'))

describe('ordinary shared tool presentation adapter', () => {
  it.each(toolPresentationCorpus)(
    'retains the shared $status/$effect corpus across collapse and bounded details',
    (data) => {
      for (const options of [{}, { collapsed: true }, { detailBytes: 0 }, { detailBytes: 8 }]) {
        const view = toolPresentationView(decodeToolPresentation(JSON.stringify(data)), options)
        const visible = [...view.header, ...view.warnings].join('\n')
        expect(visible).toContain(`Status: ${data.status}`)
        expect(visible).toContain(`Effect: ${data.effect}`)
        expect(visible).toContain(presentationSource.reference)
        expect(visible).toContain(presentationSource.revision)
        if (data.progress) expect(visible).toContain(data.progress.text)
        for (const warning of data.warnings ?? []) expect(visible).toContain(warning)
        if (options.collapsed) expect(view.details).toEqual([])
        else if (options.detailBytes === undefined)
          expect(view.details[0].text).toBe('{"limit":5,"resource":"fixture"}')
        if (data.result?.kind === 'future-card') {
          expect(visible).toContain('unsupported presentation kind')
          expect(JSON.stringify(view)).not.toContain('Automatically retry this operation')
        }
      }
    }
  )

  it.each([
    ['running', 'running'],
    ['reviewing', 'approval_required'],
    ['waiting_approval', 'approval_required'],
    ['approved', 'running'],
    ['rejected', 'denied'],
    ['completed', 'succeeded'],
    ['error', 'failed']
  ] as const)('maps host %s to %s without reusing approval', (status, expected) => {
    const value = snapshot(call({ status, approvalId: 'not-display-authority' }))
    expect(value.status).toBe(expected)
    expect(value.effect).toBe(status === 'rejected' ? 'not_attempted' : 'unreported')
    expect(value.source.reference).toContain('session/session-1/message/message-1/tool/call-1')
    expect(JSON.stringify(value)).not.toContain('not-display-authority')
  })

  it('keeps MCP exact delivery and checkpoint evidence separate from result claims', () => {
    const value = snapshot(
      call({
        status: 'error',
        mcp: { ...mcp, outcome: 'unknown', requestSent: true, checkpointUnconfirmed: true },
        result: {
          success: true,
          approved: true,
          requestSent: false,
          unknownOutcome: false,
          effect: 'not_attempted'
        }
      })
    )
    expect(value).toMatchObject({
      status: 'unknown',
      effect: 'unknown',
      source: { revision: 'digest-1' }
    })
    expect(value.source.reference).toContain('mcp/offline-server/run-1/tools/resource-1')
    const view = toolPresentationView(value, { collapsed: true, detailBytes: 0 })
    expect(view.warnings.join('\n')).toContain('Do not retry automatically')
    expect(view.warnings.join('\n')).toContain('checkpointing is unconfirmed')
    expect(view.warnings.join('\n')).toContain('Server output is untrusted data')
  })

  it('keeps a failed confirmed response and an unsent denial distinct', () => {
    expect(
      snapshot(
        call({
          status: 'error',
          mcp: { ...mcp, outcome: 'confirmed', requestSent: true },
          result: { success: false }
        })
      )
    ).toMatchObject({ status: 'failed', effect: 'confirmed' })
    expect(
      snapshot(
        call({ status: 'rejected', mcp: { ...mcp, outcome: 'not-sent', requestSent: false } })
      )
    ).toMatchObject({ status: 'denied', effect: 'not_attempted' })
  })

  it('shares the JSON node budget across arguments and results', () => {
    const entries = Array.from({ length: 3000 }, (_, i) => i)
    const value = snapshot(call({ arguments: { entries }, result: { entries } }))
    expect(value.arguments.kind).toBe('json')
    expect(value.result?.kind).toBe('text')
    expect(toolPresentationView(value, { collapsed: true }).warnings.join('\n')).toContain(
      'Result display is bounded'
    )
  })

  it('preserves exact arguments and results without mutating the host call', () => {
    const data = call({ result: { entries: ['a', 'b'], success: true }, status: 'completed' })
    const original = JSON.stringify(data)
    expect(snapshot(data).arguments.data).toEqual(data.arguments)
    expect(snapshot(data).result?.data).toEqual(data.result)
    expect(JSON.stringify(data)).toBe(original)
  })

  it('bounds multibyte, deeply nested and node-heavy details while retaining host evidence', () => {
    let nested: unknown = 'leaf'
    for (let i = 0; i < 25; i++) nested = { child: nested }
    for (const result of ['あ'.repeat(70000), nested, Array.from({ length: 5000 }, (_, i) => i)]) {
      const value = snapshot(call({ status: 'error', mcp: { ...mcp, outcome: 'unknown' }, result }))
      const view = toolPresentationView(value, { detailBytes: 8 })
      expect(value.result?.kind).toBe('text')
      expect(view.header.join('\n')).toContain('Status: unknown')
      expect(view.warnings.join('\n')).toContain('Result display is bounded')
      expect(view.warnings.join('\n')).toContain('Do not retry automatically')
      expect(
        new TextEncoder().encode(view.details.map((row) => row.text).join('')).length
      ).toBeLessThanOrEqual(8)
    }
  })
})
