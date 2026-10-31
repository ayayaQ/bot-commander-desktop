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
  probability: 1,
  provider: vi.fn<(request: Request) => Reply | Promise<Reply>>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => mocks.home },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'fixture-native',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
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

describe('desktop skills host workflow with installed vivi', () => {
  let agent: typeof import('./agentService')
  let skills: typeof import('./agentSkillService')
  let terminals: Promise<AgentStreamEvent>[]
  beforeEach(async () => {
    vi.resetModules()
    mocks.home = join(await fs.mkdtemp(join(tmpdir(), 'agent-skills-workflow-')), 'state')
    await fs.mkdir(mocks.home)
    mocks.provider.mockReset().mockReturnValue(text())
    mocks.probability = 1
    terminals = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === 'https://api.openai.com/v1/decisions') {
          const request = JSON.parse(init!.body as string)
          return new Response(
            JSON.stringify({
              model: 'gpt-6-luna',
              answers: request.questions.map(({ name }: { name: string }) => ({
                name,
                type: 'predicate',
                probability: mocks.probability
              })),
              usage: {
                input_tokens: 20,
                output_tokens: 5,
                total_tokens: 25,
                input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 }
              }
            }),
            { headers: { 'Content-Type': 'application/json' } }
          )
        }
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
  it('prepares the owned folder for manual imports without changing existing contents', async () => {
    const root = await skills.ensureAgentSkillsFolder()
    // Windows temp paths can use an 8.3 alias; the folder service returns its canonical path.
    expect(root).toBe(await fs.realpath(join(mocks.home, 'agent-skills')))
    expect((await fs.stat(root)).isDirectory()).toBe(true)
    const path = await seed()
    expect(await skills.ensureAgentSkillsFolder()).toBe(root)
    expect(await fs.readFile(path, 'utf8')).toBe(source())
  })
  it('refuses a linked owned folder when opening the skills directory', async () => {
    const target = join(mocks.home, '../external')
    await fs.mkdir(target)
    await fs.symlink(
      target,
      join(mocks.home, 'agent-skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(skills.ensureAgentSkillsFolder()).rejects.toThrow('without symlinks')
    expect(await fs.readdir(target)).toEqual([])
  })
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
  const draft = (content = source(), expectedRevision: string | null = null) => ({
    name: 'concise-summary',
    content,
    expectedRevision
  })
  async function approve(event: AgentStreamEvent, approved = true) {
    expect(event.type, JSON.stringify(event)).toBe('approval')
    const call = event.toolCall!
    expect(
      await agent.resolveAgentApproval(event.sessionId, call.id, approved, call.approvalId)
    ).toBe(true)
  }
  it('shows the exact draft in Manual, writes only after approval and activates next turn', async () => {
    mocks.provider.mockReturnValueOnce(tool('save_skill', draft())).mockReturnValue(text())
    const created = await session()
    const run = await start(created.id)
    const event = await run.approval
    expect(event.toolCall).toMatchObject({
      name: 'save_skill',
      before: null,
      after: { id: 'concise-summary', content: source() }
    })
    const path = join(mocks.home, 'agent-skills', 'concise-summary', 'SKILL.md')
    await expect(fs.stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await approve(event)
    expect((await run.terminal).session!.status).toBe('completed')
    expect(await fs.readFile(path, 'utf8')).toBe(source())
    expect(
      (await skills.loadAgentSkills()).skills.find((s) => s.name === 'concise-summary')!.readOnly
    ).toBe(false)
    const catalog = mocks.provider.mock.calls[1][0].input!.find((m) =>
      m.content?.includes('Available instruction-only skills')
    )!
    expect(catalog.content).not.toContain('concise-summary')
    mocks.provider.mockReset().mockReturnValue(text())
    await (
      await start(created.id)
    ).terminal
    const input = mocks.provider.mock.calls[0][0].input!
    expect(
      input.find((m) => m.content?.includes('Available instruction-only skills'))!.content
    ).toContain('concise-summary')
  })
  it.each([false, 'cancel'] as const)(
    'does not write a rejected or cancelled draft (%s)',
    async (decision) => {
      mocks.provider.mockReturnValueOnce(tool('save_skill', draft())).mockReturnValue(text())
      const created = await session()
      const run = await start(created.id)
      const event = await run.approval
      if (decision === 'cancel') agent.cancelAgentRun(created.id)
      else await approve(event, false)
      await run.terminal
      await expect(fs.stat(join(mocks.home, 'agent-skills'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  )
  it('approves an exact replacement but preserves an edit made while approval is pending', async () => {
    const path = await seed()
    const updated = source('Return one factual sentence.')
    const revision = parseSkillDocument(source()).revision
    mocks.provider
      .mockReturnValueOnce(tool('save_skill', draft(updated, revision)))
      .mockReturnValue(text())
    const created = await session()
    let run = await start(created.id)
    await approve(await run.approval)
    await run.terminal
    expect(await fs.readFile(path, 'utf8')).toBe(updated)
    mocks.provider
      .mockReset()
      .mockReturnValueOnce(
        tool('save_skill', draft(source(), parseSkillDocument(updated).revision), 'second-save')
      )
      .mockReturnValue(text())
    run = await start(created.id)
    const event = await run.approval
    const external = source('User edited this file in another editor.')
    await fs.writeFile(path, external)
    await approve(event)
    await run.terminal
    expect(await fs.readFile(path, 'utf8')).toBe(external)
    const calls = (await saved(created.id)).messages.flatMap((m) => m.toolCalls || [])
    expect(calls.filter((c) => c.name === 'save_skill').at(-1)!.status).toBe('error')
  })
  it('does not save or ask to approve a hallucinated save call in Planning', async () => {
    mocks.provider.mockReturnValueOnce(tool('save_skill', draft())).mockReturnValue(text())
    const created = await session('planning')
    const run = await start(created.id)
    await run.terminal
    expect(run.events.some((e) => e.type === 'approval')).toBe(false)
    expect(mocks.provider.mock.calls[0][0].tools!.map((t) => t.name)).not.toContain('save_skill')
    await expect(fs.stat(join(mocks.home, 'agent-skills'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })
  it.each(['create', 'replace'] as const)(
    'automatically saves an enrolled Auto %s after allow-review and journals the result',
    async (action) => {
      const current = await import('./settingsService')
      const { AUTO_REVIEW_POLICY_REVISION } = await import('../../shared/agentAutoReview')
      current.setSettings({ ...current.getSettings(), ...settings })
      const created = await session()
      await agent.enrollAgentAutoReview(created.id, {
        policyRevision: AUTO_REVIEW_POLICY_REVISION,
        provider: 'openai',
        accountRevision: current.getSettings().agentDecisionAccountRevision!
      })
      if (action === 'replace') await seed(source('Original instructions.'))
      mocks.provider
        .mockReturnValueOnce(
          tool(
            'save_skill',
            draft(
              source(),
              action === 'replace'
                ? parseSkillDocument(source('Original instructions.')).revision
                : null
            )
          )
        )
        .mockReturnValue(text())
      const run = await start(created.id)
      const event = await run.approval
      expect(event.type, JSON.stringify(event.toolCall)).toBe('done')
      expect((await run.terminal).session!.status).toBe('completed')
      expect(run.events.some((e) => e.type === 'approval')).toBe(false)
      expect(
        await fs.readFile(join(mocks.home, 'agent-skills/concise-summary/SKILL.md'), 'utf8')
      ).toBe(source())
      const ledger = JSON.parse(await fs.readFile(join(mocks.home, 'agent-decisions.json'), 'utf8'))
      expect(ledger.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tool: 'save_skill',
            targetType: 'skill',
            state: 'committed',
            source: 'automatic'
          })
        ])
      )
    }
  )
  it('falls back to an exact Manual approval when Auto review is uncertain', async () => {
    const current = await import('./settingsService')
    const { AUTO_REVIEW_POLICY_REVISION } = await import('../../shared/agentAutoReview')
    current.setSettings({ ...current.getSettings(), ...settings })
    const created = await session()
    await agent.enrollAgentAutoReview(created.id, {
      policyRevision: AUTO_REVIEW_POLICY_REVISION,
      provider: 'openai',
      accountRevision: current.getSettings().agentDecisionAccountRevision!
    })
    mocks.probability = 0.5
    mocks.provider.mockReturnValueOnce(tool('save_skill', draft())).mockReturnValue(text())
    const run = await start(created.id)
    const event = await run.approval
    expect(event.toolCall!.decision).toMatchObject({ source: 'manual', recommendation: 'ask' })
    await expect(fs.stat(join(mocks.home, 'agent-skills'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await approve(event)
    await run.terminal
    expect(
      await fs.readFile(join(mocks.home, 'agent-skills/concise-summary/SKILL.md'), 'utf8')
    ).toBe(source())
  })
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
  it.skipIf(process.platform !== 'win32')(
    'removes the displayed root after an ordinary Windows case-only folder rename',
    async () => {
      const collection = join(mocks.home, '../MixedCaseCollection')
      const root = join(collection, 'concise-summary')
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(join(root, 'SKILL.md'), source())
      const configured = await skills.configureAgentSkillFolder(collection, true)
      const displayed = configured.externalRoots[0]
      const snapshot = await skills.agentSkillStore.snapshot()
      await fs.rename(collection, join(mocks.home, '../MIXEDCASECOLLECTION'))
      const removed = await skills.configureAgentSkillFolder(displayed, false)
      expect(removed.externalRoots).toEqual([])
      expect(
        await snapshot.authorizeRead(
          {
            name: 'concise-summary',
            path: 'SKILL.md',
            expectedRevision: parseSkillDocument(source()).revision
          },
          { signal: new AbortController().signal }
        )
      ).toBe(false)
    }
  )
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
    expect(first.tools!.map((item) => item.name)).toContain('save_skill')
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
