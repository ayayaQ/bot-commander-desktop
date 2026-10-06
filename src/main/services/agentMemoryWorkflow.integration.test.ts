import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentMemory,
  AgentMemoryListResult,
  AgentMemoryWithRevision,
  AgentSession,
  AgentStreamEvent,
  AgentToolCall
} from '../../shared/agentTypes'
import type { ResourceChangedEvent } from '../../shared/mcpTypes'
import type { AiRuntimeSettings } from './aiProviderService'

type ProviderMessage = {
  role?: string
  content?: string
  type?: string
  call_id?: string
  output?: string
}
type ProviderRequest = {
  model: string
  stream?: boolean
  input?: ProviderMessage[]
  messages?: ProviderMessage[]
  tools?: Array<{ name?: string; function?: { name: string } }>
}
type ProviderReply = {
  output_text: string
  output: Array<{
    type: 'function_call'
    call_id: string
    name: string
    arguments: string
  }>
}

const mocks = vi.hoisted(() => ({
  userDataPath: '',
  provider: vi.fn<(request: ProviderRequest, signal: AbortSignal) => Promise<ProviderReply>>()
}))

// Only the unavailable Electron shell and provider HTTP transport are substituted.
// The installed vivi runner, desktop tools, shared memory service, host admission,
// resource notifications, session checkpoints and atomic filesystem writer are real.
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

const settings: AiRuntimeSettings = {
  aiProvider: 'openai',
  openaiApiKey: 'mock-only',
  selectedAiModel: 'gpt-5.4-nano'
}
const mutationNames = ['create_memory', 'edit_memory', 'delete_memory'] as const

function textReply(content = 'Finished.'): ProviderReply {
  return { output_text: content, output: [] }
}

function toolReply(id: string, name: string, args: Record<string, unknown>): ProviderReply {
  return {
    output_text: '',
    output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }]
  }
}

function withoutRevision(memory: AgentMemoryWithRevision): AgentMemory {
  const { revision: _revision, ...record } = memory
  return record
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('desktop persistent memory workflow with the installed shared package', () => {
  let agent: typeof import('./agentService') | undefined
  let memories: typeof import('./agentMemoryService') | undefined
  let resources: typeof import('./resourceChangeService') | undefined
  let terminals: Array<Promise<AgentStreamEvent>>
  let memoryEvents: AgentMemoryListResult[]
  let resourceEvents: ResourceChangedEvent[]

  beforeEach(async () => {
    vi.resetModules()
    mocks.provider.mockReset().mockResolvedValue(textReply())
    mocks.userDataPath = await fs.mkdtemp(join(tmpdir(), 'agent-memory-workflow-'))
    agent = undefined
    memories = undefined
    resources = undefined
    terminals = []
    memoryEvents = []
    resourceEvents = []
    // Never delegate to the original fetch or contact Discord or a live provider.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const endpoint = String(url)
        if (
          endpoint !== 'https://api.openai.com/v1/responses' &&
          endpoint !== 'https://openrouter.ai/api/v1/chat/completions'
        ) {
          throw new Error(`Unexpected provider URL in memory workflow: ${endpoint}`)
        }
        const request = JSON.parse(init!.body as string) as ProviderRequest
        const reply = await mocks.provider(request, init!.signal as AbortSignal)
        if (endpoint === 'https://api.openai.com/v1/responses') {
          const response = { status: 'completed', ...reply, usage: {} }
          return request.stream
            ? new Response(
                `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
                { headers: { 'Content-Type': 'text/event-stream' } }
              )
            : new Response(JSON.stringify(response))
        }
        const toolCalls = reply.output.map((call, index) => ({
          index,
          id: call.call_id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }))
        const message = {
          role: 'assistant',
          content: reply.output_text,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        }
        const finishReason = toolCalls.length ? 'tool_calls' : 'stop'
        return request.stream
          ? new Response(
              `data: ${JSON.stringify({
                choices: [{ index: 0, delta: message, finish_reason: finishReason }],
                usage: {}
              })}\n\ndata: [DONE]\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } }
            )
          : new Response(
              JSON.stringify({ choices: [{ message, finish_reason: finishReason }], usage: {} })
            )
      })
    )
  })

  afterEach(async () => {
    agent?.stopAgentRuns()
    await Promise.all(terminals)
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent?.setAgentEventSink(null)
    memories?.setAgentMemoryEventSink(null)
    resources?.setResourceChangeEventSink(null)
    vi.unstubAllGlobals()
    await fs.rm(mocks.userDataPath, { recursive: true, force: true })
  })

  async function services() {
    agent ??= await import('./agentService')
    memories ??= await import('./agentMemoryService')
    resources ??= await import('./resourceChangeService')
    memories.setAgentMemoryEventSink((result) => memoryEvents.push(structuredClone(result)))
    resources.setResourceChangeEventSink((event) => resourceEvents.push(structuredClone(event)))
    return { agent, memories, resources }
  }

  async function userMemory(content = 'Prefer brief replies.'): Promise<AgentMemoryWithRevision> {
    const { memories } = await services()
    const result = await memories.commitMemoryMutation(
      await memories.prepareCreateMemory(content, 'user')
    )
    return result.memories.at(-1)!
  }

  async function createSession(mode: AgentSession['mode'] = 'manual', config = settings) {
    const { agent } = await services()
    const session = await agent.createAgentSession(config)
    await agent.updateAgentSession(session.id, { mode }, config.aiProvider || 'openai')
    return session
  }

  async function start(
    sessionId: string,
    content = 'Apply the requested preference.',
    config = settings
  ) {
    const { agent } = await services()
    const events: AgentStreamEvent[] = []
    const approval = deferred<AgentStreamEvent>()
    const terminal = deferred<AgentStreamEvent>()
    terminals.push(terminal.promise)
    agent.setAgentEventSink((event) => {
      events.push(structuredClone(event))
      if (event.type === 'approval') approval.resolve(event)
      if (event.type === 'done' || event.type === 'error') {
        approval.resolve(event)
        terminal.resolve(event)
      }
    })
    await agent.runAgentSession(sessionId, content, config)
    return { events, approval: approval.promise, terminal: terminal.promise }
  }

  async function storedSession(sessionId: string): Promise<AgentSession> {
    const { agent } = await services()
    return (await agent.loadAgentSessions()).sessions.find((session) => session.id === sessionId)!
  }

  async function diskMemories() {
    return JSON.parse(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8'))
  }

  async function reload() {
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent?.setAgentEventSink(null)
    memories?.setAgentMemoryEventSink(null)
    resources?.setResourceChangeEventSink(null)
    vi.resetModules()
    agent = undefined
    memories = undefined
    resources = undefined
    const loaded = await services()
    return {
      memories: await loaded.memories.loadAgentMemories(),
      sessions: await loaded.agent.loadAgentSessions()
    }
  }

  function latestCall(events: AgentStreamEvent[], id: string): AgentToolCall {
    return events.filter((event) => event.type === 'tool' && event.toolCall?.id === id).at(-1)!
      .toolCall!
  }

  const approvalCases = mutationNames.flatMap((name) =>
    [true, false].map((approved) => ({ name, approved }))
  )
  it.each(approvalCases)(
    '$name with manual approval=$approved preserves exact review snapshots and survives reload',
    async ({ name, approved }) => {
      const initialMemory = name === 'create_memory' ? undefined : await userMemory()
      const { memories, resources, agent } = await services()
      const initial = await memories.loadAgentMemories()
      const initialBytes = await fs.readFile(
        join(mocks.userDataPath, 'agent-memories.json'),
        'utf8'
      )
      memoryEvents.length = 0
      resourceEvents.length = 0
      const args =
        name === 'create_memory'
          ? { content: '  Prefer concise examples.  ' }
          : {
              id: initialMemory!.id,
              expectedRevision: initialMemory!.revision,
              ...(name === 'edit_memory' ? { content: 'Prefer concise examples.' } : {})
            }
      const callId = `${name}-${approved}`
      mocks.provider.mockResolvedValueOnce(toolReply(callId, name, args))
      const session = await createSession()
      const run = await start(session.id)
      const review = await run.approval
      expect(review.type, JSON.stringify(run.events)).toBe('approval')
      const call = review.toolCall!
      expect(call).toMatchObject({ id: callId, name, status: 'waiting_approval', arguments: args })
      expect(call.before).toEqual(initialMemory ? withoutRevision(initialMemory) : null)
      const candidate = call.after as AgentMemory | null
      if (name === 'delete_memory') expect(candidate).toBeNull()
      else {
        expect(candidate).toEqual({
          id: initialMemory?.id || expect.any(String),
          content: 'Prefer concise examples.',
          createdAt: initialMemory?.createdAt || expect.any(String),
          updatedAt: expect.any(String),
          createdBy: initialMemory ? 'user' : 'agent',
          updatedBy: 'agent'
        })
      }
      expect(await memories.loadAgentMemories()).toEqual(initial)
      expect(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')).toBe(
        initialBytes
      )
      expect(memoryEvents).toEqual([])
      expect(resourceEvents).toEqual([])
      expect(mocks.provider).toHaveBeenCalledTimes(1)
      expect(await agent.resolveAgentApproval(session.id, callId, approved)).toBe(true)
      expect((await run.terminal).session?.status).toBe('completed')
      const completed = latestCall(run.events, callId)
      expect(completed.before).toEqual(call.before)
      expect(completed.after).toEqual(candidate)
      expect(completed.status).toBe(approved ? 'completed' : 'rejected')
      const expectedRecords = approved
        ? candidate
          ? [candidate]
          : []
        : initial.memories.map(withoutRevision)
      expect(await diskMemories()).toEqual({ version: 1, memories: expectedRecords })
      const expectedList = expectedRecords.map((memory) => ({
        ...memory,
        revision: memories.agentMemoryRevision(memory)
      }))
      expect((await memories.loadAgentMemories()).memories).toEqual(expectedList)
      if (approved) {
        expect(completed.result).toMatchObject({
          success: true,
          target: { type: 'memory', id: candidate?.id || initialMemory!.id }
        })
        expect((completed.result as { revision?: string }).revision).toBe(
          candidate ? memories.agentMemoryRevision(candidate) : undefined
        )
        expect(memoryEvents).toEqual([{ ...initial, memories: expectedList }])
        expect(resourceEvents).toEqual([
          {
            kind: 'memories',
            source: 'agent',
            targetId: candidate?.id || initialMemory!.id,
            revision: resources.resourceRevision({ ...initial, memories: expectedList })
          }
        ])
        expect(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json.bak'), 'utf8')).toBe(
          initialBytes
        )
      } else {
        expect(completed.result).toMatchObject({ success: false, denied: true })
        expect(memoryEvents).toEqual([])
        expect(resourceEvents).toEqual([])
        expect(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')).toBe(
          initialBytes
        )
      }
      expect(mocks.provider).toHaveBeenCalledTimes(2)
      expect(
        (await fs.readdir(mocks.userDataPath)).filter((name) => name.endsWith('.tmp'))
      ).toEqual([])
      const reloaded = await reload()
      expect(reloaded.memories.memories).toEqual(expectedList)
      const saved = reloaded.sessions.sessions.find((item) => item.id === session.id)!
      expect(saved.status).toBe('completed')
      expect(saved.messages.flatMap((message) => message.toolCalls || [])).toContainEqual(completed)
    }
  )

  it.each(['edit_memory', 'delete_memory'] as const)(
    'rejects an approved %s after an intervening user edit and keeps the newer revision',
    async (name) => {
      const original = await userMemory()
      const { agent, memories } = await services()
      mocks.provider.mockResolvedValueOnce(
        toolReply('stale-memory', name, {
          id: original.id,
          expectedRevision: original.revision,
          ...(name === 'edit_memory' ? { content: 'Agent proposed preference.' } : {})
        })
      )
      const session = await createSession()
      const run = await start(session.id)
      const review = await run.approval
      expect(review.type).toBe('approval')
      expect(review.toolCall!.before).toEqual(withoutRevision(original))
      const changed = await memories.commitMemoryMutation(
        await memories.prepareUpdateMemory(
          original.id,
          original.revision,
          'User changed this preference while approval was open.',
          'user'
        )
      )
      const changedBytes = await fs.readFile(
        join(mocks.userDataPath, 'agent-memories.json'),
        'utf8'
      )
      memoryEvents.length = 0
      resourceEvents.length = 0
      expect(await agent.resolveAgentApproval(session.id, 'stale-memory', true)).toBe(true)
      expect((await run.terminal).session?.status).toBe('completed')
      expect(latestCall(run.events, 'stale-memory')).toMatchObject({
        status: 'error',
        before: review.toolCall!.before,
        after: review.toolCall!.after,
        error: expect.stringContaining('Stale memory revision')
      })
      expect(await memories.loadAgentMemories()).toEqual(changed)
      expect(changed.memories[0].revision).not.toBe(original.revision)
      expect(changed.memories[0]).toMatchObject({ createdBy: 'user', updatedBy: 'user' })
      expect(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')).toBe(
        changedBytes
      )
      expect(memoryEvents).toEqual([])
      expect(resourceEvents).toEqual([])
      expect((await reload()).memories).toEqual(changed)
    }
  )

  it('automatically commits create, edit and delete with one memory and resource event per save', async () => {
    const { memories } = await services()
    mocks.provider
      .mockResolvedValueOnce(
        toolReply('auto-create', 'create_memory', { content: 'Use short replies.' })
      )
      .mockImplementationOnce(async () => {
        const current = (await memories.loadAgentMemories()).memories[0]
        return toolReply('auto-edit', 'edit_memory', {
          id: current.id,
          expectedRevision: current.revision,
          content: 'Use short examples.'
        })
      })
      .mockImplementationOnce(async () => {
        const current = (await memories.loadAgentMemories()).memories[0]
        return toolReply('auto-delete', 'delete_memory', {
          id: current.id,
          expectedRevision: current.revision
        })
      })
    const session = await createSession('auto')
    const run = await start(session.id)
    expect((await run.terminal).session?.status).toBe('completed')
    expect(run.events.some((event) => event.type === 'approval')).toBe(false)
    expect(memoryEvents.map((event) => event.memories.map((memory) => memory.content))).toEqual([
      ['Use short replies.'],
      ['Use short examples.'],
      []
    ])
    const first = memoryEvents[0].memories[0]
    const second = memoryEvents[1].memories[0]
    expect(first).toMatchObject({ createdBy: 'agent', updatedBy: 'agent' })
    expect(second).toMatchObject({ id: first.id, createdBy: 'agent', updatedBy: 'agent' })
    expect(second.revision).not.toBe(first.revision)
    expect(latestCall(run.events, 'auto-create').after).toEqual(withoutRevision(first))
    expect(latestCall(run.events, 'auto-edit')).toMatchObject({
      before: withoutRevision(first),
      after: withoutRevision(second),
      status: 'completed'
    })
    expect(latestCall(run.events, 'auto-delete')).toMatchObject({
      before: withoutRevision(second),
      after: null,
      status: 'completed'
    })
    expect(resourceEvents).toEqual(
      memoryEvents.map((result) => ({
        kind: 'memories',
        source: 'agent',
        targetId: first.id,
        revision: resources!.resourceRevision(result)
      }))
    )
    expect(mocks.provider).toHaveBeenCalledTimes(4)
    expect(await diskMemories()).toEqual({ version: 1, memories: [] })
    expect((await reload()).memories.memories).toEqual([])
  })

  it('keeps planning list_memories available and rejects every unadvertised memory write', async () => {
    const memory = await userMemory()
    const { memories } = await services()
    memoryEvents.length = 0
    resourceEvents.length = 0
    const initialBytes = await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')
    mocks.provider.mockResolvedValueOnce({
      output_text: '',
      output: [
        ...toolReply('planning-list', 'list_memories', {}).output,
        ...toolReply('planning-create', 'create_memory', { content: 'Planning-only proposal.' })
          .output,
        ...toolReply('planning-edit', 'edit_memory', {
          id: memory.id,
          expectedRevision: memory.revision,
          content: 'Planning-only replacement.'
        }).output,
        ...toolReply('planning-delete', 'delete_memory', {
          id: memory.id,
          expectedRevision: memory.revision
        }).output
      ]
    })
    const session = await createSession('planning')
    const run = await start(session.id, 'Plan how to update this preference.')
    expect((await run.terminal).session?.status).toBe('completed')
    const names = mocks.provider.mock.calls[0][0].tools!.map((tool) => tool.name)
    expect(names).toContain('list_memories')
    for (const name of mutationNames) expect(names).not.toContain(name)
    expect(latestCall(run.events, 'planning-list')).toMatchObject({
      status: 'completed',
      result: { memories: [memory] }
    })
    const saved = await storedSession(session.id)
    const rejected = saved.history!.filter(
      (entry) =>
        entry.kind === 'tool_result' &&
        mutationNames.includes(entry.name as (typeof mutationNames)[number])
    )
    expect(rejected).toHaveLength(3)
    for (const entry of rejected) {
      expect(entry.kind).toBe('tool_result')
      if (entry.kind === 'tool_result') {
        expect(entry.isError).toBe(true)
        expect(JSON.parse(entry.content)).toMatchObject({
          success: false,
          error: { code: 'unavailable_tool' }
        })
      }
    }
    expect(run.events.some((event) => event.type === 'approval')).toBe(false)
    expect((await memories.loadAgentMemories()).memories).toEqual([memory])
    expect(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')).toBe(
      initialBytes
    )
    expect(memoryEvents).toEqual([])
    expect(resourceEvents).toEqual([])
  })

  it.each(['unknown', 'chat-without-tools'] as const)(
    '%s model receives quoted user-level memory context while no memory writes execute',
    async (modelKind) => {
      const memory = await userMemory()
      const config: AiRuntimeSettings =
        modelKind === 'unknown'
          ? { ...settings, selectedAiModel: 'gpt-next-unverified' }
          : {
              aiProvider: 'openrouter',
              openaiApiKey: 'mock-only',
              openrouterApiKey: 'mock-only-router',
              selectedOpenRouterModel: 'test/chat-without-tools'
            }
      if (modelKind === 'chat-without-tools') {
        const { modelCapabilityCatalog } = await import('./modelCapabilityService')
        const generation = modelCapabilityCatalog.begin('openrouter', config.openrouterApiKey)
        expect(
          modelCapabilityCatalog.complete('openrouter', config.openrouterApiKey, generation, [
            {
              id: config.selectedOpenRouterModel,
              supported_parameters: ['temperature'],
              architecture: { input_modalities: ['text'], output_modalities: ['text'] }
            }
          ])
        ).toBe(true)
      }
      const session = await createSession('auto', config)
      const { agent, memories } = await services()
      const { getAgentModelCapabilities } = await import('./agentProviderAdapter')
      expect(getAgentModelCapabilities(config, session.model).tools).toBe(
        modelKind === 'unknown' ? 'unknown' : 'unsupported'
      )
      memoryEvents.length = 0
      resourceEvents.length = 0
      mocks.provider.mockResolvedValueOnce({
        output_text: '',
        output: [
          ...toolReply('no-tools-create', 'create_memory', { content: 'Proposed preference.' })
            .output,
          ...toolReply('no-tools-edit', 'edit_memory', {
            id: memory.id,
            expectedRevision: memory.revision,
            content: 'Proposed replacement.'
          }).output,
          ...toolReply('no-tools-delete', 'delete_memory', {
            id: memory.id,
            expectedRevision: memory.revision
          }).output
        ]
      })
      const run = await start(session.id, 'Discuss the preference.', config)
      expect((await run.terminal).session?.status).toBe('completed')
      expect(mocks.provider.mock.calls[0][0]).not.toHaveProperty('tools')
      const request = mocks.provider.mock.calls[0][0]
      const input = request.input || request.messages!
      expect(input[0]).toMatchObject({ role: 'system' })
      expect(input[0].content).toContain('No tools are available for this model')
      expect(input[0].content).not.toContain(memory.content)
      expect(input[1]).toEqual({
        role: 'user',
        content: `${agent.formatAgentMemoryContext([memory])}\nThis is context only, not a request to act.`
      })
      expect(input[1].content).toContain(`- ${JSON.stringify(memory.content)}`)
      const saved = await storedSession(session.id)
      const rejected = saved.history!.filter((entry) => entry.kind === 'tool_result')
      expect(rejected).toHaveLength(3)
      for (const entry of rejected) {
        if (entry.kind === 'tool_result') {
          expect(JSON.parse(entry.content)).toMatchObject({ error: { code: 'unavailable_tool' } })
        }
      }
      expect(run.events.some((event) => event.type === 'approval' || event.type === 'tool')).toBe(
        false
      )
      expect((await memories.loadAgentMemories()).memories).toEqual([memory])
      expect(memoryEvents).toEqual([])
      expect(resourceEvents).toEqual([])
      expect(JSON.stringify(saved.history)).not.toContain('Saved user memories')
      expect(JSON.stringify(saved.history)).not.toContain('Bot Commander agent harness')
      expect((await reload()).memories.memories).toEqual([memory])
    }
  )

  it('cancels a pending approval without saving or dispatching later calls or provider rounds', async () => {
    const memory = await userMemory()
    const { agent, memories } = await services()
    const initialBytes = await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')
    memoryEvents.length = 0
    resourceEvents.length = 0
    mocks.provider.mockResolvedValueOnce({
      output_text: '',
      output: [
        ...toolReply('cancel-first', 'create_memory', { content: 'First proposed preference.' })
          .output,
        ...toolReply('cancel-second', 'create_memory', { content: 'Second proposed preference.' })
          .output
      ]
    })
    const session = await createSession()
    const run = await start(session.id)
    expect((await run.approval).toolCall?.id).toBe('cancel-first')
    expect(agent.cancelAgentRun(session.id)).toBe(true)
    expect((await run.terminal).session?.status).toBe('cancelled')
    expect(await agent.resolveAgentApproval(session.id, 'cancel-first', true)).toBe(false)
    expect(run.events.filter((event) => event.type === 'approval')).toHaveLength(1)
    expect(run.events.some((event) => event.toolCall?.id === 'cancel-second')).toBe(false)
    expect(mocks.provider).toHaveBeenCalledTimes(1)
    expect((await memories.loadAgentMemories()).memories).toEqual([memory])
    expect(await fs.readFile(join(mocks.userDataPath, 'agent-memories.json'), 'utf8')).toBe(
      initialBytes
    )
    expect(memoryEvents).toEqual([])
    expect(resourceEvents).toEqual([])
    const saved = await storedSession(session.id)
    expect(JSON.stringify(saved.history)).not.toContain('Saved user memories')
    const reloaded = await reload()
    expect(reloaded.memories.memories).toEqual([memory])
    expect(reloaded.sessions.sessions.find((item) => item.id === session.id)?.status).toBe(
      'cancelled'
    )
  })

  it('cancels an admitted memory tool waiting behind a user save without a second commit or event', async () => {
    const { memories } = await services()
    const tools = await import('./agentTools')
    // Complete the host's initial checkpoint before installing a primary-only gate.
    await memories.loadAgentMemories()
    const userProposal = await memories.prepareCreateMemory('Accepted user preference.', 'user')
    const agentProposal = await tools.prepareMutation('create_memory', {
      content: 'Queued agent preference.'
    })
    const primary = join(mocks.userDataPath, 'agent-memories.json')
    const renameReached = deferred<void>()
    const releaseRename = deferred<void>()
    const toolQueued = deferred<void>()
    const originalRename = fs.rename.bind(fs)
    let primaryRenames = 0
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === primary) {
        primaryRenames++
        if (primaryRenames === 1) {
          renameReached.resolve()
          await releaseRename.promise
        }
      }
      return originalRename(from, to)
    })
    const originalCommit = memories.commitMemoryMutation
    const commitSpy = vi
      .spyOn(memories, 'commitMemoryMutation')
      .mockImplementation((mutation, options) => {
        const committed = originalCommit(mutation, options)
        if (mutation.after?.id === agentProposal.target.id) {
          // Host admission queues its microtask before this observation. By the time
          // it resolves, the real shared memory commit is behind the blocked save.
          void Promise.resolve().then(() => toolQueued.resolve())
        }
        return committed
      })
    const direct = memories.commitMemoryMutation(userProposal)
    let queued: Promise<unknown> | undefined
    try {
      await renameReached.promise
      const controller = new AbortController()
      const admitted = vi.fn()
      queued = tools.commitMutation(agentProposal, 'agent', controller.signal, admitted)
      // Observe rejection now, before aborting, to avoid a detached rejection.
      const rejected = expect(queued).rejects.toThrow('Cancelled queued memory tool')
      await toolQueued.promise
      expect(admitted).toHaveBeenCalledExactlyOnceWith(agentProposal)
      expect(commitSpy).toHaveBeenLastCalledWith(
        { kind: 'create', before: null, after: agentProposal.after },
        { signal: controller.signal }
      )
      expect(memoryEvents).toEqual([])
      expect(resourceEvents).toEqual([])
      controller.abort(new Error('Cancelled queued memory tool'))
      releaseRename.resolve()
      const accepted = await direct
      await rejected
      expect(primaryRenames).toBe(1)
      expect(accepted.memories).toHaveLength(1)
      expect(accepted.memories[0]).toMatchObject({
        content: 'Accepted user preference.',
        createdBy: 'user',
        updatedBy: 'user'
      })
      expect(await memories.loadAgentMemories()).toEqual(accepted)
      expect(await diskMemories()).toEqual({ version: 1, memories: [userProposal.after] })
      expect(memoryEvents).toEqual([accepted])
      expect(resourceEvents).toEqual([])
      expect(mocks.provider).not.toHaveBeenCalled()
    } finally {
      releaseRename.resolve()
      await Promise.allSettled([direct, ...(queued ? [queued] : [])])
      commitSpy.mockRestore()
      renameSpy.mockRestore()
    }
    expect((await reload()).memories.memories.map((memory) => memory.content)).toEqual([
      'Accepted user preference.'
    ])
  })

  it('publishes exactly one resource event with mcp source for each actual MCP memory tool commit', async () => {
    const { memories, resources } = await services()
    const { executeAgentTool } = await import('./agentTools')
    const created = await executeAgentTool(
      'create_memory',
      { content: 'Prefer TypeScript examples.' },
      'mcp'
    )
    expect(created).toMatchObject({ success: true, target: { type: 'memory' } })
    const first = (await memories.loadAgentMemories()).memories[0]
    expect(first).toMatchObject({ createdBy: 'agent', updatedBy: 'agent' })
    await executeAgentTool(
      'edit_memory',
      {
        id: first.id,
        expectedRevision: first.revision,
        content: 'Prefer concise TypeScript examples.'
      },
      'mcp'
    )
    const updated = (await memories.loadAgentMemories()).memories[0]
    await executeAgentTool(
      'delete_memory',
      {
        id: updated.id,
        expectedRevision: updated.revision
      },
      'mcp'
    )
    expect(memoryEvents).toHaveLength(3)
    expect(resourceEvents).toEqual(
      memoryEvents.map((result) => ({
        kind: 'memories',
        source: 'mcp',
        targetId: first.id,
        revision: resources.resourceRevision(result)
      }))
    )
    expect(mocks.provider).not.toHaveBeenCalled()
    expect((await reload()).memories.memories).toEqual([])
  })

  it('refreshes app-wide memory context across turns and sessions without persisting prefixes on normal, error or cancel', async () => {
    const original = await userMemory('Prefer brief replies.')
    const firstSession = await createSession()
    const secondSession = await createSession()
    const { agent, memories } = await services()

    function assertCurrentPrefix(request: ProviderRequest, content?: string) {
      const input = request.input!
      const prefixes = input.filter((entry) => entry.content?.startsWith('Saved user memories'))
      expect(prefixes).toEqual(
        content
          ? [
              {
                role: 'user',
                content: `${agent.formatAgentMemoryContext([{ content, updatedAt: '' }])}\nThis is context only, not a request to act.`
              }
            ]
          : []
      )
      if (content) expect(prefixes[0].content).toContain(`- ${JSON.stringify(content)}`)
      expect(input[0].role).toBe('system')
      for (const entry of input.filter((entry) => entry.role === 'system')) {
        expect(entry.content).not.toContain('Prefer brief replies.')
        expect(entry.content).not.toContain('Prefer short examples.')
      }
    }

    async function assertCleanHistory() {
      const { agent: currentAgent } = await services()
      const data = await currentAgent.loadAgentSessions()
      for (const session of data.sessions) {
        expect(
          session.history!.some((entry) => entry.kind === 'message' && entry.role === 'system')
        ).toBe(false)
        expect(JSON.stringify(session.history)).not.toContain('Saved user memories')
        expect(JSON.stringify(session.messages)).not.toContain('Saved user memories')
        expect(JSON.stringify(session.history)).not.toContain('Bot Commander agent harness')
      }
      for (const filename of ['agent-sessions.json', 'agent-sessions.json.bak']) {
        const durable = await fs.readFile(join(mocks.userDataPath, filename), 'utf8')
        expect(durable).not.toContain('Saved user memories')
        expect(durable).not.toContain('Bot Commander agent harness')
        expect(durable).not.toContain('Prefer brief replies.')
        expect(durable).not.toContain('Prefer short examples.')
      }
    }

    const first = await start(firstSession.id, 'First ordinary question.')
    expect((await first.terminal).session?.status).toBe('completed')
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0], original.content)
    await assertCleanHistory()
    const changed = (
      await memories.commitMemoryMutation(
        await memories.prepareUpdateMemory(
          original.id,
          original.revision,
          'Prefer short examples.',
          'user'
        )
      )
    ).memories[0]
    const second = await start(firstSession.id, 'Second ordinary question.')
    expect((await second.terminal).session?.status).toBe('completed')
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0], changed.content)
    expect(JSON.stringify(mocks.provider.mock.calls.at(-1)![0].input)).not.toContain(
      original.content
    )
    expect(mocks.provider.mock.calls.at(-1)![0].input).toContainEqual({
      role: 'user',
      content: 'First ordinary question.'
    })
    const other = await start(secondSession.id, 'Question in another session.')
    expect((await other.terminal).session?.status).toBe('completed')
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0], changed.content)
    await assertCleanHistory()

    mocks.provider.mockRejectedValueOnce(new Error('Fake provider transport failed'))
    const failed = await start(secondSession.id, 'Question with a provider error.')
    expect((await failed.terminal).session?.status).toBe('error')
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0], changed.content)
    await assertCleanHistory()

    const requested = deferred<void>()
    mocks.provider.mockImplementationOnce(async (_request, signal) => {
      requested.resolve()
      return new Promise<ProviderReply>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Fake transport cancelled')), {
          once: true
        })
      })
    })
    const cancelled = await start(secondSession.id, 'Question cancelled during provider work.')
    await requested.promise
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0], changed.content)
    expect(agent.cancelAgentRun(secondSession.id)).toBe(true)
    expect((await cancelled.terminal).session?.status).toBe('cancelled')
    await assertCleanHistory()

    await memories.commitMemoryMutation(
      await memories.prepareDeleteMemory(changed.id, changed.revision)
    )
    const afterDelete = await start(firstSession.id, 'Question after forgetting the preference.')
    expect((await afterDelete.terminal).session?.status).toBe('completed')
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0])
    expect(JSON.stringify(mocks.provider.mock.calls.at(-1)![0].input)).not.toContain(
      changed.content
    )
    await assertCleanHistory()
    const beforeReload = (await agent.loadAgentSessions()).sessions.map((session) => ({
      id: session.id,
      history: session.history
    }))
    const reloaded = await reload()
    expect(reloaded.memories.memories).toEqual([])
    expect(
      reloaded.sessions.sessions.map((session) => ({ id: session.id, history: session.history }))
    ).toEqual(beforeReload)
    const afterRestart = await start(secondSession.id, 'Question after restarting.')
    expect((await afterRestart.terminal).session?.status).toBe('completed')
    assertCurrentPrefix(mocks.provider.mock.calls.at(-1)![0])
    await assertCleanHistory()
  })
})
