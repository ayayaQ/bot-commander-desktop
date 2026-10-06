import { describe, expect, it, vi } from 'vitest'
import { getAgentSkillSaveSupport } from './agentSkillSaveSupport'
import { createAgentSkillStore } from './agentSkillStore'
import { parseSkillDocument } from '@ayayaq/vivi/extensions/skills'

describe('production skill save capability', () => {
  it('fails closed before any filesystem write, including Windows and macOS', async () => {
    expect(getAgentSkillSaveSupport()).toMatchObject({ available: false })
    const root = vi.fn(() => {
      throw new Error('No path should be resolved for an unavailable writer')
    })
    const store = createAgentSkillStore({ ownedRoot: root, externalRoots: async () => [] })
    const content =
      '---\nname: summary\ndescription: A summary skill\n---\nSummarize supplied text.\n'
    await expect(
      store.commit(
        {
          name: 'summary',
          before: null,
          expectedRevision: null,
          after: parseSkillDocument(content)
        },
        { signal: new AbortController().signal }
      )
    ).rejects.toThrow('handle-bound filesystem adapter')
    expect(root).not.toHaveBeenCalled()
  })
})

// Production harness check: only Electron and HTTP transport are replaced. The save-support
// module is real here, unlike the explicitly named fixture-writer workflow suite.
vi.mock('electron', () => ({
  app: { getPath: () => production.home },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {}
}))
const production = vi.hoisted(() => ({ home: '' }))

describe('production skill registry without a save adapter', () => {
  it.each(['manual', 'auto', 'planning'] as const)(
    'does not advertise or execute agent skill saves in %s mode',
    async (mode) => {
      const fs = (await import('node:fs/promises')).default
      const { tmpdir } = await import('node:os')
      const { join } = await import('node:path')
      production.home = await fs.mkdtemp(join(tmpdir(), 'skills-production-readonly-'))
      vi.resetModules()
      const requests: Array<{ tools?: Array<{ name: string }> }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url, init) => {
          requests.push(JSON.parse(init.body))
          const reply =
            requests.length === 1
              ? {
                  output_text: '',
                  output: [
                    {
                      type: 'function_call',
                      call_id: 'unavailable-save',
                      name: 'save_skill',
                      arguments: JSON.stringify({
                        name: 'summary',
                        expectedRevision: null,
                        content:
                          '---\nname: summary\ndescription: A summary\n---\nSummarize supplied text.\n'
                      })
                    }
                  ]
                }
              : { output_text: 'Saving is unavailable.', output: [] }
          return new Response(
            `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', ...reply, usage: {} } })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
        })
      )
      const agent = await import('./agentService')
      const events: Array<{ type: string }> = []
      try {
        const settings = {
          aiProvider: 'openai' as const,
          openaiApiKey: 'fixture-only-key',
          selectedAiModel: 'gpt-5.4-nano'
        }
        const session = await agent.createAgentSession(settings)
        await agent.updateAgentSession(session.id, { mode }, 'openai')
        const done = new Promise<void>((resolve) =>
          agent.setAgentEventSink((event) => {
            events.push(event)
            if (event.type === 'done' || event.type === 'error') resolve()
          })
        )
        await agent.runAgentSession(session.id, 'Draft a reusable summary skill.', settings)
        await done
        expect(requests[0].tools!.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(['list_skills', 'read_skill'])
        )
        expect(requests[0].tools!.map((tool) => tool.name)).not.toContain('save_skill')
        expect(events.some((event) => event.type === 'approval')).toBe(false)
        await expect(fs.stat(join(production.home, 'agent-skills'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
      } finally {
        agent.stopAgentRuns()
        await (await import('./agentPersistenceLifecycle')).drainAgentPersistence()
        agent.setAgentEventSink(null)
        vi.unstubAllGlobals()
        await fs.rm(production.home, { recursive: true, force: true })
      }
    }
  )
})
