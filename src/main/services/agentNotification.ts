import type { AgentStreamEvent } from '../../shared/agentTypes'

export interface AgentNotificationDetails {
  title: string
  body: string
}

export interface AgentNotificationPolicy {
  enabled: boolean
  agentViewActive: boolean
  supported: boolean
}

export function getAgentNotificationDetails(
  event: AgentStreamEvent
): AgentNotificationDetails | null {
  if (!event.session) return null

  if (event.type === 'approval') {
    return {
      title: 'Agent approval required',
      body: `${event.session.title} needs your approval.`
    }
  }

  if (event.type === 'done' && event.session.status === 'completed') {
    return {
      title: 'Agent task completed',
      body: `${event.session.title} finished successfully.`
    }
  }

  if (event.type === 'error' && event.session.status === 'error') {
    return {
      title: 'Agent task failed',
      body: `${event.session.title} encountered an error.`
    }
  }

  return null
}

export function shouldShowAgentNotification(
  event: AgentStreamEvent,
  policy: AgentNotificationPolicy
): boolean {
  return (
    policy.enabled &&
    !policy.agentViewActive &&
    policy.supported &&
    getAgentNotificationDetails(event) !== null
  )
}
