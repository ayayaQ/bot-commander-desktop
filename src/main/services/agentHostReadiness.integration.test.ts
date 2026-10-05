import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AgentSession, AgentStreamEvent } from '../../shared/agentTypes'

// Real host read tool, projection, core agent, provider adapter and recoverable persistence.
// Only domain caches and transport are fixtures; no Electron UI or live hosting is launched.
const host = vi.hoisted(() => ({
  directory: '',
  connection: vi.fn(),
  commands: vi.fn(),
  interactions: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  backend: vi.fn(),
  loadCredentials: vi.fn(),
  save: vi.fn(),
  virtual: vi.fn(),
  cookie: vi.fn(),
  settings: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => host.directory },
  safeStorage: { decryptString: host.loadCredentials },
  session: { defaultSession: { cookies: { get: host.cookie, set: host.cookie } } }
}))
vi.mock('./botService', () => ({
  getHostConnectionObservation: host.connection,
  getCommands: host.commands,
  setCommands: host.save,
  Connect: host.connect,
  Disconnect: host.disconnect
}))
vi.mock('./interactionService', () => ({
  getInteractions: host.interactions,
  setInteractions: host.save
}))
vi.mock('./slashCommandRegistry', () => ({ createInteractionPublishBackend: host.backend }))
vi.mock('./settingsService', () => ({
  getSettings: host.settings,
  setSettings: host.save,
  onSettingsChanged: () => () => {}
}))
vi.mock('./fileService', () => ({
  saveCommands: host.save,
  saveInteractions: host.save,
  saveSettings: host.save,
  loadSettings: host.loadCredentials
}))
vi.mock('../utils/virtual', () => ({
  readBotState: host.virtual,
  getStartupJs: host.virtual,
  updateStartupJsAndRestart: host.virtual,
  withBotStateTransaction: host.virtual
}))

const secret = 'PRIVATE-host-secret https://username:password@example.test/?token=PRIVATE'
const settings = { aiProvider: 'openai' as const, openaiApiKey: 'fake-provider-fixture-key' }
const fetchMock = vi.fn<typeof fetch>()

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  host.directory = await fs.mkdtemp(join(tmpdir(), 'agent-host-readiness-'))
  host.connection.mockReturnValue({
    attempt: 'never-attempted',
    failure: null,
    observedAt: null,
    servingReady: false,
    gatewayReady: false,
    guildCount: null
  })
  host.commands.mockReturnValue({ bcfdCommands: [{ id: secret, command: secret }] })
  host.interactions.mockReturnValue([{ id: secret, commandName: secret, isRegistered: true }])
  host.settings.mockReturnValue({})
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(host.directory, { recursive: true, force: true })
})

describe('persisted agent-only hosting guidance', () => {
  it.each([
    ['manual', false],
    ['auto', false],
    ['planning', false],
    ['manual', true],
    ['auto', true],
    ['planning', true]
  ] as const)(
    'reads safely in %s mode with unavailable=%s without approval or hosting actions',
    async (mode, unavailable) => {
      if (unavailable)
        host.connection.mockImplementationOnce(() => {
          throw new Error(secret)
        })
      const requests: Record<string, unknown>[] = []
      let safeResult!: ReturnType<typeof import('./hostReadinessService').readHostStatus>
      let guidance!: string
      fetchMock.mockImplementation(async (url, init) => {
        if (String(url) !== 'https://api.openai.com/v1/responses')
          throw new Error('Unexpected fixture transport target')
        const request = JSON.parse(init!.body as string)
        requests.push(request)
        expect(request.tools).toContainEqual(
          expect.objectContaining({
            name: 'read_host_status',
            parameters: {
              type: 'object',
              properties: {},
              required: [],
              additionalProperties: false
            }
          })
        )
        let response: Record<string, unknown>
        if (requests.length === 1) {
          response = {
            status: 'completed',
            output_text: '',
            output: [
              {
                type: 'function_call',
                call_id: 'read-host-call',
                name: 'read_host_status',
                arguments: '{}'
              }
            ]
          }
        } else if (requests.length === 2) {
          const toolOutput = request.input.find(
            (item: { type: string }) => item.type === 'function_call_output'
          )
          safeResult = JSON.parse(toolOutput.output)
          guidance = safeResult.nextActions[0].guidance
          expect(JSON.stringify(safeResult)).not.toContain(secret)
          response = {
            status: 'completed',
            output_text:
              mode === 'planning' ? `<proposed_plan>${guidance}</proposed_plan>` : guidance,
            output: []
          }
        } else throw new Error('Unexpected extra provider round')
        return new Response(
          'data: ' + JSON.stringify({ type: 'response.completed', response }) + '\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      })
      const service = await import('./agentService')
      const session = await service.createAgentSession(settings)
      await service.updateAgentSession(session.id, { mode }, 'openai')
      const events: AgentStreamEvent[] = []
      const done = new Promise<AgentSession>((resolve) =>
        service.setAgentEventSink((event) => {
          events.push(event)
          if (event.type === 'done' || event.type === 'error') resolve(event.session!)
        })
      )
      await service.runAgentSession(
        session.id,
        'Explain whether this host is ready and what I should do next',
        settings
      )
      const completed = await done
      expect(completed.status).toBe('completed')
      expect(events.some((event) => event.type === 'approval')).toBe(false)
      expect(requests).toHaveLength(2)
      expect(safeResult.status).toBe(unavailable ? 'status-unavailable' : 'available')
      expect(safeResult.publication.remoteRegistration).toBe('unknown')
      const tool = completed.messages.find((message) => message.role === 'tool')!
      expect(tool.content).toBe(JSON.stringify(safeResult))
      expect(tool.toolCalls![0]).toMatchObject({
        name: 'read_host_status',
        status: 'completed',
        result: safeResult
      })
      expect(completed.history!.find((message) => message.kind === 'tool_result')).toMatchObject({
        name: 'read_host_status',
        content: JSON.stringify(safeResult),
        isError: false
      })
      expect(
        completed.messages.filter((message) => message.role === 'assistant').at(-1)!.content
      ).toContain(guidance)
      const disk = await fs.readFile(join(host.directory, 'agent-sessions.json'), 'utf8')
      expect(disk).not.toContain(secret)
      vi.resetModules()
      const reloaded = await import('./agentService')
      const stored = (await reloaded.loadAgentSessions()).sessions.find(
        (item) => item.id === session.id
      )!
      expect(stored.history).toEqual(completed.history)
      expect(stored.messages.find((message) => message.role === 'tool')).toEqual(tool)
      for (const action of [
        host.connect,
        host.disconnect,
        host.backend,
        host.loadCredentials,
        host.save,
        host.virtual,
        host.cookie,
        host.settings
      ])
        expect(action).not.toHaveBeenCalled()
    }
  )
})
