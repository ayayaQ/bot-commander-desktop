import { closeInterruptedHistory, type HistoryMessage, type ToolCall } from '@ayayaq/vivi'
import type { AgentMessage, AgentSession } from '../../shared/agentTypes'

const interruptedResult = JSON.stringify({
  success: false,
  error: {
    code: 'interrupted',
    message:
      'Tool call interrupted; the outcome may be unknown. Read current state before retrying.'
  }
})

/** Recover a persisted checkpoint without ever executing a historical tool call. */
export function closeInterruptedAgentHistory(history: readonly HistoryMessage[]): HistoryMessage[] {
  return closeInterruptedHistory(history)
}

/** Older releases stored tool activity only in UI messages; reconstruct matched exchanges. */
export function migrateAgentHistory(messages: AgentMessage[]): HistoryMessage[] {
  const history: HistoryMessage[] = []
  let index = 0
  const seenIds = new Set<string>()
  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'tool') {
      const group: AgentMessage[] = []
      while (index < messages.length && messages[index].role === 'tool')
        group.push(messages[index++])
      for (const toolMessage of group) {
        for (const call of toolMessage.toolCalls || []) {
          if (
            typeof call.id !== 'string' ||
            !call.id.trim() ||
            typeof call.name !== 'string' ||
            !call.name.trim()
          )
            continue
          let callId = call.id
          let suffix = 1
          while (seenIds.has(callId)) callId = `${call.id}_legacy_${suffix++}`
          seenIds.add(callId)
          const toolCall: ToolCall = {
            id: callId,
            name: call.name,
            arguments: JSON.parse(JSON.stringify(call.arguments || {}))
          }
          // The legacy format did not retain original assistant grouping or native metadata.
          history.push({ kind: 'assistant', content: '', toolCalls: [toolCall] })
          const settled = ['completed', 'rejected', 'error'].includes(call.status)
          history.push({
            kind: 'tool_result',
            callId,
            name: call.name,
            content: settled
              ? call.error && toolMessage.content === call.name
                ? JSON.stringify({ success: false, error: call.error })
                : toolMessage.content
              : interruptedResult,
            ...(call.status !== 'completed' ? { isError: true } : {})
          })
        }
      }
      continue
    }
    if (message.role === 'user' || message.role === 'system')
      history.push({ kind: 'message', role: message.role, content: message.content })
    if (message.role === 'assistant')
      history.push({ kind: 'assistant', content: message.content, toolCalls: [] })
    index += 1
  }
  return history
}

export function initializeAgentHistory(session: AgentSession): void {
  // A present but damaged canonical transcript is evidence, not a legacy migration input.
  // Only assign after successful recovery so errors leave the original field untouched.
  if (Object.hasOwn(session, 'history')) {
    if (!Array.isArray(session.history)) throw new Error('Existing agent history must be an array')
    session.history = closeInterruptedAgentHistory(session.history)
  } else {
    session.history = closeInterruptedAgentHistory(migrateAgentHistory(session.messages))
  }
}
