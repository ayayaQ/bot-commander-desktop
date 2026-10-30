import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import {
  AUTO_REVIEW_POLICY_REVISION,
  type AgentDecisionAuditInspection
} from '../../../shared/agentAutoReview'
import { AGENT_WEB_POLICY_REVISION } from '../../../shared/agentWeb'

// Exercise the actual component activation functions with ordinary IPC/state mocks,
// without starting a browser, Electron main, a provider or a bot.
const component = readFileSync(new URL('./AgentPanel.svelte', import.meta.url), 'utf8')
const functions = component.slice(
  component.indexOf('  async function beginEnrollment('),
  component.indexOf('  async function updateAutomaticWeb(')
)
const javascript = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ESNext }
}).outputText
function inspection(recoveryRequired = false): AgentDecisionAuditInspection {
  return {
    id: 'inspection-fixture',
    ...binding,
    inspectedAt: '2026-10-30T00:00:00.000Z',
    recoveryRequired,
    canAcknowledge: true,
    rows: [{ id: 'old-decision', tool: 'create_memory', outcome: 'unknown' }]
  }
}
const binding = {
  provider: 'openai' as const,
  accountRevision: 'account-fixture',
  policyRevision: AUTO_REVIEW_POLICY_REVISION
}
function fixture(metadata = inspection(), sessionId = 'new-session') {
  const inspect = vi.fn(async () => metadata)
  const enroll = vi.fn(async () => undefined)
  const plan = vi.fn(async () => undefined)
  const make = new Function(
    'environment',
    `
    const { inspectAgentAutoReviewAudit, enrollAgentAutoReview, handlePlanDecision,
      AUTO_REVIEW_POLICY_REVISION, AGENT_WEB_POLICY_REVISION } = environment;
    let $activeAgentSession = { id: environment.sessionId, messages: [{ id: 'plan-fixture', role: 'assistant' }] };
    let $settingsStore = { agentDecisionAccountRevision: 'account-fixture', webProvider: 'disabled' };
    const selectedReviewer = () => 'openai';
    let running = false, enrollmentBusy = false, enrollmentIntent = null,
      enrollmentError = '', auditInspection, auditAcknowledged = false;
    ${javascript}
    return {
      beginEnrollment,
      state: () => ({ enrollmentIntent, enrollmentError, enrollmentBusy }),
      changeAccount: () => { $settingsStore.agentDecisionAccountRevision = 'changed-account' },
      changeSession: () => { $activeAgentSession.id = 'different-session' }
    };
  `
  )
  return {
    inspect,
    enroll,
    plan,
    ...make({
      inspectAgentAutoReviewAudit: inspect,
      enrollAgentAutoReview: enroll,
      handlePlanDecision: plan,
      AUTO_REVIEW_POLICY_REVISION,
      AGENT_WEB_POLICY_REVISION,
      sessionId
    })
  }
}

describe('Auto activation with retained recovered audit history', () => {
  it.each([false, true])(
    'enables directly forPlan=%s using the host recovery status',
    async (forPlan) => {
      const f = fixture()
      await f.beginEnrollment(forPlan)
      expect(f.enroll).toHaveBeenCalledWith('new-session', bindingWithoutPolicy(), !forPlan)
      expect(f.state()).toMatchObject({
        enrollmentIntent: null,
        enrollmentError: '',
        enrollmentBusy: false
      })
      if (forPlan) expect(f.plan).toHaveBeenCalledWith('auto', 'plan-fixture')
      else expect(f.plan).not.toHaveBeenCalled()
    }
  )

  it('still lets host enrollment reject unavailable storage after inspection', async () => {
    const f = fixture()
    f.enroll.mockRejectedValueOnce(new Error('Audit durability unavailable'))
    await f.beginEnrollment(true)
    expect(f.enroll).toHaveBeenCalledOnce()
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.state()).toMatchObject({
      enrollmentError: 'Audit durability unavailable',
      enrollmentBusy: false
    })
  })

  it.each([true, undefined])(
    'does not activate when host recoveryRequired is %s',
    async (required) => {
      const metadata = inspection()
      if (required === undefined) delete metadata.recoveryRequired
      else metadata.recoveryRequired = required
      const f = fixture(metadata)
      await f.beginEnrollment(false)
      expect(f.enroll).not.toHaveBeenCalled()
      expect(f.state().enrollmentIntent).toMatchObject({ sessionId: 'new-session' })
    }
  )

  it('does not activate after the selected account changes during inspection', async () => {
    const f = fixture()
    f.inspect.mockImplementationOnce(async () => {
      f.changeAccount()
      return inspection()
    })
    await f.beginEnrollment(false)
    expect(f.enroll).not.toHaveBeenCalled()
    expect(f.state().enrollmentError).toContain('account changed')
  })

  it('does not activate a different session after interrupted navigation', async () => {
    const f = fixture()
    f.inspect.mockImplementationOnce(async () => {
      f.changeSession()
      return inspection()
    })
    await f.beginEnrollment(true)
    expect(f.enroll).not.toHaveBeenCalled()
    expect(f.plan).not.toHaveBeenCalled()
    expect(f.state().enrollmentBusy).toBe(false)
  })
})
function bindingWithoutPolicy() {
  return { provider: binding.provider, accountRevision: binding.accountRevision }
}
