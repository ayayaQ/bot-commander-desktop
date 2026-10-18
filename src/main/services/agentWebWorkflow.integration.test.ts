import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ModelProvider } from '@ayayaq/vivi'
import type { AgentStreamEvent, AgentToolCall } from '../../shared/agentTypes'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import { AGENT_WEB_POLICY_REVISION } from '../../shared/agentWeb'
const mocks = vi.hoisted(() => ({
  home: '',
  generate: vi.fn<ModelProvider['generate']>(),
  web: 0,
  review: 0,
  lost: false,
  afterReceipt: undefined as (() => void) | undefined
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.home },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
vi.mock('./agentProviderAdapter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentProviderAdapter')>()),
  createAgentProvider: () => ({ generate: mocks.generate })
}))
describe('ordinary paid web inside the owned desktop run', () => {
  let agent: typeof import('./agentService')
  let settings: typeof import('./settingsService')
  let terminal: Promise<AgentStreamEvent> | undefined
  beforeEach(async () => {
    vi.resetModules()
    mocks.home = await fs.mkdtemp(join(tmpdir(), 'desktop-web-workflow-'))
    mocks.web = 0
    mocks.review = 0
    mocks.lost = false
    mocks.afterReceipt = undefined
    mocks.generate
      .mockReset()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'web-call',
            name: 'web_search',
            arguments: { query: 'Electron public sandbox docs' }
          }
        ]
      })
      .mockResolvedValue({ content: 'Result', toolCalls: [] })
    settings = await import('./settingsService')
    settings.setSettings({
      ...settings.getSettings(),
      aiProvider: 'deepseek',
      deepseekApiKey: 'offline-chat-fixture',
      agentReviewerProvider: 'openai',
      openaiApiKey: 'offline-review-fixture',
      webProvider: 'deepseek',
      deepseekWebKeySource: 'separate',
      deepseekWebApiKey: 'offline-web-fixture'
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url) === 'https://api.deepseek.com/v1/tools/search') {
          mocks.web++
          const stored = JSON.parse(
            await fs.readFile(join(mocks.home, 'agent-web-outcomes.json'), 'utf8')
          )
          expect(stored.records.at(-1)).toMatchObject({
            outcome: 'pending',
            requestState: 'unknown',
            callId: 'web-call'
          })
          expect(new Headers(init!.headers).get('authorization')).toBe('Bearer offline-web-fixture')
          expect(JSON.parse(String(init!.body))).toEqual({
            query: 'Electron public sandbox docs',
            count: 5,
            need_content: false
          })
          if (mocks.lost) throw new Error('offline lost response')
          if (mocks.afterReceipt) {
            const bytes = new TextEncoder().encode(JSON.stringify({ results: [] }))
            return new Response(
              new ReadableStream(
                {
                  pull(controller) {
                    mocks.afterReceipt?.()
                    controller.enqueue(bytes)
                    controller.close()
                  }
                },
                { highWaterMark: 0 }
              ),
              { headers: { 'content-type': 'application/json' } }
            )
          }
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: 'Docs',
                  url: 'https://example.com/docs',
                  snippet: 'Data',
                  summary: 'Summary',
                  content: 'Source evidence'
                }
              ]
            })
          )
        }
        if (String(url) === 'https://api.openai.com/v1/decisions') {
          mocks.review++
          const body = JSON.parse(String(init!.body))
          expect(new Headers(init!.headers).get('authorization')).toBe(
            'Bearer offline-review-fixture'
          )
          return new Response(
            JSON.stringify({
              model: 'gpt-6-luna',
              answers: body.questions.map((q: { name: string }) => ({
                name: q.name,
                type: 'predicate',
                probability: 1
              })),
              usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 }
              }
            }),
            { headers: { 'content-type': 'application/json' } }
          )
        }
        throw new Error('Unexpected offline endpoint')
      })
    )
    agent = await import('./agentService')
  })
  afterEach(async () => {
    agent.stopAgentRuns()
    if (terminal) await terminal
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent.setAgentEventSink(null)
    vi.unstubAllGlobals()
    await fs.rm(mocks.home, { recursive: true, force: true })
  })
  async function create(web = false) {
    const session = await agent.createAgentSession(settings.getSettings())
    await agent.enrollAgentAutoReview(session.id, {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai',
      accountRevision: settings.getSettings().agentDecisionAccountRevision!,
      ...(web
        ? {
            web: {
              policyRevision: AGENT_WEB_POLICY_REVISION,
              accountRevision: settings.getSettings().agentWebAccountRevision!
            }
          }
        : {})
    })
    return session
  }
  async function start(id: string) {
    const events: AgentStreamEvent[] = []
    terminal = new Promise((resolve) =>
      agent.setAgentEventSink((event) => {
        events.push(structuredClone(event))
        if (event.type === 'done' || event.type === 'error') resolve(event)
      })
    )
    await agent.runAgentSession(
      id,
      'Find Electron public sandbox documentation',
      settings.getSettings()
    )
    return events
  }
  async function approval(events: AgentStreamEvent[]): Promise<AgentToolCall> {
    await vi.waitFor(() => expect(events.some((event) => event.type === 'approval')).toBe(true))
    return events.find((event) => event.type === 'approval')!.toolCall!
  }
  it('uses a separately selected reviewer for DeepSeek chat and auto-approves relevant generated retrieval only after paid enrollment', async () => {
    const session = await create(true)
    const events = await start(session.id)
    await vi.waitFor(() =>
      expect(mocks.web || events.some((e) => e.type === 'approval')).toBeTruthy()
    )
    if (events.some((e) => e.type === 'approval'))
      throw new Error(JSON.stringify(events.find((e) => e.type === 'approval')?.toolCall?.decision))
    await terminal
    expect(events.some((event) => event.type === 'approval')).toBe(false)
    expect(mocks.review).toBe(1)
    expect(mocks.web).toBe(1)
    const current = (await agent.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    const call = current.messages.flatMap((message) => message.toolCalls || [])[0]
    expect(call.decision?.source).toBe('automatic')
    expect(call.web).toMatchObject({ outcome: 'confirmed', requestState: 'response_received' })
  })
  it('keeps old Auto enrollment manual for web, rejects forged approvals and persists one exact human decision', async () => {
    const session = await create()
    const events = await start(session.id)
    const call = await approval(events)
    expect(mocks.review).toBe(0)
    expect(mocks.web).toBe(0)
    expect(call.after).toMatchObject({
      endpoint: 'https://api.deepseek.com/v1/tools/search',
      request: { query: 'Electron public sandbox docs' },
      cost: { documentedEstimatePerRequest: 0.00075 }
    })
    expect(await agent.resolveAgentApproval(session.id, call.id, true, 'forged')).toBe(false)
    expect(await agent.resolveAgentApproval(session.id, call.id, true, call.approvalId)).toBe(true)
    await terminal
    expect(mocks.web).toBe(1)
    expect(await agent.resolveAgentApproval(session.id, call.id, true, call.approvalId)).toBe(false)
  })
  it('never expands Plan mode into remote reads and can reject an exact manual request', async () => {
    const session = await create()
    await agent.updateAgentSession(session.id, { mode: 'planning' }, 'deepseek')
    await start(session.id)
    await terminal
    expect(mocks.web).toBe(0)
    expect(mocks.review).toBe(0)
    mocks.generate
      .mockReset()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [{ id: 'web-call-2', name: 'web_search', arguments: { query: 'Electron docs' } }]
      })
      .mockResolvedValue({ content: 'Done', toolCalls: [] })
    await agent.updateAgentSession(session.id, { mode: 'manual' }, 'deepseek')
    const events = await start(session.id)
    const call = await approval(events)
    await agent.resolveAgentApproval(session.id, call.id, false, call.approvalId)
    await terminal
    expect(mocks.web).toBe(0)
  })
  it('invalidates only paid-web enrollment on web account changes, and cancels an in-flight exact approval', async () => {
    const session = await create(true)
    const account = settings.getSettings()
    settings.setSettings({ ...account, deepseekWebApiKey: 'other-web-fixture' })
    let current = (await agent.loadAgentSessions()).sessions.find((item) => item.id === session.id)!
    expect(current.autoReviewEnrollment?.web).toBeUndefined()
    expect(current.mode).toBe('auto')
    const events = await start(session.id)
    const call = await approval(events)
    settings.setSettings({ ...settings.getSettings(), deepseekWebKeySource: 'chat' })
    await terminal
    expect(mocks.web).toBe(0)
    expect(await agent.resolveAgentApproval(session.id, call.id, true, call.approvalId)).toBe(false)
    current = (await agent.loadAgentSessions()).sessions.find((item) => item.id === session.id)!
    expect(current.status).toBe('cancelled')
  })
  it('journals a lost paid response as unknown without retry', async () => {
    mocks.lost = true
    const session = await create(true)
    const events = await start(session.id)
    await vi.waitFor(() =>
      expect(mocks.web || events.some((e) => e.type === 'approval')).toBeTruthy()
    )
    if (events.some((e) => e.type === 'approval'))
      throw new Error(JSON.stringify(events.find((e) => e.type === 'approval')?.toolCall?.decision))
    await terminal
    expect(mocks.web).toBe(1)
    const audit = JSON.parse(await fs.readFile(join(mocks.home, 'agent-web-outcomes.json'), 'utf8'))
    expect(audit.records[0]).toMatchObject({ outcome: 'unknown', requestState: 'unknown' })
    mocks.generate
      .mockReset()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          {
            id: 'web-retry',
            name: 'web_search',
            arguments: { query: 'Electron public sandbox docs' }
          }
        ]
      })
      .mockResolvedValue({ content: 'Stopped', toolCalls: [] })
    const nextEvents = await start(session.id)
    const nextCall = await approval(nextEvents)
    expect(nextCall.after).toMatchObject({
      previousOutcome: expect.stringContaining('unknown outcome')
    })
    expect(mocks.web).toBe(1)
    expect(mocks.review).toBe(1)
    await agent.resolveAgentApproval(session.id, nextCall.id, false, nextCall.approvalId)
    await terminal
  })
  it('retains known paid receipt in both audits after cancellation during settlement', async () => {
    const session = await create(true)
    mocks.afterReceipt = () => {
      agent.cancelAgentRun(session.id)
    }
    await start(session.id)
    await terminal
    const web = JSON.parse(await fs.readFile(join(mocks.home, 'agent-web-outcomes.json'), 'utf8'))
    const decisions = JSON.parse(
      await fs.readFile(join(mocks.home, 'agent-decisions.json'), 'utf8')
    )
    expect(web.records[0]).toMatchObject({
      outcome: 'confirmed',
      requestState: 'response_received'
    })
    expect(decisions.rows[0].state).toBe('committed')
    const current = (await agent.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    expect(current.status).toBe('cancelled')
    expect(current.messages.flatMap((message) => message.toolCalls || [])[0].web).toMatchObject({
      outcome: 'confirmed',
      requestState: 'response_received'
    })
    expect(mocks.web).toBe(1)
  })
})
