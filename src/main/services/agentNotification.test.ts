import { describe, expect, it } from 'vitest'
import type { AgentSession, AgentStreamEvent } from '../../shared/agentTypes'
import { getAgentNotificationDetails, shouldShowAgentNotification } from './agentNotification'

function event(type: AgentStreamEvent['type'], status: AgentSession['status']): AgentStreamEvent {
  return {
    sessionId: 'session-1',
    type,
    session: {
      id: 'session-1',
      title: 'Build welcome command',
      mode: 'manual',
      model: 'test',
      reasoningEffort: 'none',
      status,
      messages: [],
      createdAt: '',
      updatedAt: '',
      tokenCount: 0,
      error: 'Secret provider detail'
    }
  }
}

describe('agent notification content', () => {
  it('creates private approval, completion, and error messages', () => {
    expect(getAgentNotificationDetails(event('approval', 'waiting_approval'))).toEqual({
      title: 'Agent approval required',
      body: 'Build welcome command needs your approval.'
    })
    expect(getAgentNotificationDetails(event('done', 'completed'))?.body).toBe(
      'Build welcome command finished successfully.'
    )
    const failed = getAgentNotificationDetails(event('error', 'error'))
    expect(failed?.body).toBe('Build welcome command encountered an error.')
    expect(JSON.stringify(failed)).not.toContain('Secret provider detail')
  })

  it('does not notify for cancellation, interruption, or ordinary events', () => {
    expect(getAgentNotificationDetails(event('done', 'cancelled'))).toBeNull()
    expect(getAgentNotificationDetails(event('done', 'interrupted'))).toBeNull()
    expect(getAgentNotificationDetails(event('session', 'running'))).toBeNull()
  })

  it('respects preferences, active view suppression, and native support', () => {
    const completed = event('done', 'completed')
    expect(
      shouldShowAgentNotification(completed, {
        enabled: true,
        agentViewActive: false,
        supported: true
      })
    ).toBe(true)
    expect(
      shouldShowAgentNotification(completed, {
        enabled: false,
        agentViewActive: false,
        supported: true
      })
    ).toBe(false)
    expect(
      shouldShowAgentNotification(completed, {
        enabled: true,
        agentViewActive: true,
        supported: true
      })
    ).toBe(false)
    expect(
      shouldShowAgentNotification(completed, {
        enabled: true,
        agentViewActive: false,
        supported: false
      })
    ).toBe(false)
  })
})
