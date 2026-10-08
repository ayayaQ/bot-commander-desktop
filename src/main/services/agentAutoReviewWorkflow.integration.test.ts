import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ModelProvider, ProviderResult, ToolCall } from '@ayayaq/vivi'
import type { AgentStreamEvent, AgentToolCall } from '../../shared/agentTypes'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import {
  createNotRunAgentValidationReport,
  type AgentValidationRequest,
  type AgentValidationSuite
} from '../../shared/agentValidationTypes'
import { createPlaygroundState } from '../../shared/playground/types'

const mocks = vi.hoisted(() => ({
  directory: '',
  generate: vi.fn<ModelProvider['generate']>(),
  judge: vi.fn<(provider: string, body: Record<string, unknown>) => Promise<Response>>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.directory },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {}
}))
// Only conversational generation and encryption are substituted. The installed
// decision factories, controller, ledger, memory/resources, locks and writer are real.
vi.mock('./agentProviderAdapter', () => ({
  createAgentProvider: () => ({ generate: mocks.generate }),
  getAgentModelCapabilities: () => ({ tools: 'supported' }),
  executeAgentProviderTurn: vi.fn()
}))
vi.mock('./fileService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fileService')>()),
  saveSettings: vi.fn(async () => {})
}))
// Ordinary host-owned report fixture; actual worker execution is independently
// covered by the existing retained reference-workflow regression.
vi.mock('./agentValidationService', () => ({
  validatePreparedResource: vi.fn(async (request: AgentValidationRequest) => {
    const report = createNotRunAgentValidationReport(request, 'offline ordinary report fixture')
    report.outcome = 'passed'
    report.coverage.notRun = 0
    for (let caseIndex = 0; caseIndex < report.cases.length; caseIndex++) {
      const result = report.cases[caseIndex]
      result.outcome = 'passed'
      for (let index = 0; index < result.steps.length; index++) {
        const step = result.steps[index]
        const fixture = request.suite.cases[caseIndex].steps[index]
        Object.assign(step, {
          outcome: 'passed',
          executionOutcome: 'executed',
          matched: true,
          executed: true,
          assertions: fixture.assertions.map((item) => ({
            path: item.path,
            expected: item.equals,
            actual: item.equals,
            passed: true,
            actualPresent: true
          }))
        })
        step.effects.messages = [
          { id: 2, author: 'Playground Bot', content: 'Hello!', kind: 'bot' }
        ]
        report.coverage.executed++
        report.coverage.matched++
      }
    }
    return report
  })
}))

function response(provider: string, body: Record<string, unknown>, probability = 1): Response {
  const names =
    provider === 'openai'
      ? (body.questions as Array<{ name: string }>).map((check) => check.name)
      : Object.keys(body.questions as object)
  const value =
    provider === 'openai'
      ? {
          model: 'gpt-6-luna',
          answers: names.map((name) => ({ name, type: 'predicate', probability })),
          usage: {
            input_tokens: 30,
            output_tokens: 5,
            total_tokens: 35,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 }
          }
        }
      : {
          model: 'typesafe/jev-1.13',
          answers: Object.fromEntries(
            names.map((name) => [name, { type: 'noul', noul: probability }])
          ),
          usage: { input_tokens: 30, output_tokens: 5, cost: 0.0002 }
        }
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}
function tool(
  name = 'create_memory',
  args = { content: 'Prefer concise answers' } as Record<string, unknown>,
  id = 'ordinary-call'
): ProviderResult {
  return { content: '', toolCalls: [{ id, name, arguments: args as ToolCall['arguments'] }] }
}
function suite(): AgentValidationSuite {
  const state = createPlaygroundState()
  return {
    cases: [
      {
        name: 'ordinary reply',
        state,
        steps: [
          {
            kind: 'message',
            senderId: state.members[0].id,
            content: '!hello',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: 'Hello!' }
            ]
          }
        ]
      }
    ]
  }
}

describe('reviewed Auto desktop workflow with mock dedicated endpoints', () => {
  let agent: typeof import('./agentService')
  let settings: typeof import('./settingsService')
  let memories: typeof import('./agentMemoryService')
  let terminal: Promise<AgentStreamEvent> | undefined
  const requests: Array<{
    provider: string
    body: Record<string, unknown>
    header: string | null
  }> = []

  beforeEach(async () => {
    vi.resetModules()
    requests.length = 0
    mocks.directory = await fs.mkdtemp(join(tmpdir(), 'desktop-reviewed-auto-'))
    mocks.generate.mockReset().mockResolvedValue({ content: 'Done.', toolCalls: [] })
    mocks.judge.mockReset().mockImplementation(async (provider, body) => response(provider, body))
    terminal = undefined
    settings = await import('./settingsService')
    settings.setSettings({
      ...settings.getSettings(),
      openaiApiKey: 'offline-openai-fixture',
      openrouterApiKey: 'offline-router-fixture',
      selectedAiModel: 'gpt-5.4-nano'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const endpoint = String(url)
        const provider =
          endpoint === 'https://api.openai.com/v1/decisions'
            ? 'openai'
            : endpoint === 'https://openrouter.ai/api/alpha/decisions'
              ? 'openrouter'
              : undefined
        if (!provider) throw new Error('Unexpected endpoint in offline decision workflow')
        const body = JSON.parse(init!.body as string) as Record<string, unknown>
        requests.push({ provider, body, header: new Headers(init!.headers).get('authorization') })
        return mocks.judge(provider, body)
      })
    )
    agent = await import('./agentService')
    memories = await import('./agentMemoryService')
  })
  afterEach(async () => {
    agent.stopAgentRuns()
    if (terminal) await terminal
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent.setAgentEventSink(null)
    vi.unstubAllGlobals()
    await fs.rm(mocks.directory, { recursive: true, force: true })
  })

  async function create(enrolled = true) {
    const session = await agent.createAgentSession(settings.getSettings())
    if (enrolled)
      await agent.enrollAgentAutoReview(session.id, {
        policyRevision: AUTO_REVIEW_POLICY_REVISION,
        provider: settings.getSettings().aiProvider || 'openai',
        accountRevision: settings.getSettings().agentDecisionAccountRevision!
      })
    return session
  }
  async function start(sessionId: string, userText = 'Remember that I prefer concise answers.') {
    const events: AgentStreamEvent[] = []
    let settle: (event: AgentStreamEvent) => void
    terminal = new Promise((resolve) => {
      settle = resolve
    })
    agent.setAgentEventSink((event) => {
      events.push(structuredClone(event))
      if (event.type === 'done' || event.type === 'error') settle(event)
    })
    await agent.runAgentSession(sessionId, userText, settings.getSettings())
    return { events, terminal }
  }
  async function approval(events: AgentStreamEvent[]): Promise<AgentToolCall> {
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval')).toBe(true))
    return events.find((event) => event.type === 'approval')!.toolCall!
  }
  async function ledger() {
    return JSON.parse(await fs.readFile(join(mocks.directory, 'agent-decisions.json'), 'utf8'))
  }

  it.each(['openai', 'openrouter'] as const)(
    'uses the enrolled %s fixed reviewer and separate usage',
    async (provider) => {
      settings.setSettings({ ...settings.getSettings(), aiProvider: provider })
      const session = await create()
      mocks.generate.mockResolvedValueOnce(tool())
      const run = await start(session.id)
      expect((await run.terminal).session?.status).toBe('completed')
      expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
      expect(requests).toHaveLength(1)
      expect(requests[0].provider).toBe(provider)
      expect(requests[0].header).toBe(
        `Bearer ${provider === 'openai' ? 'offline-openai-fixture' : 'offline-router-fixture'}`
      )
      const decision = run.events.filter((event) => event.toolCall?.decision).at(-1)!.toolCall!
        .decision!
      expect(decision.source).toBe('automatic')
      expect(decision.model).toBe(provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13')
      expect(decision.usage).toMatchObject({ inputTokens: 30, outputTokens: 5 })
      expect((await ledger()).rows[0]).toMatchObject({ state: 'committed', source: 'automatic' })
      expect(JSON.stringify(await ledger())).not.toContain('Prefer concise answers')
      expect(JSON.stringify(requests[0].body)).not.toContain('offline-openai-fixture')
      expect(run.events.some((event) => event.type === 'approval')).toBe(false)
    }
  )

  it('keeps Manual judge-free and requires the exact one-use approval identity', async () => {
    const session = await create(false)
    mocks.generate.mockResolvedValueOnce(tool())
    const run = await start(session.id)
    const call = await approval(run.events)
    expect(await agent.resolveAgentApproval(session.id, call.id, true)).toBe(false)
    expect(await agent.resolveAgentApproval(session.id, call.id, true, 'older-approval')).toBe(
      false
    )
    expect(await agent.resolveAgentApproval(session.id, call.id, true, call.approvalId)).toBe(true)
    expect(await agent.resolveAgentApproval(session.id, call.id, true, call.approvalId)).toBe(false)
    await run.terminal
    expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
    expect(requests).toHaveLength(0)
  })

  it('does not publish stale Auto enrollment when the account changes during its session checkpoint', async () => {
    const session = await create(false)
    const expected = {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai' as const,
      accountRevision: settings.getSettings().agentDecisionAccountRevision!
    }
    let entered: () => void, release: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = fs.rename.bind(fs)
    const path = join(mocks.directory, 'agent-sessions.json')
    let held = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path && !held) {
        held = true
        entered!()
        await gate
      }
      return original(from, to)
    })
    const enrolling = agent.enrollAgentAutoReview(session.id, expected)
    const refused = expect(enrolling).rejects.toThrow('changed before enrollment was published')
    await reached
    settings.setSettings({
      ...settings.getSettings(),
      openaiApiKey: 'changed-during-checkpoint-fixture'
    })
    release!()
    await refused
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    const current = (await agent.loadAgentSessions()).sessions[0]
    expect(current.mode).toBe('manual')
    expect(current.autoReviewEnrollment).toBeUndefined()
    expect(requests).toHaveLength(0)
    vi.restoreAllMocks()
  })

  it('retains a known committed audit outcome when cancellation interrupts the draining save', async () => {
    await memories.loadAgentMemories()
    const session = await create()
    const notice = vi.fn()
    const persistenceNotices = await import('./agentPersistence')
    persistenceNotices.setAgentPersistenceNoticeHandler(notice)
    let entered: () => void, release: () => void
    const reached = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = fs.rename.bind(fs)
    const path = join(mocks.directory, 'agent-memories.json')
    let held = false
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await original(from, to)
      if (String(to) === path && !held) {
        held = true
        entered!()
        await gate
      }
    })
    mocks.generate.mockResolvedValueOnce(tool())
    const run = await start(session.id)
    await reached
    agent.cancelAgentRun(session.id)
    release!()
    await run.terminal
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
    expect((await ledger()).rows[0].state).toBe('committed')
    expect(requests).toHaveLength(1)
    const displayed = (await agent.loadAgentSessions()).sessions[0].messages.flatMap(
      (message) => message.toolCalls || []
    )[0]
    if (displayed.status !== 'completed')
      expect(notice.mock.calls.some(([entry]) => entry.message.includes('finished saving'))).toBe(
        true
      )
    vi.restoreAllMocks()
  })

  it.each(['unchecked', 'prior privacy disclosure'] as const)(
    'migrates %s persisted Auto to Manual until explicit enrollment',
    async (priorConsent) => {
      const session = await create(false)
      const path = join(mocks.directory, 'agent-sessions.json')
      const stored = JSON.parse(await fs.readFile(path, 'utf8'))
      stored.sessions[0].mode = 'auto'
      if (priorConsent === 'prior privacy disclosure')
        stored.sessions[0].autoReviewEnrollment = {
          policyRevision: 'desktop-reviewed-auto-v1',
          provider: 'openai',
          accountRevision: settings.getSettings().agentDecisionAccountRevision!,
          acknowledgedAt: '2026-10-08T01:00:00.000Z'
        }
      await fs.writeFile(path, JSON.stringify(stored))
      const config = structuredClone(settings.getSettings())
      vi.resetModules()
      settings = await import('./settingsService')
      settings.setSettings(config)
      agent = await import('./agentService')
      memories = await import('./agentMemoryService')
      const migrated = (await agent.loadAgentSessions()).sessions[0]
      expect(migrated).toMatchObject({
        id: session.id,
        mode: 'manual',
        autoReviewMigrationRequired: true
      })
      expect(migrated.messages).toEqual(session.messages)
      await expect(
        agent.updateAgentSession(session.id, { mode: 'auto' }, 'openai')
      ).rejects.toThrow('Acknowledge')
      const enrolled = await agent.enrollAgentAutoReview(session.id, {
        policyRevision: AUTO_REVIEW_POLICY_REVISION,
        provider: 'openai',
        accountRevision: settings.getSettings().agentDecisionAccountRevision!
      })
      expect(enrolled.mode).toBe('auto')
      expect(enrolled.autoReviewMigrationRequired).toBe(false)
    }
  )

  it.each([0.5, 0.01])(
    'permits one-use human review of a model recommendation %s',
    async (probability) => {
      const session = await create()
      mocks.judge.mockImplementation(async (provider, body) =>
        response(provider, body, probability)
      )
      mocks.generate.mockResolvedValueOnce(tool())
      const run = await start(session.id)
      const call = await approval(run.events)
      expect(call.decision?.recommendation).toBe(probability === 0.01 ? 'deny' : 'ask')
      expect((await memories.loadAgentMemories()).memories).toHaveLength(0)
      expect(await agent.resolveAgentApproval(session.id, call.id, true, call.approvalId)).toBe(
        true
      )
      await run.terminal
      expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
      expect((await ledger()).rows[0]).toMatchObject({ state: 'committed', source: 'human_once' })
    }
  )

  it('requires Manual deletion despite enrollment, with zero judge requests', async () => {
    const original = (
      await memories.commitMemoryMutation(
        await memories.prepareCreateMemory('Original preference', 'user')
      )
    ).memories[0]
    const session = await create()
    mocks.generate.mockResolvedValueOnce(
      tool('delete_memory', { id: original.id, expectedRevision: original.revision })
    )
    const run = await start(session.id, 'Forget the original preference.')
    const call = await approval(run.events)
    expect(call.decision?.reasonCode).toBe('manual_mutation')
    expect(requests).toHaveLength(0)
    await agent.resolveAgentApproval(session.id, call.id, false, call.approvalId)
    await run.terminal
    expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
  })

  it('recovers an unknown interrupted audit only after current inspection and explicit acknowledgment, without replay', async () => {
    const session = await create()
    mocks.generate.mockResolvedValueOnce(tool())
    await (
      await start(session.id)
    ).terminal
    const saved = await ledger()
    saved.rows[0].state = 'commit_started'
    delete saved.rows[0].settledAt
    delete saved.rows[0].resultingRevision
    await fs.writeFile(join(mocks.directory, 'agent-decisions.json'), JSON.stringify(saved))
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    const config = structuredClone(settings.getSettings())
    vi.resetModules()
    settings = await import('./settingsService')
    settings.setSettings(config)
    agent = await import('./agentService')
    memories = await import('./agentMemoryService')
    expect((await agent.loadAgentSessions()).sessions[0].mode).toBe('manual')
    const acknowledgement = {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai' as const,
      accountRevision: settings.getSettings().agentDecisionAccountRevision!
    }
    await expect(agent.enrollAgentAutoReview(session.id, acknowledgement)).rejects.toThrow('audit')
    const inspected = await agent.inspectAgentAutoReviewAudit(session.id)
    expect(inspected.canAcknowledge).toBe(true)
    expect(inspected.rows[0]).toMatchObject({ outcome: 'unknown', targetType: 'memory' })
    expect(JSON.stringify(inspected)).not.toContain('Prefer concise answers')
    await agent.enrollAgentAutoReview(session.id, {
      ...acknowledgement,
      recoveryInspectionId: inspected.id
    })
    expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
    expect(requests).toHaveLength(1)
    expect((await ledger()).rows[0]).toMatchObject({
      state: 'unknown',
      reconciliation: { accountRevision: acknowledgement.accountRevision }
    })
    mocks.generate.mockResolvedValueOnce(
      tool('create_memory', { content: 'Prefer short examples' }, 'fresh-request-call')
    )
    await (
      await start(session.id, 'Remember that I prefer short examples.')
    ).terminal
    expect((await memories.loadAgentMemories()).memories).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect((await ledger()).rows[0].state).toBe('unknown')
    expect((await ledger()).rows[1].state).toBe('committed')
  })

  it('saves a fully validated exact response command into the live collection', async () => {
    const session = await create()
    mocks.generate.mockResolvedValueOnce(
      tool('create_command', {
        command: { command: '!hello', commandDescription: 'Say hello', channelMessage: 'Hello!' },
        validation: suite()
      })
    )
    const run = await start(
      session.id,
      'Create an exact !hello command that replies Hello! in the triggering channel.'
    )
    await run.terminal
    const commands = (await import('./botService')).getCommands().bcfdCommands
    expect(commands).toHaveLength(1)
    expect(commands[0].channelMessage).toBe('Hello!')
    expect(requests).toHaveLength(1)
    expect((await ledger()).rows[0]).toMatchObject({ tool: 'create_command', state: 'committed' })
  })

  it('provider/account changes cancel a pending review and suppress late approval', async () => {
    const session = await create()
    let release: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.judge.mockImplementation(async (provider, body) => {
      await gate
      return response(provider, body)
    })
    mocks.generate.mockResolvedValueOnce(tool())
    const run = await start(session.id)
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    settings.setSettings({ ...settings.getSettings(), openaiApiKey: 'changed-offline-fixture' })
    expect((await run.terminal).session?.status).toBe('cancelled')
    release!()
    await Promise.resolve()
    expect((await memories.loadAgentMemories()).memories).toHaveLength(0)
    expect(run.events.some((event) => event.type === 'approval')).toBe(false)
    expect((await agent.loadAgentSessions()).sessions[0]).toMatchObject({
      mode: 'manual',
      autoReviewMigrationRequired: true
    })
  })

  it('binds only the exact plan the user selected for implementation', async () => {
    const session = await create(false)
    await agent.updateAgentSession(session.id, { mode: 'planning' }, 'openai')
    mocks.generate.mockResolvedValueOnce({
      content: '<proposed_plan>Remember that I prefer concise answers.</proposed_plan>',
      toolCalls: []
    })
    await (
      await start(session.id, 'Plan how to remember my preference.')
    ).terminal
    const planned = (await agent.loadAgentSessions()).sessions[0]
    const plan = planned.messages.at(-1)!
    await agent.enrollAgentAutoReview(session.id, {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai',
      accountRevision: settings.getSettings().agentDecisionAccountRevision!,
      activate: false
    })
    await expect(
      agent.resolveAgentPlan(session.id, 'auto', settings.getSettings(), 'older-plan')
    ).rejects.toThrow('changed')
    mocks.generate.mockResolvedValueOnce(tool())
    let finish: (event: AgentStreamEvent) => void
    terminal = new Promise((resolve) => {
      finish = resolve
    })
    agent.setAgentEventSink((event) => {
      if (event.type === 'done' || event.type === 'error') finish(event)
    })
    await agent.resolveAgentPlan(session.id, 'auto', settings.getSettings(), plan.id)
    await terminal
    const state = JSON.parse(requests[0].body.input as string)
    expect(state.userRequest.text).toBe('Implement the plan.')
    expect(state.userRequest.approvedScope.acceptedPlan.text).toBe(plan.content)
    expect((await memories.loadAgentMemories()).memories).toHaveLength(1)
  })
})
