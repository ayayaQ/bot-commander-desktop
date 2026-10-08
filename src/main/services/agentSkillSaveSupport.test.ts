import { describe, expect, it, vi } from 'vitest'
import { getAgentSkillSaveSupport } from './agentSkillSaveSupport'
import { createAgentSkillStore } from './agentSkillStore'

describe('production skill save capability', () => {
  it('has no writer or destination authority on any platform', () => {
    expect(getAgentSkillSaveSupport()).toMatchObject({ available: false })
    const root = vi.fn(() => {
      throw new Error('No path should be resolved')
    })
    const store = createAgentSkillStore({ ownedRoot: root, externalRoots: async () => [] })
    expect(Object.keys(store)).toEqual(['snapshot'])
    expect(root).not.toHaveBeenCalled()
  })
})

// Production harness check: only Electron and HTTP transport are replaced. The save-support
// module is real here; every mode has the same read-only capability.
vi.mock('electron', () => ({
  app: { getPath: () => production.home },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'fixture-native',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))
const production = vi.hoisted(() => ({ home: '' }))

describe('production read-only skill registry', () => {
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
        if (mode === 'auto') {
          const current = await import('./settingsService')
          const { AUTO_REVIEW_POLICY_REVISION } = await import('../../shared/agentAutoReview')
          current.setSettings({ ...current.getSettings(), ...settings })
          await agent.enrollAgentAutoReview(session.id, {
            policyRevision: AUTO_REVIEW_POLICY_REVISION,
            provider: 'openai',
            accountRevision: current.getSettings().agentDecisionAccountRevision!
          })
        } else await agent.updateAgentSession(session.id, { mode }, 'openai')
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
