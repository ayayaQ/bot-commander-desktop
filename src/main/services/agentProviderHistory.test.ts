import { describe, expect, it } from 'vitest'
import type { HistoryMessage, ProviderResult } from '@ayayaq/vivi'
import { createOpenRouterReasoningReplay } from './agentProviderHistory'

const model = 'anthropic/claude-haiku-5.5'
const result = (signature: string, provider = `openrouter:${model}`): ProviderResult => ({
  content: '',
  toolCalls: [],
  providerState: {
    provider,
    items: [
      {
        role: 'assistant',
        content: '',
        reasoning_details: [{ type: 'reasoning.text', text: 'Reasoning', signature }]
      }
    ]
  }
})
const assistant = (reply: ProviderResult): HistoryMessage => ({ kind: 'assistant', ...reply })

describe('Claude reasoning prefix bindings', () => {
  it('expires reasoning after an edited skill receipt while retaining reasoning before that edit', () => {
    const replay = createOpenRouterReasoningReplay(model)
    const messages: HistoryMessage[] = [{ kind: 'message', role: 'user', content: 'Use a skill' }]
    const first = result('first')
    replay.accept({ messages: [...messages], tools: [] }, first)
    messages.push(assistant(first), {
      kind: 'tool_result',
      callId: 'skill-read',
      name: 'read_skill',
      content: 'Prior skill text'
    })
    const second = result('second')
    replay.accept({ messages: [...messages], tools: [] }, second)
    messages.push(assistant(second))
    const original = structuredClone(messages)
    const changed = messages.map((message) =>
      message.kind === 'tool_result'
        ? { ...message, content: 'Earlier skill guidance omitted. Read the relevant skill again.' }
        : message
    )
    const projected = replay.project({ messages: changed, tools: [] })
    expect(projected.messages[1]).toEqual(messages[1])
    expect(projected.messages[3]).not.toEqual(messages[3])
    expect(projected.messages[3]).toMatchObject({
      providerState: {
        provider: `openrouter:${model}`,
        items: [{ role: 'assistant', content: '' }]
      }
    })
    expect(messages).toEqual(original)
  })

  it.each([
    ['google/gemini-fixture', 'openrouter:google/gemini-fixture'],
    [model, 'deepseek:deepseek-flash'],
    [model, 'openai:gpt-fixture']
  ])('preserves unrelated %s native history from %s', (selectedModel, provider) => {
    const replay = createOpenRouterReasoningReplay(selectedModel)
    const input = { messages: [assistant(result('opaque', provider))], tools: [] }
    expect(replay.project(input)).toEqual(input)
  })
})
