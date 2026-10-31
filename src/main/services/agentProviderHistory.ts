import { createHash } from 'node:crypto'
import type { HistoryMessage, ProviderResult, ProviderState, ToolDefinition } from '@ayayaq/vivi'

type ProviderInput = { messages: readonly HistoryMessage[]; tools: readonly ToolDefinition[] }
const reasoningFields = new Set(['reasoning', 'reasoning_content', 'reasoning_details'])
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Claude signatures bind to the preceding conversation and tools. The host rebuilds its
 * prefix each turn and projects old skill reads, so saved signatures cannot be assumed valid.
 * Keep native tool calls and canonical history intact, and replay reasoning only when this
 * provider instance can verify that its original request prefix is still unchanged.
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 */
export function createOpenRouterReasoningReplay(model: string) {
  const prefixes = new Map<string, string>()
  const nativeReasoning = (state?: ProviderState) =>
    model.startsWith('anthropic/') &&
    state?.provider === `openrouter:${model}` &&
    state.items.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        Object.keys(item).some((key) => reasoningFields.has(key))
    )

  return {
    project(input: ProviderInput): ProviderInput {
      const messages: HistoryMessage[] = []
      for (const message of input.messages) {
        const state = message.kind === 'assistant' ? message.providerState : undefined
        if (
          message.kind === 'assistant' &&
          state &&
          nativeReasoning(state) &&
          prefixes.get(digest(state)) !== digest({ messages, tools: input.tools })
        ) {
          messages.push({
            ...message,
            providerState: {
              ...state,
              items: state.items.map((item) =>
                item && typeof item === 'object' && !Array.isArray(item)
                  ? Object.fromEntries(
                      Object.entries(item).filter(([key]) => !reasoningFields.has(key))
                    )
                  : item
              )
            }
          })
        } else messages.push(message)
      }
      return { ...input, messages }
    },
    accept(input: ProviderInput, result: ProviderResult): void {
      if (nativeReasoning(result.providerState)) {
        prefixes.set(
          digest(result.providerState),
          digest({ messages: input.messages, tools: input.tools })
        )
      }
    }
  }
}
