import type { AgentSession } from '../../../shared/agentTypes'

export type AgentTerminalAttention = 'completed' | 'error'
export type AgentNavigationStatus =
  | { kind: 'approval'; count: number; label: string }
  | { kind: 'running'; count: number; label: string }
  | { kind: 'error'; count: number; label: string }
  | { kind: 'completed'; count: number; label: string }
  | { kind: 'idle'; count: 0; label: string }

export function deriveAgentNavigationStatus(
  sessions: AgentSession[],
  unseenResults: Record<string, AgentTerminalAttention>
): AgentNavigationStatus {
  const approvalCount = sessions.reduce(
    (total, session) =>
      total +
      session.messages.reduce(
        (messageTotal, message) =>
          messageTotal +
          (message.toolCalls?.filter((call) => call.status === 'waiting_approval').length || 0),
        0
      ),
    0
  )
  if (approvalCount > 0) {
    return {
      kind: 'approval',
      count: approvalCount,
      label: `${approvalCount} agent ${approvalCount === 1 ? 'approval' : 'approvals'} required`
    }
  }

  const runningCount = sessions.filter((session) => session.status === 'running').length
  if (runningCount > 0) {
    return {
      kind: 'running',
      count: runningCount,
      label: `${runningCount} ${runningCount === 1 ? 'agent is' : 'agents are'} working`
    }
  }

  const unseenErrors = Object.values(unseenResults).filter((status) => status === 'error').length
  if (unseenErrors > 0) {
    return {
      kind: 'error',
      count: unseenErrors,
      label: `${unseenErrors} unseen agent ${unseenErrors === 1 ? 'error' : 'errors'}`
    }
  }

  const unseenCompletions = Object.values(unseenResults).filter(
    (status) => status === 'completed'
  ).length
  if (unseenCompletions > 0) {
    return {
      kind: 'completed',
      count: unseenCompletions,
      label: `${unseenCompletions} unseen agent ${unseenCompletions === 1 ? 'completion' : 'completions'}`
    }
  }

  return { kind: 'idle', count: 0, label: 'Agent' }
}
