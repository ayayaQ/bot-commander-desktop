import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lintBCFD } from '../../shared/bcfdLint'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { createPlaygroundState } from '../../shared/playground/types'
import { createNotRunAgentValidationReport } from '../../shared/agentValidationTypes'
import type {
  AgentValidationRequest,
  AgentValidationSuite
} from '../../shared/agentValidationTypes'
import type { AgentStreamEvent } from '../../shared/agentTypes'
import { resourceRevision } from './resourceChangeService'
import { AUTO_REVIEW_POLICY_REVISION } from '../../shared/agentAutoReview'

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
// Observe serialized checkpoints without exercising filesystem faults in this harness.
vi.mock('./atomicPersistence', () => ({
  hasUncertainAtomicWrites: vi.fn(() => false),
  atomicWrite: vi.fn(async (path: string, raw: string, options) => {
    options?.validate?.(raw)
    await mocks.writeFile(`${path}.tmp`, raw)
    await mocks.rename(`${path}.tmp`, path)
    return { durability: 'confirmed' }
  })
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
  initializeMutationReviewResource: vi.fn(async () => undefined),
  currentMutationReviewRevision: vi.fn(() => 'fixture-resource-revision'),
  commitMutation: mocks.commit,
  lintPreparedMutation: mocks.lint,
  executeReadTool: vi.fn()
}))
vi.mock('./agentMemoryService', () => ({ loadAgentMemories: async () => ({ memories: [] }) }))
// Ordinary provider/validation regressions use an explicit allow recommendation after
// real host enrollment. Reviewer/ledger fail-closed behavior has independent coverage.
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
// Secure credential persistence is outside these in-memory provider fixtures.
vi.mock('./fileService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fileService')>()),
  saveSettings: vi.fn(async () => undefined)
}))

vi.mock('./agentValidationService', () => ({ validatePreparedResource: mocks.validate }))

const settings = {
  aiProvider: 'openai' as const,
  openaiApiKey: 'mock-only',
  selectedAiModel: 'gpt-5.4-nano'
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
  if (mode === 'auto') {
    const currentSettings = await import('./settingsService')
    currentSettings.setSettings({ ...currentSettings.getSettings(), ...settings })
    await service.enrollAgentAutoReview(session.id, {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai',
      accountRevision: currentSettings.getSettings().agentDecisionAccountRevision!
    })
  } else await service.updateAgentSession(session.id, { mode }, 'openai')
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
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const currentSettings = await import('./settingsService')
    currentSettings.setSettings({
      ...currentSettings.getSettings(),
      aiProvider: 'openai',
      openaiApiKey: 'mock-only'
    })
    mocks.provider.mockReset()
    mocks.prepare.mockReset()
    mocks.commit.mockReset()
    mocks.lint.mockReset()
    mocks.validate.mockReset()
    // Fake HTTP transport for vivi; no SDK internals or live provider calls.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses')
          throw new Error('Unexpected provider URL in fake transport')
        const request = JSON.parse(init!.body as string)
        const response = {
          status: 'completed',
          ...(await mocks.provider(request, { signal: init!.signal }))
        }
        return request.stream
          ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
              headers: { 'Content-Type': 'text/event-stream' }
            })
          : new Response(JSON.stringify(response))
      })
    )
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    mocks.lint.mockResolvedValue([])
    mocks.commit.mockImplementation(async (prepared, _source, _signal, beforeCommit) => {
      beforeCommit?.(structuredClone(prepared))
      return { success: true }
    })
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

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
    await run.service.resolveAgentApproval(
      run.session.id,
      approvalCall.id,
      true,
      approvalCall.approvalId
    )
    await run.finished
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    expect(mocks.commit.mock.calls[0][0].after).toEqual(approvalCall.after)
    expect(mocks.commit.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.validate.mock.invocationCallOrder[0]
    )
  })

  it('saves in explicitly enrolled Auto only after passing validation and a mocked allow review', async () => {
    mocks.provider.mockResolvedValueOnce(turn())
    const run = await begin('auto')
    await run.finished
    const { reviewAgentMutation } = await import('./agentAutoReview')
    expect(reviewAgentMutation).toHaveBeenCalledOnce()
    expect(vi.mocked(reviewAgentMutation).mock.calls[0][0]).toMatchObject({
      enrollment: { policyRevision: AUTO_REVIEW_POLICY_REVISION, provider: 'openai' },
      prepared: { name: 'create_command', after: { channelMessage: 'Pong!' } },
      validation: { outcome: 'passed' }
    })
    expect(mocks.commit).toHaveBeenCalledTimes(1)
    expect(mocks.commit.mock.calls[0][3]).toBeTypeOf('function')
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
    const advertised = mocks.provider.mock.calls[0][0].tools.map(
      (tool: { name: string }) => tool.name
    )
    expect(advertised).toContain('calculate')
    for (const name of ['create_command', 'edit_command', 'create_interaction', 'edit_interaction'])
      expect(advertised).not.toContain(name)
  })

  it('isolates the validated candidate from later preparation-fixture changes while approval is pending', async () => {
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
    await run.service.resolveAgentApproval(
      run.session.id,
      'change-1',
      true,
      run.events.find((event) => event.type === 'approval')!.toolCall!.approvalId
    )
    await run.finished
    expect(mocks.commit).toHaveBeenCalledOnce()
    expect(mocks.commit.mock.calls[0][0].after.channelMessage).toBe('Pong!')
    expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.status).toBe(
      'completed'
    )
  })

  it.each([
    { change: 'base revision', result: 'isolates captured base revision' },
    { change: 'fixtures', result: 'isolates captured fixtures' },
    { change: 'interpreter mode', result: 'rejects changed interpreter mode' }
  ] as const)('$result while approval is pending on a validated edit', async ({ change }) => {
    const normalPrepare = mocks.prepare.getMockImplementation()!
    mocks.prepare.mockImplementation(async (name, args) => {
      const prepared = await normalPrepare(name, args)
      prepared.before = { ...prepared.after, channelMessage: 'Before the edit' }
      return prepared
    })
    mocks.provider.mockResolvedValueOnce(
      turn(
        'edit-1',
        {
          id: 'normalized-creation-id',
          validation: validationSuite()
        },
        'edit_command'
      )
    )
    let seen!: () => void
    const approval = new Promise<void>((resolve) => {
      seen = resolve
    })
    const run = await begin('manual', (event) => {
      if (event.type === 'approval') seen()
    })
    await approval
    const prepared = await mocks.prepare.mock.results[0].value
    const request = mocks.validate.mock.calls[0][0]
    const approvalCall = run.events.find((event) => event.type === 'approval')!.toolCall!
    expect(request).toMatchObject({
      candidate: prepared.after,
      baseRevision: resourceRevision(prepared.before),
      wrapEvalInIIFE: true
    })
    expect(approvalCall.validationBinding).toMatchObject({
      candidateHash: request.candidateHash,
      baseRevision: resourceRevision(prepared.before),
      fixtureHash: request.fixtureHash,
      wrapEvalInIIFE: true
    })
    if (change === 'base revision') prepared.before.channelMessage = 'A newer base'
    else if (change === 'fixtures') {
      // Provider arguments are frozen by vivi. The service owns a separate prepared
      // snapshot, so replacing the fixture cannot change the approved evidence.
      const changedArguments = structuredClone(prepared.arguments)
      changedArguments.validation.cases[0].steps[0].assertions[1].equals = 'Different expectation'
      prepared.arguments = changedArguments
    } else {
      const settingsService = await import('./settingsService')
      settingsService.setSettings({
        ...settingsService.getSettings(),
        useLegacyInterpreter: true
      })
    }
    await run.service.resolveAgentApproval(
      run.session.id,
      'edit-1',
      true,
      run.events.find((event) => event.type === 'approval')!.toolCall!.approvalId
    )
    await run.finished
    expect(mocks.validate).toHaveBeenCalledOnce()
    if (change === 'interpreter mode') {
      expect(mocks.commit).not.toHaveBeenCalled()
      expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.error).toContain(
        'stale'
      )
    } else {
      expect(mocks.commit).toHaveBeenCalledOnce()
      const committed = mocks.commit.mock.calls[0][0]
      expect(committed.before.channelMessage).toBe('Before the edit')
      expect(committed.arguments.validation.cases[0].steps[0].assertions[1].equals).toBe('Pong!')
      expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.status).toBe(
        'completed'
      )
    }
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
    await run.service.resolveAgentApproval(
      run.session.id,
      'event',
      true,
      run.events.find((event) => event.type === 'approval')!.toolCall!.approvalId
    )
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
    await run.service.resolveAgentApproval(
      run.session.id,
      'change-1',
      false,
      run.events.find((event) => event.type === 'approval')!.toolCall!.approvalId
    )
    await run.finished
    expect(mocks.commit).not.toHaveBeenCalled()
    expect(run.events.filter((event) => event.type === 'tool').at(-1)!.toolCall!.status).toBe(
      'rejected'
    )
  })
})
