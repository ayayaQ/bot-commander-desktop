import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'
import {
  AGENT_VALIDATION_WORKER_FILENAME,
  agentValidationWorkerBuild
} from '../../../electron.vite.config'
import type { AgentStreamEvent } from '../../shared/agentTypes'
import type {
  AgentValidationRequest,
  AgentValidationSuite
} from '../../shared/agentValidationTypes'
import { createPlaygroundState } from '../../shared/playground/types'
import type { BCFDCommand } from '../types/types'

const mocks = vi.hoisted(() => ({
  userDataPath: '',
  workerEntry: undefined as URL | undefined,
  provider: vi.fn(),
  validationRequests: [] as AgentValidationRequest[]
}))

// Only the unavailable Electron shell is substituted. The command store, resource
// tools, validation binding, session persistence and filesystem stay production code.
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`Unexpected Electron path: ${name}`)
      return mocks.userDataPath
    }
  },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {}
}))

// Source tests have no built sibling worker. Redirect the real production bridge
// to an entry built with the exact app build configuration, without faking results.
vi.mock('./agentValidationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentValidationService')>()
  return {
    ...actual,
    validatePreparedResource: (input: AgentValidationRequest, signal?: AbortSignal) => {
      mocks.validationRequests.push(structuredClone(input))
      return actual.createAgentValidationService({ workerEntry: mocks.workerEntry })(input, signal)
    }
  }
})

const settings = {
  aiProvider: 'openai' as const,
  openaiApiKey: 'mock-only',
  selectedAiModel: 'gpt-5.4-nano'
}

function replySuite(): AgentValidationSuite {
  const state = createPlaygroundState()
  return {
    cases: state.members.slice(0, 2).map((member) => ({
      name: `reply to ${member.name}`,
      state: structuredClone(state),
      steps: [
        {
          kind: 'message',
          senderId: member.id,
          content: '!ping',
          assertions: [
            { path: '/outcome', equals: 'executed' },
            { path: '/effects/messages/0/content', equals: `Pong, ${member.name}!` }
          ]
        }
      ]
    }))
  }
}

describe('agent command reference workflow', () => {
  let workerDirectory: string
  let currentService: typeof import('./agentService') | undefined
  let terminal: Promise<AgentStreamEvent> | undefined

  beforeAll(async () => {
    workerDirectory = await fs.mkdtemp(join(tmpdir(), 'agent-reference-worker-'))
    await build(agentValidationWorkerBuild(workerDirectory))
    mocks.workerEntry = pathToFileURL(join(workerDirectory, AGENT_VALIDATION_WORKER_FILENAME))
  }, 20_000)

  beforeEach(async () => {
    vi.resetModules()
    mocks.provider.mockReset()
    mocks.validationRequests.length = 0
    mocks.userDataPath = await fs.mkdtemp(join(tmpdir(), 'agent-reference-user-data-'))
    currentService = undefined
    terminal = undefined
    // Exercise the actual vivi/provider adapter against a deterministic local
    // transport. This replacement never delegates to fetch or a live provider.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses')
          throw new Error('Unexpected provider URL in reference workflow')
        const request = JSON.parse(init!.body as string)
        const response = { status: 'completed', ...(await mocks.provider(request)) }
        return request.stream
          ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
              headers: { 'Content-Type': 'text/event-stream' }
            })
          : new Response(JSON.stringify(response))
      })
    )
  })

  afterEach(async () => {
    currentService?.stopAgentRuns()
    if (terminal) await terminal
    currentService?.setAgentEventSink(null)
    vi.unstubAllGlobals()
    await fs.rm(mocks.userDataPath, { recursive: true, force: true })
  })

  afterAll(async () => {
    if (workerDirectory) await fs.rm(workerDirectory, { recursive: true, force: true })
  })

  it('validates, manually approves, atomically saves and reloads the identical new command', async () => {
    const validation = replySuite()
    mocks.provider
      .mockResolvedValueOnce({
        output_text: '',
        output: [
          {
            type: 'function_call',
            call_id: 'create-ping',
            name: 'create_command',
            arguments: JSON.stringify({
              command: {
                command: '!ping',
                commandDescription: 'Reply to the invoking member',
                channelMessage: 'Pong, $namePlain!',
                type: 0
              },
              validation
            })
          }
        ],
        usage: {}
      })
      .mockResolvedValue({
        output_text: 'Created and checked the reply command.',
        output: [],
        usage: {}
      })

    const bot = await import('./botService')
    const files = await import('./fileService')
    const { validationHash } = await import('./agentMutationValidation')
    await files.loadCommands()
    const commandsPath = join(mocks.userDataPath, 'commands.json')
    const initialBytes = await fs.readFile(commandsPath, 'utf8')
    const initialCommands = { bcfdCommands: [], bcfdSlashCommands: [] }
    expect(JSON.parse(initialBytes)).toEqual(initialCommands)

    currentService = await import('./agentService')
    const session = await currentService.createAgentSession(settings)
    await currentService.updateAgentSession(session.id, { mode: 'manual' }, 'openai')
    const events: AgentStreamEvent[] = []
    let resolveApproval!: (event: AgentStreamEvent) => void
    let resolveTerminal!: (event: AgentStreamEvent) => void
    const approval = new Promise<AgentStreamEvent>((resolve) => {
      resolveApproval = resolve
    })
    terminal = new Promise<AgentStreamEvent>((resolve) => {
      resolveTerminal = resolve
    })
    currentService.setAgentEventSink((event) => {
      events.push(event)
      if (event.type === 'approval') resolveApproval(event)
      if (event.type === 'done' || event.type === 'error') {
        resolveApproval(event)
        resolveTerminal(event)
      }
    })
    await currentService.runAgentSession(session.id, 'Create a !ping reply command', settings)

    const approvalEvent = await approval
    expect(
      approvalEvent.type,
      JSON.stringify(
        events
          .filter((event) => event.type === 'tool')
          .map((event) => ({
            status: event.toolCall?.status,
            error: event.toolCall?.error,
            validation: event.toolCall?.validation
          }))
      )
    ).toBe('approval')
    const call = approvalEvent.toolCall!
    const candidate = call.after as BCFDCommand
    expect(call).toMatchObject({ name: 'create_command', status: 'waiting_approval', before: null })
    expect(candidate).toMatchObject({
      id: expect.any(String),
      command: '!ping',
      channelMessage: 'Pong, $namePlain!',
      isAdmin: false,
      type: 0
    })
    expect(candidate.id).not.toBe('')
    expect(call.diagnostics).toEqual([])
    expect(mocks.validationRequests).toHaveLength(1)
    expect(mocks.validationRequests[0].candidate).toEqual(candidate)
    expect(mocks.validationRequests[0]).toMatchObject({
      candidate,
      candidateHash: validationHash(candidate),
      baseRevision: null,
      fixtureHash: validationHash(validation),
      wrapEvalInIIFE: true
    })
    expect(call.validationBinding).toEqual({
      candidateHash: validationHash(candidate),
      baseRevision: null,
      fixtureHash: validationHash(validation),
      wrapEvalInIIFE: true
    })
    expect(call.validation).toMatchObject({
      outcome: 'passed',
      candidateId: candidate.id,
      candidateHash: validationHash(candidate),
      fixtureHash: validationHash(validation),
      coverage: { matched: 2, executed: 2, errors: 0, notRun: 0 },
      timedOut: false,
      cancelled: false,
      truncated: false
    })
    expect(call.validation!.cases.map((testCase) => testCase.steps[0])).toMatchObject([
      {
        outcome: 'passed',
        executionOutcome: 'executed',
        effects: { messages: [{ content: 'Pong, Alex!' }] },
        assertions: [{ passed: true }, { passed: true, actual: 'Pong, Alex!' }]
      },
      {
        outcome: 'passed',
        executionOutcome: 'executed',
        effects: { messages: [{ content: 'Pong, Sam!' }] },
        assertions: [{ passed: true }, { passed: true, actual: 'Pong, Sam!' }]
      }
    ])
    // Passing unsaved validation has not made the candidate live or durable.
    expect(bot.getCommands()).toEqual(initialCommands)
    expect(await fs.readFile(commandsPath, 'utf8')).toBe(initialBytes)
    expect(mocks.provider).toHaveBeenCalledTimes(1)

    expect(await currentService.resolveAgentApproval(session.id, call.id, true)).toBe(true)
    const done = await terminal
    expect(done.type, done.error).toBe('done')
    expect(done.session?.status).toBe('completed')
    const completedCall = events
      .filter((event) => event.type === 'tool' && event.toolCall?.id === call.id)
      .at(-1)!.toolCall!
    expect(completedCall).toMatchObject({
      status: 'completed',
      after: candidate,
      result: { success: true, target: { type: 'command', id: candidate.id } },
      validation: call.validation
    })
    expect(mocks.validationRequests).toHaveLength(1)
    expect(mocks.provider).toHaveBeenCalledTimes(2)
    const savedCommands = { bcfdCommands: [candidate], bcfdSlashCommands: [] }
    expect(bot.getCommands()).toEqual(savedCommands)
    const savedBytes = await fs.readFile(commandsPath, 'utf8')
    expect(JSON.parse(savedBytes)).toEqual(savedCommands)
    expect(await fs.readFile(`${commandsPath}.bak`, 'utf8')).toBe(initialBytes)
    expect((await fs.readdir(mocks.userDataPath)).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    )

    // Drop all production module state to model a restart, then load through the
    // same codec and filesystem service used by the desktop app.
    currentService.setAgentEventSink(null)
    currentService = undefined
    vi.resetModules()
    const reloadedBot = await import('./botService')
    const reloadedFiles = await import('./fileService')
    expect(reloadedBot.getCommands()).toEqual(initialCommands)
    await reloadedFiles.loadCommands()
    expect(reloadedBot.getCommands()).toEqual(savedCommands)
    expect(await fs.readFile(commandsPath, 'utf8')).toBe(savedBytes)
    const reloadedAgent = await import('./agentService')
    const storedSession = (await reloadedAgent.loadAgentSessions()).sessions.find(
      (item) => item.id === session.id
    )!
    expect(storedSession.status).toBe('completed')
    const storedCall = storedSession.messages
      .flatMap((message) => message.toolCalls ?? [])
      .find((item) => item.id === call.id)!
    expect(storedCall).toMatchObject({
      status: 'completed',
      after: candidate,
      validation: call.validation,
      result: { success: true, target: { type: 'command', id: candidate.id } }
    })
    expect(mocks.provider).toHaveBeenCalledTimes(2)
  }, 15_000)
})
