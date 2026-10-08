import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { get } from 'svelte/store'
import type { AgentSession } from '../../../shared/agentTypes'
import {
  AUTO_REVIEW_DISCLOSURE,
  AUTO_REVIEW_POLICY_REVISION
} from '../../../shared/agentAutoReview'

const session = (): AgentSession => ({
  id: 'agent-fixture',
  title: 'Ordinary fixture',
  mode: 'manual',
  model: 'gpt-5.4-nano',
  reasoningEffort: 'none',
  status: 'idle',
  messages: [],
  history: [],
  createdAt: '',
  updatedAt: '',
  planReady: false,
  tokenCount: 0
})

describe('Auto review renderer IPC and interrupted responses', () => {
  let invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  let agent: typeof import('./agent')
  let settings: typeof import('./settings')
  let accountRevision: string

  beforeEach(async () => {
    vi.resetModules()
    accountRevision = 'account-fixture-1'
    invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
      if (channel === 'get-settings')
        return {
          theme: 'light',
          language: 'en',
          aiProvider: 'openai',
          openaiApiKey: '',
          agentDecisionAccountRevision: accountRevision
        }
      if (channel === 'agent:enroll-auto-review')
        return {
          ...session(),
          mode: 'auto',
          autoReviewEnrollment: {
            policyRevision: AUTO_REVIEW_POLICY_REVISION,
            provider: 'openai',
            accountRevision,
            acknowledgedAt: '2026-10-08T01:00:00.000Z'
          }
        }
      return true
    })
    vi.stubGlobal('window', {
      electron: { ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }
    })
    settings = await import('./settings')
    await settings.loadSettings()
    agent = await import('./agent')
    agent.agentSessions.set({
      sessions: [session()],
      activeSessionId: 'agent-fixture',
      modelDefaultsByProvider: {}
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('discloses proposed text, private-detail limits and the named recipients under fresh consent', () => {
    expect(AUTO_REVIEW_POLICY_REVISION).toBe('desktop-reviewed-auto-v2')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('proposed memory or command text')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('OpenAI gpt-6-luna')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('OpenRouter and TypeSafe typesafe/jev-1.13')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('Known credentials are excluded')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('recognized sensitive content stays local')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('cannot identify every private detail')
    expect(AUTO_REVIEW_DISCLOSURE).toContain('consent to sharing')
  })

  it('sends the fixed policy and exact disclosed account to enrollment', async () => {
    const result = await agent.enrollAgentAutoReview('agent-fixture', {
      provider: 'openai',
      accountRevision
    })
    expect(result.mode).toBe('auto')
    expect(invoke).toHaveBeenCalledWith('agent:enroll-auto-review', 'agent-fixture', {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai',
      accountRevision,
      activate: true
    })
    expect(get(agent.activeAgentSession)?.mode).toBe('auto')
  })

  it('does not send UI-only state or extra fields as enrollment authority', async () => {
    const intent = {
      provider: 'openai' as const,
      accountRevision,
      sessionId: 'agent-fixture',
      forPlan: false,
      planId: 'unused-plan'
    }
    await agent.enrollAgentAutoReview('agent-fixture', intent)
    const sent = invoke.mock.calls.find(([channel]) => channel === 'agent:enroll-auto-review')![2]
    expect(Object.keys(sent as Record<string, unknown>)).toEqual([
      'policyRevision',
      'provider',
      'accountRevision',
      'activate'
    ])
  })

  it('requires loaded account identity before enrollment', async () => {
    await expect(
      agent.enrollAgentAutoReview('agent-fixture', { provider: 'openai' })
    ).rejects.toThrow('settings')
    expect(invoke.mock.calls.some(([channel]) => channel === 'agent:enroll-auto-review')).toBe(
      false
    )
  })

  it('does not adopt a late Auto response after the account changed', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => {
      const result = await original(channel, ...args)
      if (channel === 'agent:enroll-auto-review') accountRevision = 'account-fixture-2'
      return result
    })
    await expect(
      agent.enrollAgentAutoReview('agent-fixture', { provider: 'openai', accountRevision })
    ).rejects.toThrow('changed')
    expect(get(agent.activeAgentSession)?.mode).toBe('manual')
  })

  it('forwards the exact one-use approval ID and selected plan ID', async () => {
    await agent.resolveAgentApproval('tool-fixture', true, 'approval-fixture')
    expect(invoke).toHaveBeenCalledWith(
      'agent:approve',
      'agent-fixture',
      'tool-fixture',
      true,
      'approval-fixture'
    )
    await agent.resolveAgentPlan('auto', 'approved-plan-fixture')
    expect(invoke).toHaveBeenCalledWith(
      'agent:resolve-plan',
      'agent-fixture',
      'auto',
      'approved-plan-fixture'
    )
  })
})
