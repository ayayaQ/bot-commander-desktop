import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type ViteDevServer } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { createAgentRunMetrics } from '../../../shared/agentRunMetrics'
import type { AgentRunMetrics } from '../../../shared/agentTypes'

let vite: ViteDevServer
let Summary: typeof import('./AgentRunSummary.svelte').default
let render: typeof import('svelte/server').render

beforeAll(async () => {
  vite = await createServer({
    configFile: false,
    plugins: [svelte()],
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, exclude: ['svelte'] },
    logLevel: 'silent'
  })
  Summary = (await vite.ssrLoadModule('/src/renderer/src/components/AgentRunSummary.svelte'))
    .default
  render = (await vite.ssrLoadModule('svelte/server')).render
})

afterAll(async () => {
  await vite?.close()
})

function display(metrics: AgentRunMetrics) {
  const { body } = render(Summary, { props: { metrics } })
  const compact = body.match(/<button\b[\s\S]*?<\/button>/)?.[0] || ''
  return { compact, body }
}

describe('agent run summary display', () => {
  it('shows useful recorded metrics before opening the dialog', () => {
    const { compact, body } = display({
      ...createAgentRunMetrics('run-1', '2026-10-10T00:00:00Z'),
      status: 'completed',
      finishedAt: '2026-10-10T00:00:42Z',
      totalTokens: 1540,
      usageReconciled: true,
      tools: [{ id: 'tool-1', name: 'lint_command', status: 'completed' }]
    })
    for (const text of ['Last run', 'completed', '0:42 elapsed', '1,540', '1 attempted'])
      expect(compact).toContain(text)
    expect(compact).toContain('aria-haspopup="dialog"')
    expect(body).toContain('Recorded input tokens')
    expect(body).toContain('Documentation calls')
    expect(body).toContain('Unreported cache counts are unavailable')
  })

  it('marks live checkpoints as partial in the compact view', () => {
    const { compact, body } = display(createAgentRunMetrics('run-2', '2026-10-10T00:00:00Z'))
    expect(compact).toContain('Current run')
    expect(compact).toContain('Partial usage')
    expect(body).toContain('latest recorded checkpoint')
  })

  it('preserves unavailable values and recovery caveats for older interrupted runs', () => {
    const { compact, body } = display({
      ...createAgentRunMetrics('run-3', '2026-10-10T00:00:00Z'),
      status: 'interrupted',
      startedAt: undefined,
      totalTokens: undefined,
      tools: undefined
    })
    expect(compact).toContain('interrupted')
    expect(compact).toContain('Unavailable')
    expect(compact).not.toContain('0 recorded tokens')
    expect(body).toContain('unfinished tool')
    expect(body).toContain('outcomes are unknown')
  })
})
