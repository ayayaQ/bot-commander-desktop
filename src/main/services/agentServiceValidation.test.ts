import { beforeEach, describe, expect, it, vi } from 'vitest'
import { lintBCFD } from '../../shared/bcfdLint'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { createPlaygroundState } from '../../shared/playground/types'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import type {
  AgentValidationRequest,
  AgentValidationSuite
} from '../../shared/agentValidationTypes'
import type { AgentStreamEvent } from '../../shared/agentTypes'

const mocks = vi.hoisted(() => ({
  provider: vi.fn(),
  prepare: vi.fn(),
  commit: vi.fn(),
  lint: vi.fn(),
  validate: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/test-user-data' } }))
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    rename: mocks.rename
  }
}))
vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: mocks.provider }
  }
}))
vi.mock('./agentTools', () => ({
  agentToolDefinitions: [
    'create_command',
    'edit_command',
    'create_interaction',
    'edit_interaction'
  ].map((name) => ({
    type: 'function',
    function: { name, description: '', parameters: {} }
  })),
  mutationToolNames: new Set([
    'create_command',
    'edit_command',
    'create_interaction',
    'edit_interaction'
  ]),
  agentToolTargetLabel: () => '!ping',
  prepareMutation: mocks.prepare,
  commitMutation: mocks.commit,
  lintPreparedMutation: mocks.lint,
  executeReadTool: vi.fn()
}))
vi.mock('./agentMemoryService', () => ({ loadAgentMemories: async () => ({ memories: [] }) }))
vi.mock('./agentValidationService', () => ({ validatePreparedResource: mocks.validate }))

const settings = {
  aiProvider: 'openai' as const,
  openaiApiKey: 'mock-only',
  selectedAiModel: 'mock-only'
}
function validationSuite(): AgentValidationSuite {
  const state = createPlaygroundState()
  return {
    cases: [
      {
        name: 'reply',
        state,
        steps: [
          {
            kind: 'message',
            senderId: state.members[0].id,
            content: '!ping',
            assertions: [
              { path: '/outcome', equals: 'executed' },
              { path: '/effects/messages/0/content', equals: 'Pong!' }
            ]
          }
        ]
      }
    ]
  }
}
function report(input: AgentValidationRequest, passed = true) {
  const result = createNotRunAgentValidationReport(input, 'mock execution')
  result.outcome = passed ? 'passed' : 'failed'
  result.coverage.executed = 1
  result.coverage.matched = 1
  result.coverage.notRun = 0
  result.cases[0].outcome = result.outcome
  Object.assign(result.cases[0].steps[0], {
    outcome: result.outcome,
    executionOutcome: 'executed',
    matched: true,
    executed: true,
    assertions: [
      {
        path: '/outcome',
        expected: 'executed',
        actual: 'executed',
        actualPresent: true,
        passed: true
      },
      {
        path: '/effects/messages/0/content',
        expected: 'Pong!',
        actual: passed ? 'Pong!' : 'wrong',
        actualPresent: true,
        passed
      }
    ]
  })
  return result
}
function turn(
  callId = 'change-1',
  args: unknown = { command: {}, validation: validationSuite() },
  name = 'create_command'
) {
  return {
    output_text: '',
    output: [{ type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) }],
    usage: {}
  }
}
async function begin(
  mode: 'manual' | 'auto' | 'planning',
  onEvent?: (event: AgentStreamEvent) => void
) {
  const service = await import('./agentService')
  const session = await service.createAgentSession(settings)
  await service.updateAgentSession(session.id, { mode }, 'openai')
  const events: AgentStreamEvent[] = []
  const finished = new Promise<AgentStreamEvent>((resolve) => {
    service.setAgentEventSink((event) => {
      events.push(event)
      onEvent?.(event)
      if (event.type === 'done' || event.type === 'error') resolve(event)
    })
  })
  await service.runAgentSession(session.id, 'Create a reply command', settings)
  return { service, session, events, finished }
}

describe('draft validation before existing approval/save', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.lint.mockResolvedValue([])
    mocks.commit.mockResolvedValue({ success: true })
    mocks.prepare.mockImplementation(async (name, args) => {
      const after = decodeBCFDCommand({
        id: 'normalized-creation-id',
        command: '!ping',
        commandDescription: 'Ping',
        channelMessage: 'Pong!',
        privateMessage: '',
        channelEmbed: {},
        privateEmbed: {},
        type: 0
      }).command
      return {
        name,
        arguments: args,
        before: null,
        after,
        target: { type: 'command', id: after.id }
      }
    })
    mocks.validate.mockImplementation(async (input) => report(input))
    mocks.provider.mockResolvedValue({ output_text: 'Done.', output: [], usage: {} })
  })

  it('shows exact report before manual approval and commits the same normalized creation UUID', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    let approvalSeen!: () => void
    const approval = new Promise<void>((resolve) => {
      approvalSeen = resolve
    })
    const run = await begin('manual', (event) => {
      if (event.type === 'approval') approvalSeen()
    })
    await approval
    expect(mocks.validate).toHaveBeenCalledTimes(1)
    expect(mocks.commit).not.toHaveBeenCalled()
    const approvalCall = run.events.find((event) => event.type === 'approval')!.toolCall!
    expect(approvalCall).toMatchObject({
      status: 'waiting_approval',
      validation: { outcome: 'passed', candidateId: 'normalized-creation-id' }
    })
    expect(approvalCall.after).toMatchObject({ id: 'normalized-creation-id' })
    await run.service.resolveAgentApproval(run.session.id, approvalCall.id, true)
    await run.finished
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    expect(mocks.commit.mock.calls[0][0].after).toEqual(approvalCall.after)
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.validate.mock.invocationCallOrder[0]
    )
  })

  it('auto-saves only after passing draft validation without a manual approval event', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    const run = await begin('auto')
    await run.finished
    expect(mocks.commit).toHaveBeenCalledTimes(1)
    expect(run.events.some((event) => event.type === 'approval')).toBe(false)
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.validate.mock.invocationCallOrder[0]
    )
  })

  it('does not save or request approval after a failed assertion and returns repair evidence', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    mocks.validate.mockImplementation(async (input) => report(input, false))
    const run = await begin('manual')
    await run.finished
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(run.events.some((event) => event.type === 'approval')).toBe(false)
    const call = run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!
    expect(call.result).toMatchObject({
      success: false,
      saved: false,
      attemptsRemaining: 2,
      validation: { outcome: 'failed' }
    })
    expect(JSON.stringify(call.result).length).toBeLessThan(24000)
  })

  it('allows a repaired draft within the bounded attempts', async () => {
    mocks.provider.mockResolvedValueOnce(turn('bad')).mockResolvedValueOnce(turn('repaired'))
    mocks.validate.mockImplementationOnce(async (input) => report(input, false))
    const run = await begin('auto')
    await run.finished
    expect(mocks.validate).toHaveBeenCalledTimes(2)
    expect(mocks.commit).toHaveBeenCalledTimes(1)
  })

  it('stops repeated failing repairs after three tests without any save', async () => {
    for (let index = 0; index < 4; index++)
      mocks.provider.mockResolvedValueOnce(turn(`bad-${index}`))
    mocks.validate.mockImplementation(async (input) => report(input, false))
    const run = await begin('auto')
    await run.finished
    expect(mocks.validate).toHaveBeenCalledTimes(3)
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.error).toContain(
      'repair limit'
    )
  })

  it('keeps planning read-only even if a provider proposes a mutation', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    const run = await begin('planning')
    await run.finished
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.provider.mock.calls[0][0].tools).toEqual([])
  })

  it('rejects a changed candidate while approval is pending', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    let approved!: () => void
    const approval = new Promise<void>((resolve) => {
      approved = resolve
    })
    const run = await begin('manual', (event) => {
      if (event.type === 'approval') approved()
    })
    await approval
    const prepared = await mocks.prepare.mock.results[0].value
    prepared.after.channelMessage = 'Changed after testing'
    await run.service.resolveAgentApproval(run.session.id, 'change-1', true)
    await run.finished
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.error).toContain(
      'stale'
    )
  })

  it('preserves revision conflicts from the commit boundary after approved validation', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    mocks.commit.mockRejectedValue(new Error('Stale resource revision; read again'))
    const run = await begin('auto')
    await run.finished
    expect(mocks.validate).toHaveBeenCalledTimes(1)
    expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.error).toContain(
      'Stale resource revision'
    )
  })

  it('cancels pending worker validation without approval, commit or another provider round', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    let workerStarted!: () => void
    const started = new Promise<void>((resolve) => {
      workerStarted = resolve
    })
    mocks.validate.mockImplementation(
      (input, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve(createNotRunAgentValidationReport(input, 'cancelled', { cancelled: true }))
          )
          workerStarted()
        })
    )
    const run = await begin('auto')
    await started
    expect(run.service.cancelAgentRun(run.session.id)).toBe(true)
    const terminal = await run.finished
    expect(terminal.session?.status).toBe('cancelled')
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(mocks.provider).toHaveBeenCalledTimes(1)
    expect(run.events.some((event) => event.type === 'approval')).toBe(false)
  })

  it('requires explicit approval for unsupported event drafts even in auto mode', async () => {
    const normalPrepare = mocks.prepare.getMockImplementation()!
    mocks.prepare.mockImplementation(async (name, args) => {
      const prepared = await normalPrepare(name, args)
      prepared.after.type = 2
      return prepared
    })
    mocks.provider.mockResolvedValueOnce(turn('event', { command: {} }))
    let seen!: () => void
    const approval = new Promise<void>((resolve) => {
      seen = resolve
    })
    const run = await begin('auto', (event) => {
      if (event.type === 'approval') seen()
    })
    await approval
    const call = run.events.find((event) => event.type === 'approval')!.toolCall!
    expect(call.validation).toMatchObject({ outcome: 'unsupported', coverage: { executed: 0 } })
    expect(call.validation!.limitations.join(' ')).toContain('explicit approval is required')
    expect(mocks.validate).not.toHaveBeenCalled()
    expect(mocks.commit).not.toHaveBeenCalled()
    await run.service.resolveAgentApproval(run.session.id, 'event', true)
    await run.finished
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect((await run.service.loadAgentSessions()).sessions[0].mode).toBe('auto')
  })

  it('returns valid bounded repair JSON even when real lint diagnostics contain huge unknown names', async () => {
    const oversized = Array.from(
      { length: 8 },
      (_, index) => `$${'unknown'.repeat(1360)}${index}`
    ).join(' ')
    mocks.lint.mockResolvedValue(lintBCFD(oversized))
    mocks.validate.mockImplementation(async (input) => report(input, false))
    mocks.provider.mockResolvedValueOnce(turn())
    const run = await begin('auto')
    await run.finished
    const secondRequest = mocks.provider.mock.calls[1][0]
    const output = secondRequest.input.find(
      (item: { type?: string }) => item.type === 'function_call_output'
    ).output
    expect(output.length).toBeLessThanOrEqual(24000)
    expect(JSON.parse(output)).toMatchObject({
      success: false,
      saved: false,
      attemptsRemaining: 2,
      validation: { outcome: 'failed' }
    })
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('keeps rejection authoritative after a passing report', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    let seen!: () => void
    const approval = new Promise<void>((resolve) => {
      seen = resolve
    })
    const run = await begin('manual', (event) => {
      if (event.type === 'approval') seen()
    })
    await approval
    await run.service.resolveAgentApproval(run.session.id, 'change-1', false)
    await run.finished
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.status).toBe(
      'rejected'
    )
  })
})
