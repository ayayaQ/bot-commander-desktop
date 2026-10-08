import { describe, expect, it } from 'vitest'
import { routePreparedAction, type DecisionSnapshot } from '@ayayaq/vivi/decisions'
import fixtures from './fixtures/preparedActionRoutes.json'

// The CLI consumes the same domain-neutral fixture bytes. No host action is
// executed here; literal resource IDs are opaque revision keys, not paths.
describe('shared prepared-action routing contract', () => {
  it.each(fixtures)('$name', ({ name: _name, expected, ...metadata }) => {
    const snapshot = {
      sessionId: 'fixture-session',
      runId: 'fixture-run',
      toolCall: { id: 'fixture-call', name: 'existing_tool', arguments: {} },
      userRequest: { id: 'fixture-request', text: 'Current request', approvedScope: {} },
      policyRevision: 'fixture-policy',
      resourceRevisions: { 'literal:notes/../target': 'revision-1' },
      inputData: {},
      ...metadata
    } as DecisionSnapshot
    const before = structuredClone(snapshot)
    const result = routePreparedAction(snapshot)
    expect(result).toEqual(expected)
    expect(Object.isFrozen(result)).toBe(true)
    expect(snapshot).toEqual(before)
  })
})
