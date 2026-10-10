import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { HistoryMessage, JsonValue, ToolCall, ToolResult } from '@ayayaq/vivi'
import type { AgentMode, AgentSession, AgentStreamEvent } from '../../shared/agentTypes'
import type { AiRuntimeSettings } from './aiProviderService'
import type { PreparedMutation } from './agentTools'
import type { BCFDCommand } from '../types/types'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'
import { createPlaygroundState } from '../../shared/playground/types'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import type {
  AgentValidationRequest,
  AgentValidationSuite
} from '../../shared/agentValidationTypes'

// Electron's data directory, host domain/tool seam and offline validation executor are replaced. The agent loop,
// extension registry, calculator, providers, history recovery and persistence are published/real.
const host = vi.hoisted(() => ({
  directory: '',
  prepare: vi.fn(),
  commit: vi.fn(),
  read: vi.fn(),
  lint: vi.fn(),
  validate: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => host.directory } }))
vi.mock('./agentTools', () => ({
  agentToolTargetLabel: (name: string) => (name === 'edit_command' ? 'Fixture command' : undefined),
  agentToolDefinitions: [
    {
      type: 'function',
      function: {
        name: 'read_command',
        description: 'Read the isolated fixture command and its revision',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_command',
        description: 'Edit the isolated fixture command with a current revision',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            expectedRevision: { type: 'string' },
            patches: { type: 'array' },
            validation: { type: 'object' }
          },
          required: ['id', 'expectedRevision', 'patches', 'validation'],
          additionalProperties: false
        }
      }
    }
  ],
  mutationToolNames: new Set(['edit_command']),
  prepareMutation: host.prepare,
  initializeMutationReviewResource: vi.fn(async () => undefined),
  currentMutationReviewRevision: vi.fn(() => 'fixture-resource-revision'),
  commitMutation: host.commit,
  executeReadTool: host.read,
  lintPreparedMutation: host.lint
}))

// Ordinary extension regressions retain real host enrollment and commit gates, with
// an explicitly mocked allow recommendation. Reviewer/ledger behavior is tested separately.
vi.mock('./agentAutoReview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentAutoReview')>()
  return {
    ...actual,
    reviewAgentMutation: vi.fn(async ({ enrollment }) => {
      if (!enrollment) throw new Error('Reviewer fixture requires explicit Auto enrollment')
      return {
        display: {
          id: 'mock-reviewed-allow',
          policyRevision: AUTO_REVIEW_POLICY_REVISION,
          reasonCode: 'mocked_allow',
          recommendation: 'allow',
          source: 'automatic'
        },
        automatic: true,
        assertCurrent: vi.fn(),
        beginCommit: vi.fn(async () => true),
        settle: vi.fn(async () => true)
      }
    })
  }
})
// Credential encryption/storage is outside the extension transport and fixture writer.
vi.mock('./fileService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fileService')>()),
  saveSettings: vi.fn(async () => undefined)
}))

vi.mock('./agentValidationService', () => ({ validatePreparedResource: host.validate }))

type Provider = 'openai' | 'openrouter'
type Agents = typeof import('./agentService')
type FixtureCommand = BCFDCommand
interface RecordedRequest {
  url: string
  init: RequestInit
  body: {
    model: string
    stream: boolean
    input?: Record<string, unknown>[]
    messages?: Record<string, unknown>[]
    tools: Record<string, unknown>[]
  }
}
interface Turn {
  calls?: ToolCall[]
  text?: string
  native?: boolean
}

const initialCommand: FixtureCommand = {
  ...decodeBCFDCommand({
    id: 'fixture-command',
    command: '!fixture',
    commandDescription: 'Fixture command',
    channelMessage: 'Before',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    type: 0
  }).command
}
const requests: RecordedRequest[] = []
const fetchMock = vi.fn<typeof fetch>()
const timestamp = '2026-01-01T00:00:00.000Z'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((yes) => (resolve = yes))
  return { promise, resolve }
}

function settings(provider: Provider = 'openai'): AiRuntimeSettings {
  return {
    aiProvider: provider,
    openaiApiKey: 'ordinary-fake-openai-string',
    openrouterApiKey: 'ordinary-fake-openrouter-string',
    selectedOpenAiModel: 'gpt-5.4-nano',
    selectedOpenRouterModel: 'fixture-openrouter-model'
  }
}

function calculate(id = 'calculate-call'): ToolCall {
  return { id, name: 'calculate', arguments: { expression: '(5 + 2) * 6' } }
}

async function readCommand(): Promise<FixtureCommand> {
  return JSON.parse(await fs.readFile(join(host.directory, 'commands.json'), 'utf8'))
}

async function writeCommand(command: FixtureCommand): Promise<void> {
  const { atomicWrite } = await import('./atomicPersistence')
  await atomicWrite(join(host.directory, 'commands.json'), JSON.stringify(command), {
    validate: (bytes) => {
      const parsed = JSON.parse(bytes) as FixtureCommand
      if (parsed.id !== initialCommand.id || typeof parsed.channelMessage !== 'string') {
        throw new Error('Invalid fixture command')
      }
    }
  })
}

async function editCall(id = 'edit-call', content = 'After'): Promise<ToolCall> {
  const { resourceRevision } = await import('./resourceChangeService')
  return {
    id,
    name: 'edit_command',
    arguments: {
      id: initialCommand.id,
      expectedRevision: resourceRevision(await readCommand()),
      patches: [{ op: 'replace', path: '/channelMessage', value: content }],
      validation: JSON.parse(JSON.stringify(mutationValidationSuite(content))) as JsonValue
    }
  }
}

function mutationValidationSuite(content: string): AgentValidationSuite {
  const state = createPlaygroundState()
  return {
    cases: [
      {
        name: 'updated fixture reply',
        state,
        steps: [
          {
            kind: 'message',
            senderId: state.members[0].id,
            content: initialCommand.command,
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: content }
            ]
          }
        ]
      }
    ]
  }
}

function passingValidationReport(input: AgentValidationRequest) {
  const report = createNotRunAgentValidationReport(input, 'mock execution')
  report.outcome = 'passed'
  report.coverage.executed = 1
  report.coverage.matched = 1
  report.coverage.notRun = 0
  report.cases[0].outcome = 'passed'
  Object.assign(report.cases[0].steps[0], {
    outcome: 'passed',
    executionOutcome: 'executed',
    matched: true,
    executed: true,
    assertions: input.suite.cases[0].steps[0].assertions.map((assertion) => ({
      path: assertion.path,
      expected: assertion.equals,
      actual: assertion.equals,
      actualPresent: true,
      passed: true
    }))
  })
  return report
}

function sse(frames: (JsonValue | '[DONE]')[]): Response {
  return new Response(
    frames
      .map((frame) => `data: ${frame === '[DONE]' ? frame : JSON.stringify(frame)}\n\n`)
      .join(''),
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}

function streamingTurn(provider: Provider, turn: Turn, index: number): Response {
  const calls = turn.calls ?? []
  const text = turn.text ?? ''
  if (provider === 'openai') {
    const output: JsonValue[] = [
      ...(turn.native
        ? [
            {
              type: 'reasoning',
              id: `reasoning_${index}`,
              summary: [],
              encrypted_content: 'fake-opaque-state'
            }
          ]
        : []),
      ...calls.map((call) => ({
        type: 'function_call',
        id: `native_${call.id}`,
        status: 'completed',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments)
      })),
      ...(text
        ? [
            {
              type: 'message',
              id: `answer_${index}`,
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }]
            }
          ]
        : [])
    ]
    return sse([
      ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          output,
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
        }
      }
    ])
  }
  // Arguments are split across real streaming frames; identities and native reasoning survive
  // assembly and are carried back into the provider's subsequent request.
  return sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            ...(text ? { content: text } : {}),
            ...(turn.native
              ? {
                  reasoning_details: [
                    {
                      type: 'reasoning.encrypted',
                      data: 'fake-opaque-state',
                      id: `reasoning_${index}`
                    }
                  ]
                }
              : {}),
            ...(calls.length
              ? {
                  tool_calls: calls.map((call, callIndex) => ({
                    index: callIndex,
                    id: call.id,
                    type: 'function',
                    function: {
                      name: call.name,
                      arguments: JSON.stringify(call.arguments).slice(0, 7)
                    }
                  }))
                }
              : {})
          },
          finish_reason: null
        }
      ]
    },
    {
      choices: [
        {
          index: 0,
          delta: calls.length
            ? {
                tool_calls: calls.map((call, callIndex) => ({
                  index: callIndex,
                  function: { arguments: JSON.stringify(call.arguments).slice(7) }
                }))
              }
            : {},
          finish_reason: calls.length ? 'tool_calls' : 'stop'
        }
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
    },
    '[DONE]'
  ])
}

function transport(provider: Provider, turns: Turn[]): void {
  let index = 0
  const expectedUrl =
    provider === 'openai'
      ? 'https://api.openai.com/v1/responses'
      : 'https://openrouter.ai/api/v1/chat/completions'
  fetchMock.mockImplementation(async (url, init) => {
    // Fail closed rather than falling back to the network, including unexpected moderation,
    // model discovery, provider retries, or extra generations.
    if (String(url) !== expectedUrl) throw new Error(`Unexpected fixture URL: ${String(url)}`)
    if (init?.method !== 'POST') throw new Error('Unexpected fixture HTTP method')
    const body = JSON.parse(init.body as string) as RecordedRequest['body']
    if (body.stream !== true) throw new Error('Expected a real streaming provider request')
    requests.push({ url: String(url), init, body })
    const turn = turns[index++]
    if (!turn) throw new Error('Unexpected extra provider round')
    return streamingTurn(provider, turn, index)
  })
}

function observe(agents: Agents, hook?: (event: AgentStreamEvent) => void) {
  const events: AgentStreamEvent[] = []
  const terminal = deferred<AgentSession>()
  agents.setAgentEventSink((event) => {
    events.push(structuredClone(event))
    hook?.(event)
    if (event.type === 'done' || event.type === 'error') terminal.resolve(event.session!)
  })
  return { events, terminal: terminal.promise }
}

async function start(
  agents: Agents,
  mode: AgentMode = 'manual',
  provider: Provider = 'openai'
): Promise<AgentSession> {
  const session = await agents.createAgentSession(settings(provider))
  if (mode === 'auto') {
    const currentSettings = await import('./settingsService')
    currentSettings.setSettings({ ...currentSettings.getSettings(), ...settings(provider) })
    await agents.enrollAgentAutoReview(session.id, {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider,
      accountRevision: currentSettings.getSettings().agentDecisionAccountRevision!
    })
  } else if (mode !== 'manual') await agents.updateAgentSession(session.id, { mode }, provider)
  await agents.runAgentSession(
    session.id,
    'Use the calculator and inspect this fixture',
    settings(provider)
  )
  return session
}

async function storedSession(id: string): Promise<AgentSession> {
  const stored = JSON.parse(await fs.readFile(join(host.directory, 'agent-sessions.json'), 'utf8'))
  return stored.sessions.find((session: AgentSession) => session.id === id)
}

function toolResults(session: AgentSession) {
  return session.history!.filter((item) => item.kind === 'tool_result')
}

function displayCalls(session: AgentSession) {
  return session.messages.flatMap((message) => message.toolCalls ?? [])
}

function assertMatchedHistory(history: HistoryMessage[]): void {
  const calls = history
    .filter((item) => item.kind === 'assistant')
    .flatMap((item) => item.toolCalls)
  const results = history.filter((item) => item.kind === 'tool_result')
  expect(results.map((result) => [result.callId, result.name])).toEqual(
    calls.map((call) => [call.id, call.name])
  )
  expect(new Set(calls.map((call) => call.id)).size).toBe(calls.length)
}

function assertNativeContinuation(provider: Provider, request: RecordedRequest): void {
  if (provider === 'openai') {
    expect(request.body.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', encrypted_content: 'fake-opaque-state' }),
        expect.objectContaining({
          type: 'function_call',
          id: 'native_calculate-call',
          call_id: 'calculate-call',
          name: 'calculate',
          arguments: JSON.stringify(calculate().arguments)
        }),
        { type: 'function_call_output', call_id: 'calculate-call', output: '{"result":42}' }
      ])
    )
  } else {
    expect(request.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          reasoning_details: [
            { type: 'reasoning.encrypted', data: 'fake-opaque-state', id: 'reasoning_1' }
          ],
          tool_calls: [
            {
              id: 'calculate-call',
              type: 'function',
              function: { name: 'calculate', arguments: JSON.stringify(calculate().arguments) }
            }
          ]
        }),
        { role: 'tool', tool_call_id: 'calculate-call', content: '{"result":42}' }
      ])
    )
  }
}

beforeEach(async () => {
  vi.resetModules()
  const currentSettings = await import('./settingsService')
  currentSettings.setSettings({ ...currentSettings.getSettings(), ...settings() })
  const { modelCapabilityCatalog } = await import('./modelCapabilityService')
  const key = settings('openrouter').openrouterApiKey
  const generation = modelCapabilityCatalog.begin('openrouter', key)
  modelCapabilityCatalog.complete('openrouter', key, generation, [
    {
      id: 'fixture-openrouter-model',
      supported_parameters: ['tools'],
      architecture: { input_modalities: ['text'], output_modalities: ['text'] }
    }
  ])
  host.directory = await fs.mkdtemp(join(tmpdir(), 'agent-registry-integration-'))
  host.prepare.mockReset()
  host.commit.mockReset()
  host.read.mockReset()
  host.lint.mockReset()
  host.validate.mockReset()
  host.lint.mockResolvedValue([])
  host.validate.mockImplementation(async (input) => passingValidationReport(input))
  fetchMock.mockReset()
  requests.length = 0
  vi.stubGlobal('fetch', fetchMock)
  await writeCommand(initialCommand)
  const { resourceRevision, withResourceMutationLock } = await import('./resourceChangeService')
  host.read.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'read_command' || args.id !== initialCommand.id)
      throw new Error('Unknown fixture read')
    const command = await readCommand()
    return { command, revision: resourceRevision(command) }
  })
  host.prepare.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name !== 'edit_command' || args.id !== initialCommand.id)
      throw new Error('Unknown fixture mutation')
    const before = await readCommand()
    if (resourceRevision(before) !== args.expectedRevision)
      throw new Error('Resource revision is stale; read again')
    const patch = (args.patches as { op: string; path: string; value: unknown }[])[0]
    if (
      patch?.op !== 'replace' ||
      patch.path !== '/channelMessage' ||
      typeof patch.value !== 'string'
    ) {
      throw new Error('Unsupported fixture patch')
    }
    return {
      name,
      arguments: args,
      before,
      after: { ...before, channelMessage: patch.value },
      target: { type: 'command', id: before.id }
    } satisfies PreparedMutation
  })
  host.commit.mockImplementation(
    async (
      prepared: PreparedMutation,
      actor: string,
      signal: AbortSignal,
      beforeCommit?: (snapshot: PreparedMutation) => void
    ) =>
      withResourceMutationLock('commands', async () => {
        expect(actor).toBe('agent')
        signal.throwIfAborted()
        beforeCommit?.(structuredClone(prepared))
        const current = await readCommand()
        if (resourceRevision(current) !== prepared.arguments.expectedRevision) {
          throw new Error('Resource revision is stale; read again')
        }
        signal.throwIfAborted()
        await writeCommand(prepared.after as FixtureCommand)
        return {
          success: true,
          command: prepared.after,
          revision: resourceRevision(prepared.after)
        }
      })
  )
})

afterEach(async () => {
  const agents = await import('./agentService')
  agents.stopAgentRuns()
  agents.setAgentEventSink(null)
  const lifecycle = await import('./agentPersistenceLifecycle')
  lifecycle.pauseAgentPersistence()
  await lifecycle.drainAgentPersistence()
  const resources = await import('./resourceChangeService')
  await resources.drainResourceMutations()
  const atomic = await import('./atomicPersistence')
  await atomic.closeAndDrainAtomicWrites()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await fs.rm(host.directory, { recursive: true, force: true })
})

describe('published registry calculator in the recoverable desktop agent', () => {
  it.each(['openai', 'openrouter'] as const)(
    'executes and reloads a matched %s streaming calculator exchange with native continuation',
    async (provider) => {
      transport(provider, [
        { calls: [calculate()], native: true },
        { text: 'The result is 42' },
        { text: 'The saved result is still 42' }
      ])
      let agents = await import('./agentService')
      const first = observe(agents)
      const session = await start(agents, 'manual', provider)
      const completed = await first.terminal
      expect(completed.status).toBe('completed')
      expect(displayCalls(completed)).toMatchObject([
        { id: 'calculate-call', name: 'calculate', status: 'completed', result: { result: 42 } }
      ])
      expect(
        first.events.some(
          (event) => event.type === 'text_delta' && event.delta === 'The result is 42'
        )
      ).toBe(true)
      expect(first.events.some((event) => event.type === 'approval')).toBe(false)
      expect(host.read).not.toHaveBeenCalled()
      expect(host.prepare).not.toHaveBeenCalled()
      expect(host.commit).not.toHaveBeenCalled()
      expect(requests).toHaveLength(2)
      assertMatchedHistory(completed.history!)
      expect(toolResults(completed)).toMatchObject([
        { callId: 'calculate-call', name: 'calculate', content: '{"result":42}', isError: false }
      ])
      assertNativeContinuation(provider, requests[1])
      expect(
        requests[0].body.tools.map((tool) =>
          provider === 'openai' ? tool.name : (tool.function as { name: string }).name
        )
      ).toContain('calculate')
      expect(await storedSession(session.id)).toEqual(completed)
      const { drainAgentPersistence } = await import('./agentPersistenceLifecycle')
      await drainAgentPersistence()
      vi.resetModules()
      agents = await import('./agentService')
      const loaded = (await agents.loadAgentSessions()).sessions[0]
      expect(loaded.history).toEqual(completed.history)
      const resumed = observe(agents)
      await agents.runAgentSession(session.id, 'What was the result?', settings(provider))
      const reloaded = await resumed.terminal
      expect(reloaded.status).toBe('completed')
      expect(requests).toHaveLength(3)
      assertNativeContinuation(provider, requests[2])
      assertMatchedHistory(reloaded.history!)
      expect(displayCalls(reloaded)).toHaveLength(1)
      expect(await readCommand()).toEqual(initialCommand)
      expect(await storedSession(session.id)).toEqual(reloaded)
      expect(await fs.readdir(host.directory)).toEqual(
        expect.arrayContaining([
          'agent-sessions.json',
          'agent-sessions.json.bak',
          'agent-memories.json'
        ])
      )
      expect((await fs.readdir(host.directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
    }
  )

  it.each([true, false])(
    'preserves manual approval=%s in a calculator/mutation batch',
    async (approved) => {
      const mutation = await editCall()
      transport('openai', [{ calls: [calculate(), mutation] }, { text: 'Batch handled' }])
      const agents = await import('./agentService')
      const observed = observe(agents)
      const session = await start(agents)
      await vi.waitFor(() =>
        expect(observed.events.filter((event) => event.type === 'approval')).toHaveLength(1)
      )
      await vi.waitFor(async () =>
        expect((await storedSession(session.id)).status).toBe('waiting_approval')
      )
      const pending = await storedSession(session.id)
      expect(displayCalls(pending)).toMatchObject([
        { name: 'calculate', status: 'completed', result: { result: 42 } },
        {
          name: 'edit_command',
          status: 'waiting_approval',
          before: initialCommand,
          after: { ...initialCommand, channelMessage: 'After' }
        }
      ])
      expect(host.commit).not.toHaveBeenCalled()
      expect(host.validate).toHaveBeenCalledOnce()
      expect(displayCalls(pending)[1].validation).toMatchObject({
        outcome: 'passed',
        candidateId: initialCommand.id
      })
      const { resourceRevision } = await import('./resourceChangeService')
      expect(displayCalls(pending)[1].validationBinding).toMatchObject({
        baseRevision: resourceRevision(initialCommand),
        wrapEvalInIIFE: true
      })
      expect(await readCommand()).toEqual(initialCommand)
      const approvalId = observed.events.find((event) => event.type === 'approval')!.toolCall!
        .approvalId
      expect(await agents.resolveAgentApproval(session.id, mutation.id, approved, approvalId)).toBe(
        true
      )
      const completed = await observed.terminal
      expect(completed.status).toBe('completed')
      expect(displayCalls(completed)[1].status).toBe(approved ? 'completed' : 'rejected')
      expect(host.prepare).toHaveBeenCalledOnce()
      expect(host.commit).toHaveBeenCalledTimes(approved ? 1 : 0)
      expect(await readCommand()).toEqual({
        ...initialCommand,
        channelMessage: approved ? 'After' : 'Before'
      })
      expect(JSON.parse(toolResults(completed)[1].content)).toMatchObject(
        approved
          ? { success: true, command: { channelMessage: 'After' } }
          : { success: false, denied: true }
      )
      assertMatchedHistory(completed.history!)
      expect(await agents.resolveAgentApproval(session.id, mutation.id, approved, approvalId)).toBe(
        false
      )
      if (approved) {
        expect(
          JSON.parse(await fs.readFile(join(host.directory, 'commands.json.bak'), 'utf8'))
        ).toEqual(initialCommand)
      }
    }
  )

  it('commits an enrolled Auto mixed batch after a mocked allow review through the real lock and atomic writer', async () => {
    const mutation = await editCall()
    transport('openai', [
      {
        calls: [
          { id: 'read-call', name: 'read_command', arguments: { id: initialCommand.id } },
          calculate(),
          mutation
        ]
      },
      { text: 'Auto edit saved' }
    ])
    const agents = await import('./agentService')
    const observed = observe(agents)
    const session = await start(agents, 'auto')
    const completed = await observed.terminal
    expect(completed.status).toBe('completed')
    expect(observed.events.some((event) => event.type === 'approval')).toBe(false)
    expect(host.read).toHaveBeenCalledOnce()
    expect(host.prepare).toHaveBeenCalledOnce()
    expect(host.commit).toHaveBeenCalledOnce()
    expect(host.validate).toHaveBeenCalledOnce()
    expect(host.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      host.validate.mock.invocationCallOrder[0]
    )
    expect(displayCalls(completed).map((call) => call.status)).toEqual([
      'completed',
      'completed',
      'completed'
    ])
    expect(await readCommand()).toEqual({ ...initialCommand, channelMessage: 'After' })
    assertMatchedHistory(completed.history!)
    expect(await storedSession(session.id)).toEqual(completed)
  })

  it('keeps planning read-only when a provider returns a mixed calculator/mutation batch', async () => {
    transport('openai', [
      { calls: [calculate(), await editCall()] },
      { text: '<proposed_plan>Read-only plan</proposed_plan>' }
    ])
    const agents = await import('./agentService')
    const observed = observe(agents)
    await start(agents, 'planning')
    const completed = await observed.terminal
    expect(completed).toMatchObject({ status: 'completed', planReady: true })
    expect(requests[0].body.tools.map((tool) => tool.name)).toEqual([
      'read_command',
      'calculate',
      'list_skills',
      'read_skill'
    ])
    expect(displayCalls(completed)).toMatchObject([{ name: 'calculate', result: { result: 42 } }])
    expect(toolResults(completed)[1]).toMatchObject({
      callId: 'edit-call',
      name: 'edit_command',
      isError: true
    })
    expect(JSON.parse(toolResults(completed)[1].content)).toMatchObject({
      error: { code: 'unavailable_tool' }
    })
    expect(host.prepare).not.toHaveBeenCalled()
    expect(host.commit).not.toHaveBeenCalled()
    expect(observed.events.some((event) => event.type === 'approval')).toBe(false)
    expect(await readCommand()).toEqual(initialCommand)
    assertMatchedHistory(completed.history!)
  })

  it('refuses a stale revision under the real commit lock after manual approval is delayed', async () => {
    const mutation = await editCall()
    transport('openai', [
      { calls: [calculate(), mutation] },
      { text: 'The stale edit was refused' }
    ])
    const agents = await import('./agentService')
    const observed = observe(agents)
    const session = await start(agents)
    await vi.waitFor(() =>
      expect(observed.events.some((event) => event.type === 'approval')).toBe(true)
    )
    const { withResourceMutationLock } = await import('./resourceChangeService')
    const external = { ...initialCommand, channelMessage: 'Changed while approval was pending' }
    await withResourceMutationLock('commands', () => writeCommand(external))
    const approvalId = observed.events.find((event) => event.type === 'approval')!.toolCall!
      .approvalId
    expect(await agents.resolveAgentApproval(session.id, mutation.id, true, approvalId)).toBe(true)
    const completed = await observed.terminal
    expect(completed.status).toBe('completed')
    expect(host.commit).toHaveBeenCalledOnce()
    expect(displayCalls(completed)[1]).toMatchObject({
      status: 'error',
      error: expect.stringContaining('revision is stale')
    })
    expect(toolResults(completed)[1]).toMatchObject({ isError: true })
    expect(await readCommand()).toEqual(external)
    assertMatchedHistory(completed.history!)
  })

  it('cancels between calculator and mutation without executing the rest of the accepted batch', async () => {
    transport('openai', [
      { calls: [calculate(), await editCall(), calculate('later-calculation')] }
    ])
    const agents = await import('./agentService')
    const observed = observe(agents, (event) => {
      if (
        event.type === 'tool' &&
        event.toolCall?.id === 'calculate-call' &&
        event.toolCall.status === 'completed'
      ) {
        agents.cancelAgentRun(event.sessionId)
      }
    })
    const session = await start(agents, 'auto')
    const cancelled = await observed.terminal
    expect(cancelled.status).toBe('cancelled')
    expect(displayCalls(cancelled)).toMatchObject([
      { name: 'calculate', status: 'completed', result: { result: 42 } }
    ])
    expect(displayCalls(cancelled)).toHaveLength(1)
    expect(host.prepare).not.toHaveBeenCalled()
    expect(host.commit).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
    expect(toolResults(cancelled)).toHaveLength(3)
    expect(JSON.parse(toolResults(cancelled)[1].content)).toMatchObject({
      error: { code: 'cancelled' }
    })
    assertMatchedHistory(cancelled.history!)
    expect(await readCommand()).toEqual(initialCommand)
    expect(await storedSession(session.id)).toEqual(cancelled)
  })

  it('closes an interrupted extension checkpoint as unknown without replaying it on reload', async () => {
    const call = calculate('interrupted-calculation')
    const checkpoint: AgentSession = {
      id: 'interrupted-session',
      title: 'Interrupted calculator',
      mode: 'auto',
      model: 'gpt-5.4-nano',
      reasoningEffort: 'none',
      status: 'running',
      activeRunId: 'old-run',
      createdAt: timestamp,
      updatedAt: timestamp,
      planReady: false,
      tokenCount: 0,
      messages: [
        {
          id: 'unfinished-display',
          role: 'tool',
          content: 'calculate',
          timestamp,
          toolCalls: [{ ...call, status: 'running', createdAt: timestamp }]
        }
      ],
      history: [
        { kind: 'message', role: 'user', content: 'Calculate this' },
        { kind: 'assistant', content: '', toolCalls: [call] }
      ]
    }
    const { atomicWrite } = await import('./atomicPersistence')
    await atomicWrite(
      join(host.directory, 'agent-sessions.json'),
      JSON.stringify({
        sessions: [checkpoint],
        activeSessionId: checkpoint.id,
        modelDefaultsByProvider: {}
      })
    )
    const agents = await import('./agentService')
    const recovered = (await agents.loadAgentSessions()).sessions[0]
    expect(recovered).toMatchObject({ status: 'interrupted' })
    expect(recovered.activeRunId).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(displayCalls(recovered)[0]).toMatchObject({
      status: 'error',
      result: { interrupted: true, outcome: 'unknown' }
    })
    const result = toolResults(recovered)[0]
    expect(result).toMatchObject({ callId: call.id, name: 'calculate', isError: true })
    expect(JSON.parse(result.content)).toMatchObject({
      error: { code: 'interrupted', message: expect.stringContaining('outcome may be unknown') }
    })
    assertMatchedHistory(recovered.history!)
    transport('openai', [{ text: 'The interrupted calculation was not retried' }])
    const observed = observe(agents)
    await agents.runAgentSession(checkpoint.id, 'Continue without replaying tools', settings())
    const completed = await observed.terminal
    expect(completed.status).toBe('completed')
    expect(requests).toHaveLength(1)
    expect(requests[0].body.input).toEqual(
      expect.arrayContaining([
        { type: 'function_call_output', call_id: call.id, output: result.content }
      ])
    )
    expect(displayCalls(completed)).toHaveLength(1)
    expect(displayCalls(completed)[0].result).not.toEqual({ result: 42 })
    expect(host.prepare).not.toHaveBeenCalled()
    expect(host.commit).not.toHaveBeenCalled()
    expect(await storedSession(checkpoint.id)).toEqual(completed)
  })

  it.each(['cancel', 'shutdown'] as const)(
    '%s drains the final checkpoint of an active extension and ignores a bounded late executor',
    async (action) => {
      // The sole extension fault injection: a trusted executor deliberately ignores abort until
      // released. The published registry and runAgent still own cancellation and late-output guards.
      const { calculatorExtension } = await import('@ayayaq/vivi/extensions/calculator')
      const entered = deferred<AbortSignal>()
      const late = deferred<ToolResult>()
      const returned = deferred()
      const executor = vi
        .spyOn(calculatorExtension.tools[0], 'execute')
        .mockImplementation(async (_call, { signal }) => {
          entered.resolve(signal)
          const result = await late.promise
          returned.resolve()
          return result
        })
      transport('openai', [{ calls: [calculate(), await editCall()] }])
      const agents = await import('./agentService')
      const observed = observe(agents)
      const session = await start(agents, 'auto')
      const signal = await entered.promise
      const lifecycle = await import('./agentPersistenceLifecycle')
      if (action === 'shutdown') {
        lifecycle.pauseAgentPersistence()
        agents.stopAgentRuns()
      } else {
        expect(agents.cancelAgentRun(session.id)).toBe(true)
      }
      const cancelled = await observed.terminal
      await lifecycle.drainAgentPersistence()
      const atomic = await import('./atomicPersistence')
      await atomic.closeAndDrainAtomicWrites()
      expect(signal.aborted).toBe(true)
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.activeRunId).toBeUndefined()
      expect(displayCalls(cancelled)[0]).toMatchObject({
        status: 'error',
        result: { interrupted: true, outcome: 'unknown' }
      })
      expect(toolResults(cancelled)).toHaveLength(2)
      expect(
        toolResults(cancelled).every(
          (result) => JSON.parse(result.content).error.code === 'cancelled'
        )
      ).toBe(true)
      assertMatchedHistory(cancelled.history!)
      const path = join(host.directory, 'agent-sessions.json')
      const durableBytes = await fs.readFile(path, 'utf8')
      expect(await storedSession(session.id)).toEqual(cancelled)
      const eventCount = observed.events.length
      late.resolve({ content: '{"result":999,"late":true}' })
      await returned.promise
      // Let the awaited registry/host continuations settle after the deliberately late executor.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await lifecycle.drainAgentPersistence()
      expect(executor).toHaveBeenCalledOnce()
      expect(observed.events).toHaveLength(eventCount)
      expect(await fs.readFile(path, 'utf8')).toBe(durableBytes)
      expect(durableBytes).not.toContain('"late":true')
      expect(requests).toHaveLength(1)
      expect(host.prepare).not.toHaveBeenCalled()
      expect(host.commit).not.toHaveBeenCalled()
      expect(await readCommand()).toEqual(initialCommand)
      if (action === 'shutdown') {
        await expect(agents.createAgentSession(settings())).rejects.toThrow('shutting down')
      }
    }
  )
})

// These fixtures exercise the shared CORE-11 lifecycle corpus in the actual Electron service.
// The only extra seam records trusted scope acquisition and provides inert owned resources.
describe('owned desktop extension lifetimes', () => {
  async function captureScopes(
    acquired?: (scope: import('@ayayaq/vivi/extensions').ExtensionScope) => Promise<void> | void
  ) {
    const extensions = await import('./agentExtensions')
    const create = extensions.createAgentExtensionScope
    const scopes: Array<{
      scope: import('@ayayaq/vivi/extensions').ExtensionScope
      snapshot: import('@ayayaq/vivi/extensions').ToolRegistry
    }> = []
    const factory = vi
      .spyOn(extensions, 'createAgentExtensionScope')
      .mockImplementation(async (...args) => {
        const scope = await create(...args)
        scopes.push({ scope, snapshot: scope.snapshot() })
        await acquired?.(scope)
        return scope
      })
    return { scopes, factory, create }
  }

  it('closes every successive owner and its fixed captured snapshot before reporting completion', async () => {
    const captured = await captureScopes()
    transport('openai', [{ text: 'First' }, { text: 'Second' }, { text: 'Third' }])
    const agents = await import('./agentService')
    const session = await agents.createAgentSession(settings())
    for (let index = 0; index < 3; index++) {
      const observed = observe(agents)
      await agents.runAgentSession(session.id, `Request ${index}`, settings())
      expect((await observed.terminal).status).toBe('completed')
      await agents.drainAgentRuns()
      expect(captured.scopes.every(({ scope }) => scope.state === 'closed')).toBe(true)
    }
    expect(captured.scopes).toHaveLength(6)
    for (const { scope, snapshot } of captured.scopes) {
      expect(snapshot.has('calculate')).toBe(true)
      expect(snapshot.tools.map((tool) => tool.name)).toEqual([
        'calculate',
        'list_skills',
        'read_skill'
      ])
      expect(() => scope.snapshot()).toThrow('not open')
      await expect(
        snapshot.executeTool(calculate(), { signal: new AbortController().signal })
      ).rejects.toThrow()
      expect(scope.dispose()).toBe(scope.dispose())
    }
    expect(requests).toHaveLength(3)
    expect(await storedSession(session.id)).toMatchObject({
      status: 'completed'
    })
  })

  it('detaches a completed run subscription and makes its retained callback inert during a newer run', async () => {
    const settingsService = await import('./settingsService')
    const subscribe = settingsService.onSettingsChanged
    const listeners: Array<{
      callback: Parameters<typeof subscribe>[0]
      unsubscribe: ReturnType<typeof vi.fn>
    }> = []
    vi.spyOn(settingsService, 'onSettingsChanged').mockImplementation((callback) => {
      const detach = subscribe(callback)
      const unsubscribe = vi.fn(() => detach())
      listeners.push({ callback, unsubscribe })
      return unsubscribe
    })
    const { calculatorExtension } = await import('@ayayaq/vivi/extensions/calculator')
    const entered = deferred<AbortSignal>(),
      late = deferred<ToolResult>()
    transport('openai', [{ text: 'First completed' }, { calls: [calculate()] }])
    const agents = await import('./agentService')
    const first = observe(agents),
      session = await start(agents)
    await first.terminal
    const previousListener = listeners[1]
    expect(previousListener.unsubscribe).toHaveBeenCalledOnce()
    vi.spyOn(calculatorExtension.tools[0], 'execute').mockImplementation(
      async (_call, { signal }) => {
        entered.resolve(signal)
        return late.promise
      }
    )
    const second = observe(agents)
    await agents.runAgentSession(session.id, 'Second request', settings())
    const signal = await entered.promise
    previousListener.callback(
      { ...settingsService.getSettings(), openaiApiKey: 'fake-changed' },
      settingsService.getSettings()
    )
    expect(signal.aborted).toBe(false)
    expect((await agents.loadAgentSessions()).sessions[0].status).toBe('running')
    settingsService.setSettings({ ...settingsService.getSettings(), openaiApiKey: 'fake-changed' })
    expect((await second.terminal).status).toBe('cancelled')
    await agents.drainAgentRuns()
    expect(listeners[2].unsubscribe).toHaveBeenCalledOnce()
    late.resolve({ content: '{"result":99}' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(requests).toHaveLength(2)
    expect(await storedSession(session.id)).toMatchObject({ status: 'cancelled' })
  })

  it('rolls back a late candidate during shutdown and awaits its exact acquired resource before rejecting startup', async () => {
    const acquired = deferred(),
      releaseAcquisition = deferred(),
      cleanupEntered = deferred(),
      releaseCleanup = deferred()
    const captured = await captureScopes(async (scope) => {
      scope.defer(async () => {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      })
      acquired.resolve()
      await releaseAcquisition.promise
    })
    const agents = await import('./agentService')
    const session = await agents.createAgentSession(settings())
    const before = await storedSession(session.id)
    const lifecycle = await import('./agentPersistenceLifecycle')
    let settled = false
    const startup = agents.runAgentSession(session.id, 'Must not publish', settings())
    const rejected = expect(startup).rejects.toThrow('shutting down')
    void startup.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    try {
      await acquired.promise
      lifecycle.pauseAgentPersistence()
      agents.stopAgentRuns()
      releaseAcquisition.resolve()
      await cleanupEntered.promise
      expect(settled).toBe(false)
      expect(captured.scopes[0].scope.state).toBe('closing')
      expect(await storedSession(session.id)).toEqual(before)
      releaseCleanup.resolve()
      await rejected
      await lifecycle.drainAgentPersistence()
      expect(captured.scopes[0].scope.state).toBe('closed')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(await storedSession(session.id)).toEqual(before)
    } finally {
      releaseAcquisition.resolve()
      releaseCleanup.resolve()
      await rejected
    }
  })

  it.each(['cancel', 'shutdown'] as const)(
    '%s waits owned cleanup while keeping app-owned MCP connections intact',
    async (action) => {
      const entered = deferred<AbortSignal>(),
        late = deferred<ToolResult>(),
        cleanupEntered = deferred(),
        releaseCleanup = deferred()
      const order: string[] = []
      const captured = await captureScopes((scope) => {
        scope.defer(() => {
          order.push('last')
        })
        scope.defer(async () => {
          order.push('first')
          cleanupEntered.resolve()
          await releaseCleanup.promise
        })
      })
      const { AgentMcpService } = await import('./agentMcpService')
      vi.spyOn(AgentMcpService.prototype, 'captureCatalogs').mockRejectedValue(
        new Error('Inert unavailable metadata')
      )
      const close = vi.spyOn(AgentMcpService.prototype, 'close')
      const { calculatorExtension } = await import('@ayayaq/vivi/extensions/calculator')
      vi.spyOn(calculatorExtension.tools[0], 'execute').mockImplementation(
        async (_call, { signal }) => {
          entered.resolve(signal)
          return late.promise
        }
      )
      transport('openai', [{ calls: [calculate()] }])
      const agents = await import('./agentService'),
        observed = observe(agents),
        session = await start(agents)
      const signal = await entered.promise
      let terminal = false,
        drained = false
      void observed.terminal.then(() => {
        terminal = true
      })
      const lifecycle = await import('./agentPersistenceLifecycle')
      if (action === 'shutdown') {
        lifecycle.pauseAgentPersistence()
        agents.stopAgentRuns()
      } else expect(agents.cancelAgentRun(session.id)).toBe(true)
      const draining = agents.drainAgentRuns().then(() => {
        drained = true
      })
      try {
        await cleanupEntered.promise
        expect(signal.aborted).toBe(true)
        expect(terminal).toBe(false)
        expect(drained).toBe(false)
        expect(order).toEqual(['first'])
        expect(captured.scopes[0].scope.state).toBe('closing')
        releaseCleanup.resolve()
        expect((await observed.terminal).status).toBe('cancelled')
        await draining
        await lifecycle.drainAgentPersistence()
        expect(order).toEqual(['first', 'last'])
        expect(captured.scopes[0].scope.state).toBe('closed')
        expect(close).not.toHaveBeenCalled()
        const saved = await fs.readFile(join(host.directory, 'agent-sessions.json'), 'utf8')
        late.resolve({ content: '{"result":999,"late":true}' })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(await fs.readFile(join(host.directory, 'agent-sessions.json'), 'utf8')).toBe(saved)
      } finally {
        releaseCleanup.resolve()
        late.resolve({ content: '{"result":0}' })
        await draining
      }
    }
  )

  it('preserves the established ordinary scope when MCP candidate setup fails', async () => {
    const captured = await captureScopes()
    captured.factory.mockImplementation(async (...args) => {
      if (args[2]) throw new Error('Inert candidate registration failure')
      const scope = await captured.create(...args)
      captured.scopes.push({ scope, snapshot: scope.snapshot() })
      return scope
    })
    transport('openai', [{ calls: [calculate()] }, { text: 'Ordinary tools survived' }])
    const agents = await import('./agentService'),
      observed = observe(agents)
    await start(agents)
    const result = await observed.terminal
    expect(result.status).toBe('completed')
    expect(displayCalls(result)[0].result).toEqual({ result: 42 })
    expect(captured.scopes).toHaveLength(1)
    expect(captured.scopes[0].scope.state).toBe('closed')
  })

  it('attempts every owned cleanup and reports its failure as a persisted terminal error', async () => {
    const cleaned = vi.fn()
    await captureScopes((scope) => {
      scope.defer(cleaned)
      scope.defer(() => {
        throw new Error('Inert owned cleanup failure')
      })
    })
    const { AgentMcpService } = await import('./agentMcpService')
    vi.spyOn(AgentMcpService.prototype, 'captureCatalogs').mockRejectedValue(
      new Error('Inert unavailable metadata')
    )
    transport('openai', [{ text: 'The request completed' }])
    const agents = await import('./agentService'),
      observed = observe(agents),
      session = await start(agents)
    const result = await observed.terminal
    expect(result.status).toBe('error')
    expect(result.error).toContain('Agent cleanup failed')
    expect(cleaned).toHaveBeenCalledOnce()
    await agents.drainAgentRuns()
    expect(await storedSession(session.id)).toEqual(result)
    expect(result.messages.at(-1)?.content).toBe('The request completed')
  })
})

it('switches active sessions without transferring a live run owner or its late calculator result', async () => {
  const { calculatorExtension } = await import('@ayayaq/vivi/extensions/calculator')
  const entered = deferred<AbortSignal>(),
    late = deferred<ToolResult>()
  vi.spyOn(calculatorExtension.tools[0], 'execute').mockImplementation(
    async (_call, { signal }) => {
      entered.resolve(signal)
      return late.promise
    }
  )
  transport('openai', [{ calls: [calculate()] }, { text: 'Neighbor completed' }])
  const agents = await import('./agentService')
  const first = await agents.createAgentSession(settings()),
    second = await agents.createAgentSession(settings())
  const firstTerminal = deferred<AgentSession>(),
    secondTerminal = deferred<AgentSession>()
  const events: AgentStreamEvent[] = []
  agents.setAgentEventSink((event) => {
    events.push(structuredClone(event))
    if (event.type === 'done' || event.type === 'error') {
      if (event.sessionId === first.id) firstTerminal.resolve(event.session!)
      if (event.sessionId === second.id) secondTerminal.resolve(event.session!)
    }
  })
  await agents.setActiveAgentSession(first.id)
  await agents.runAgentSession(first.id, 'Held calculation', settings())
  const signal = await entered.promise
  await agents.setActiveAgentSession(second.id)
  await agents.runAgentSession(second.id, 'Independent request', settings())
  const completed = await secondTerminal.promise
  expect(completed.status).toBe('completed')
  expect(signal.aborted).toBe(false)
  expect(agents.cancelAgentRun(first.id)).toBe(true)
  expect((await firstTerminal.promise).status).toBe('cancelled')
  await agents.drainAgentRuns()
  const saved = await storedSession(second.id),
    count = events.length
  late.resolve({ content: '{"result":999,"late":true}' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(await storedSession(second.id)).toEqual(saved)
  expect(saved.messages.at(-1)?.content).toBe('Neighbor completed')
  expect(events).toHaveLength(count)
  expect((await agents.loadAgentSessions()).activeSessionId).toBe(second.id)
})

it('drains an already-admitted event checkpoint before cancelled owner completion', async () => {
  const atomic = await import('./atomicPersistence'),
    write = atomic.atomicWrite
  const entered = deferred(),
    release = deferred()
  let held = false
  vi.spyOn(atomic, 'atomicWrite').mockImplementation(async (...args) => {
    const snapshot = args[0].endsWith('agent-sessions.json') ? JSON.parse(args[1]) : undefined
    if (
      !held &&
      snapshot?.sessions.some(
        (session: AgentSession) =>
          session.status === 'running' &&
          session.history?.some((message) => message.kind === 'assistant')
      )
    ) {
      held = true
      entered.resolve()
      await release.promise
    }
    return write(...args)
  })
  transport('openai', [{ calls: [calculate()] }])
  const agents = await import('./agentService'),
    observed = observe(agents)
  const session = await start(agents)
  await entered.promise
  let terminal = false,
    drained = false
  void observed.terminal.then(() => {
    terminal = true
  })
  agents.cancelAgentRun(session.id)
  const draining = agents.drainAgentRuns().then(() => {
    drained = true
  })
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(terminal).toBe(false)
    expect(drained).toBe(false)
    release.resolve()
    const result = await observed.terminal
    expect(result.status).toBe('cancelled')
    await draining
    expect(await storedSession(session.id)).toEqual(result)
    expect(displayCalls(result)).toHaveLength(0)
    expect(toolResults(result)).toHaveLength(1)
    expect(JSON.parse(toolResults(result)[0].content).error.code).toBe('cancelled')
  } finally {
    release.resolve()
    await draining
  }
})

it('awaits an admitted local resource save and preserves its known committed result after cancellation', async () => {
  const atomic = await import('./atomicPersistence'),
    write = atomic.atomicWrite
  const entered = deferred(),
    release = deferred()
  vi.spyOn(atomic, 'atomicWrite').mockImplementation(async (...args) => {
    if (args[0].endsWith('commands.json') && JSON.parse(args[1]).channelMessage === 'After') {
      entered.resolve()
      await release.promise
    }
    return write(...args)
  })
  const mutation = await editCall()
  transport('openai', [{ calls: [mutation] }])
  const agents = await import('./agentService'),
    observed = observe(agents),
    session = await start(agents)
  await vi.waitFor(() =>
    expect(observed.events.some((event) => event.type === 'approval')).toBe(true)
  )
  const approvalId = observed.events.find((event) => event.type === 'approval')!.toolCall!
    .approvalId
  expect(await agents.resolveAgentApproval(session.id, mutation.id, true, approvalId)).toBe(true)
  await entered.promise
  let terminal = false
  void observed.terminal.then(() => {
    terminal = true
  })
  agents.cancelAgentRun(session.id)
  const draining = agents.drainAgentRuns()
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(terminal).toBe(false)
    release.resolve()
    const result = await observed.terminal
    expect(result.status).toBe('cancelled')
    await draining
    expect(await readCommand()).toMatchObject({ channelMessage: 'After' })
    expect(displayCalls(result)[0]).toMatchObject({
      status: 'completed',
      result: { success: true }
    })
    expect(await storedSession(session.id)).toEqual(result)
    expect(requests).toHaveLength(1)
  } finally {
    release.resolve()
    await draining
  }
})

it('reports failed cleanup of a late unpublished MCP candidate even when its run was cancelled', async () => {
  const extensions = await import('./agentExtensions'),
    create = extensions.createAgentExtensionScope
  const acquired = deferred(),
    release = deferred(),
    cleaned = vi.fn()
  let candidate: import('@ayayaq/vivi/extensions').ExtensionScope | undefined
  vi.spyOn(extensions, 'createAgentExtensionScope').mockImplementation(async (...args) => {
    const scope = await create(...args)
    if (args[2]) {
      candidate = scope
      scope.defer(cleaned)
      scope.defer(() => {
        throw new Error('Inert unpublished resource cleanup failure')
      })
      acquired.resolve()
      await release.promise
    }
    return scope
  })
  const agents = await import('./agentService'),
    observed = observe(agents),
    session = await start(agents)
  await acquired.promise
  agents.cancelAgentRun(session.id)
  try {
    release.resolve()
    const result = await observed.terminal
    expect(result.status).toBe('error')
    expect(result.error).toContain('MCP extension setup and cleanup failed')
    expect(cleaned).toHaveBeenCalledOnce()
    expect(candidate?.state).toBe('closed')
    await agents.drainAgentRuns()
    expect(await storedSession(session.id)).toEqual(result)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    release.resolve()
  }
})
