import type { HistoryMessage } from '@ayayaq/vivi'

/** Expire earlier skill guidance in the request/summary view, retaining exact canonical receipts. */
export function createAgentContextProjection(history: readonly HistoryMessage[]) {
  const earlierSkillReads = new Set(
    history.flatMap((message) =>
      message.kind === 'tool_result' && message.name === 'read_skill' ? [message.callId] : []
    )
  )
  return (messages: readonly HistoryMessage[]): readonly HistoryMessage[] =>
    messages.map((message) =>
      message.kind === 'tool_result' &&
      message.name === 'read_skill' &&
      earlierSkillReads.has(message.callId)
        ? {
            ...message,
            content: JSON.stringify({
              priorSkillRead: true,
              message:
                'Earlier skill guidance omitted. Read the relevant skill from this turn catalog again.'
            })
          }
        : message
    )
}
