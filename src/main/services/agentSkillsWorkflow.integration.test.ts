import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSession, AgentStreamEvent } from '../../shared/agentTypes'
import type { AiRuntimeSettings } from './aiProviderService'
import { parseSkillDocument } from '@ayayaq/vivi/extensions/skills'

type Request = {
  input?: Array<{ role?: string; content?: string; type?: string; output?: string }>
  tools?: Array<{ name?: string }>
}
type Reply = {
  output_text: string
  output: Array<{ type: 'function_call'; call_id: string; name: string; arguments: string }>
}
const mocks = vi.hoisted(() => ({
  home: '',
  provider: vi.fn<(request: Request) => Reply | Promise<Reply>>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.home },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {}
}))
const settings: AiRuntimeSettings = {
  aiProvider: 'openai',
  openaiApiKey: 'mock-only',
  selectedAiModel: 'gpt-5.4-nano'
}
const source = (body = 'Return a short supplied-text summary.') =>
  `---\nname: concise-summary\ndescription: Summarize supplied text when asked for a short summary.\n---\n\n${body}\n`
const text = (): Reply => ({ output_text: 'Finished.', output: [] })
const tool = (name: string, args: Record<string, unknown>, id = name): Reply => ({
  output_text: '',
  output: [{ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }]
})
function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((settle) => (resolve = settle)),
    resolve: (value: T) => resolve(value)
  }
}

describe('desktop read-only skills host workflow with installed vivi', () => {
  let agent: typeof import('./agentService')
  let skills: typeof import('./agentSkillService')
  let terminals: Promise<AgentStreamEvent>[]
  beforeEach(async () => {
    vi.resetModules()
    mocks.home = join(await fs.mkdtemp(join(tmpdir(), 'agent-skills-workflow-')), 'state')
    await fs.mkdir(mocks.home)
    mocks.provider.mockReset().mockReturnValue(text())
    terminals = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) !== 'https://api.openai.com/v1/responses')
          throw new Error('Unexpected live transport')
        const request = JSON.parse(init!.body as string) as Request
        const reply = await mocks.provider(request)
        return new Response(
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', ...reply, usage: {} } })}\n\n`,
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      })
    )
    agent = await import('./agentService')
    skills = await import('./agentSkillService')
  })
  afterEach(async () => {
    agent.stopAgentRuns()
    await Promise.all(terminals)
    await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
    agent.setAgentEventSink(null)
    vi.unstubAllGlobals()
    await fs.rm(join(mocks.home, '..'), { recursive: true, force: true })
  })
  async function session(mode: AgentSession['mode'] = 'manual') {
    const result = await agent.createAgentSession(settings)
    await agent.updateAgentSession(result.id, { mode }, 'openai')
    return result
  }
  async function start(sessionId: string, onEvent?: (event: AgentStreamEvent) => void) {
    const approval = deferred<AgentStreamEvent>()
    const terminal = deferred<AgentStreamEvent>()
    const events: AgentStreamEvent[] = []
    terminals.push(terminal.promise)
    agent.setAgentEventSink((event) => {
      events.push(structuredClone(event))
      if (event.type === 'approval') approval.resolve(event)
      if (event.type === 'done' || event.type === 'error') {
        approval.resolve(event)
        terminal.resolve(event)
      }
      onEvent?.(event)
    })
    await agent.runAgentSession(sessionId, 'Use the relevant skills for this task.', settings)
    return { events, approval: approval.promise, terminal: terminal.promise }
  }
  async function saved(sessionId: string) {
    return (await agent.loadAgentSessions()).sessions.find((item) => item.id === sessionId)!
  }
  async function seed(content = source()) {
    const root = join(mocks.home, 'agent-skills', 'concise-summary')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, 'SKILL.md'), content)
    return join(root, 'SKILL.md')
  }
  it('retains explicitly selected read-only roots after reload and removes their future reads', async () => {
    const root = join(mocks.home, '../existing', 'concise-summary')
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, 'SKILL.md'), source())
    const configured = await skills.configureAgentSkillFolder(join(mocks.home, '../existing'), true)
    expect(configured.skills.find((item) => item.name === 'concise-summary')!.readOnly).toBe(true)
    vi.resetModules()
    skills = await import('./agentSkillService')
    const snapshot = await skills.agentSkillStore.snapshot()
    const request = {
      name: 'concise-summary',
      path: 'SKILL.md',
      expectedRevision: parseSkillDocument(source()).revision
    }
    expect(await snapshot.authorizeRead(request, { signal: new AbortController().signal })).toBe(
      true
    )
    await skills.configureAgentSkillFolder(join(mocks.home, '../existing'), false)
    expect(await snapshot.authorizeRead(request, { signal: new AbortController().signal })).toBe(
      false
    )
    expect((await skills.loadAgentSkills()).skills.map((item) => item.name)).toEqual([
      'skill-creator'
    ])
  })
  it('progressively advertises metadata and reads full source only on demand at lower priority', async () => {
    await seed()
    const document = parseSkillDocument(source())
    mocks.provider
      .mockReturnValueOnce(
        tool('read_skill', {
          name: 'concise-summary',
          path: 'SKILL.md',
          expectedRevision: document.revision
        })
      )
      .mockReturnValue(text())
    const created = await session()
    const run = await start(created.id)
    expect((await run.terminal).session!.status).toBe('completed')
    const first = mocks.provider.mock.calls[0][0]
    expect(first.tools!.map((item) => item.name)).toEqual(
      expect.arrayContaining(['calculate', 'list_skills', 'read_skill'])
    )
    expect(first.tools!.map((item) => item.name)).not.toContain('save_skill')
    const catalog = first.input!.find((message) =>
      message.content?.includes('Available instruction-only skills')
    )!
    expect(catalog.role).toBe('user')
    expect(catalog.content).toContain('concise-summary')
    expect(catalog.content).not.toContain('Return a short supplied-text summary.')
    const stored = await saved(created.id)
    expect(JSON.stringify(stored.history)).not.toContain('Available instruction-only skills')
    expect(
      stored.messages
        .flatMap((message) => message.toolCalls || [])
        .find((call) => call.name === 'read_skill')!.result
    ).toMatchObject({ content: source() })
    mocks.provider.mockReset().mockReturnValue(text())
    await (
      await start(created.id)
    ).terminal
    expect(JSON.stringify(mocks.provider.mock.calls[0][0].input)).not.toContain(
      'Return a short supplied-text summary.'
    )
    expect(JSON.stringify(mocks.provider.mock.calls[0][0].input)).toContain(
      'Earlier skill guidance omitted'
    )
  })
  it('returns complete valid skill documents and resources beyond the generic tool budget', async () => {
    const content = source('A'.repeat(30000) + '\nEND-OF-INSTRUCTIONS')
    const path = await seed(content)
    await fs.mkdir(join(path, '..', 'references'))
    const resource = 'B'.repeat(50000) + '\nEND-OF-REFERENCE'
    await fs.writeFile(join(path, '..', 'references', 'long.md'), resource)
    const revision = parseSkillDocument(content).revision
    mocks.provider
      .mockReturnValueOnce(
        tool(
          'read_skill',
          { name: 'concise-summary', path: 'SKILL.md', expectedRevision: revision },
          'long-document'
        )
      )
      .mockReturnValueOnce(
        tool(
          'read_skill',
          { name: 'concise-summary', path: 'references/long.md', expectedRevision: revision },
          'long-reference'
        )
      )
      .mockReturnValue(text())
    const created = await session()
    await (
      await start(created.id)
    ).terminal
    const calls = (await saved(created.id)).messages.flatMap((message) => message.toolCalls || [])
    expect(calls.find((call) => call.id === 'long-document')!.result).toMatchObject({ content })
    expect(calls.find((call) => call.id === 'long-reference')!.result).toMatchObject({
      content: resource
    })
    expect(JSON.stringify(mocks.provider.mock.calls.at(-1)![0].input)).toContain(
      'END-OF-INSTRUCTIONS'
    )
    expect(JSON.stringify(mocks.provider.mock.calls.at(-1)![0].input)).toContain('END-OF-REFERENCE')
  })
})
