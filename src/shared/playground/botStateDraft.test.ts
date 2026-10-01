import { describe, expect, it } from 'vitest'
import { formatBotStateDraft, parseBotStateDraft } from './botStateDraft'
import { PLAYGROUND_LIMITS } from './types'

describe('offline bot-state draft helpers (headless unit tests)', () => {
  it('parses an independent JSON object without changing the committed state', () => {
    const committed = { counter: 2, nested: { values: [null, true, 'offline'] } }
    const draft = formatBotStateDraft(committed)
    const applied = parseBotStateDraft(draft)
    expect(applied).toEqual(committed)
    expect(applied).not.toBe(committed)
    applied.counter = 3
    expect(committed.counter).toBe(2)
  })

  it('formats committed script changes and reset state instead of reusing stale draft text', () => {
    const oldDraft = '{"counter":1}'
    const scriptState = { counter: 2, writtenByScript: true }
    const refreshed = formatBotStateDraft(scriptState)
    expect(parseBotStateDraft(refreshed)).toEqual(scriptState)
    expect(parseBotStateDraft(oldDraft)).toEqual({ counter: 1 })
    expect(formatBotStateDraft({})).toBe('{}')
  })

  it.each(['{', '[]', 'null', '42', '"text"', '{"number":1e309}'])(
    'rejects invalid or non-object draft %s',
    (draft) => expect(() => parseBotStateDraft(draft)).toThrow()
  )

  it('bounds draft text including whitespace before parsing', () => {
    expect(() => parseBotStateDraft(' '.repeat(PLAYGROUND_LIMITS.stateBytes) + '{}')).toThrow(
      'exceeds'
    )
    expect(parseBotStateDraft(' '.repeat(PLAYGROUND_LIMITS.stateBytes - 2) + '{}')).toEqual({})
  })

  it('keeps large valid committed states within the draft bound when pretty printing would exceed it', () => {
    const committed = { text: 'x'.repeat(PLAYGROUND_LIMITS.stateBytes - 11) }
    const draft = formatBotStateDraft(committed)
    expect(draft).toHaveLength(PLAYGROUND_LIMITS.stateBytes)
    expect(parseBotStateDraft(draft)).toEqual(committed)
  })

  it('uses the same nesting and work limits as the execution engine', () => {
    const nested =
      '['.repeat(PLAYGROUND_LIMITS.depth + 1) + '0' + ']'.repeat(PLAYGROUND_LIMITS.depth + 1)
    expect(() => parseBotStateDraft(`{"nested":${nested}}`)).toThrow('nesting/work limit')
    expect(() =>
      parseBotStateDraft(JSON.stringify({ nodes: Array(PLAYGROUND_LIMITS.nodes).fill(0) }))
    ).toThrow('nesting/work limit')
  })
})
