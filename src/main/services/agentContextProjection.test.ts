import { describe, expect, it } from 'vitest'
import type { HistoryMessage } from '@ayayaq/vivi'
import { createAgentContextProjection } from './agentContextProjection'

const skill = (callId: string): HistoryMessage => ({
  kind: 'tool_result',
  name: 'read_skill',
  callId,
  content: 'OLD skill instructions'
})

describe('desktop skill guidance context projection', () => {
  it('expires prior skill contents without changing canonical receipts or protocol identities', () => {
    const source = [skill('earlier')]
    const raw = structuredClone(source)
    const project = createAgentContextProjection(source)
    const view = project([...source, skill('current')])
    expect(source).toEqual(raw)
    expect(view[0]).toMatchObject({ kind: 'tool_result', name: 'read_skill', callId: 'earlier' })
    expect(view[0].content).toContain('Read the relevant skill from this turn catalog again')
    expect(view[0].content).not.toContain('OLD skill instructions')
    expect(view[1]).toEqual(skill('current'))
  })
})

it('invalidates a summary when this turn expires previously summarized skill guidance', async () => {
  const { compactContext, measureContext } = await import('@ayayaq/vivi')
  const history: HistoryMessage[] = [
    { kind: 'message', role: 'user', content: 'Earlier request '.repeat(500) },
    {
      kind: 'assistant',
      content: '',
      toolCalls: [{ id: 'skill', name: 'read_skill', arguments: {} }]
    },
    {
      kind: 'tool_result',
      callId: 'skill',
      name: 'read_skill',
      content: 'OUTDATED SKILL AUTHORITY '.repeat(300)
    },
    { kind: 'assistant', content: 'Earlier answer', toolCalls: [] }
  ]
  for (let index = 0; index < 6; index++)
    history.push(
      {
        kind: 'message',
        role: 'user',
        content: `Later request ${index} ${'background '.repeat(500)}`
      },
      { kind: 'assistant', content: 'Later answer', toolCalls: [] }
    )
  const provider = {
    generate: async () => ({ content: 'OUTDATED SKILL AUTHORITY in older summary', toolCalls: [] })
  }
  const context = {
    sourceId: 'desktop/session/projection-test',
    keepRecentMessages: 2,
    projectMessages: createAgentContextProjection([])
  }
  const before = structuredClone(history)
  const first = await compactContext({ provider, messages: history, tools: [], context })
  expect(first.checkpoint).toBeDefined()
  const refreshed = measureContext({
    provider,
    messages: history,
    tools: [],
    context: {
      ...context,
      checkpoint: first.checkpoint,
      projectMessages: createAgentContextProjection(history)
    }
  })
  expect(refreshed.checkpoint).toBeUndefined()
  expect(JSON.stringify(refreshed.messages)).not.toContain('OUTDATED SKILL AUTHORITY')
  expect(history).toEqual(before)
})
