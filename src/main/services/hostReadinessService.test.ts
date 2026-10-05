import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPublicationState } from '../../shared/interactionPublication'

const host = vi.hoisted(() => ({
  connection: vi.fn(),
  commands: vi.fn(),
  interactions: vi.fn(),
  publication: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  publish: vi.fn(),
  backend: vi.fn(),
  loadSettings: vi.fn(),
  settings: vi.fn(),
  credentials: vi.fn(),
  save: vi.fn(),
  virtual: vi.fn(),
  cookie: vi.fn()
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
vi.mock('./interactionPublicationService', () => ({
  getInteractionPublicationObservation: host.publication,
  interactionPublisher: { publish: host.publish }
}))
vi.mock('./slashCommandRegistry', () => ({ createInteractionPublishBackend: host.backend }))
vi.mock('./fileService', () => ({
  saveCommands: host.save,
  saveInteractions: host.save,
  saveSettings: host.save,
  loadSettings: host.loadSettings
}))
vi.mock('./settingsService', () => ({ getSettings: host.settings, setSettings: host.save }))
vi.mock('../utils/virtual', () => ({
  readBotState: host.virtual,
  getStartupJs: host.virtual,
  updateStartupJsAndRestart: host.virtual,
  withBotStateTransaction: host.virtual
}))
vi.mock('electron', () => ({
  app: { getPath: host.credentials },
  safeStorage: { decryptString: host.credentials },
  session: { defaultSession: { cookies: { get: host.cookie, set: host.cookie } } }
}))

const sensitive =
  'private-secret username guild-id https://user:password@example.test/?token=secret'

beforeEach(() => {
  vi.clearAllMocks()
  host.connection.mockReturnValue({
    attempt: 'ready',
    failure: null,
    observedAt: 1_000,
    servingReady: true,
    gatewayReady: true,
    guildCount: 2
  })
  host.commands.mockReturnValue({ bcfdCommands: [{ id: sensitive, command: sensitive }] })
  host.interactions.mockReturnValue([{ id: sensitive, commandName: sensitive, isRegistered: true }])
  host.publication.mockReturnValue({ state: emptyPublicationState(), observedAt: null })
})

describe('agent-only host readiness read boundary', () => {
  it('uses cached aggregate getters only and makes no credential/action/network calls', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Network is forbidden')
    })
    vi.stubGlobal('fetch', fetch)
    try {
      const { readHostStatus } = await import('./hostReadinessService')
      const result = readHostStatus()
      expect(result).toMatchObject({
        status: 'available',
        connection: { state: 'ready' },
        resources: { commandCount: 1, interactionCount: 1 },
        publication: {
          state: 'not-observed',
          localRegisteredCount: 1,
          remoteRegistration: 'unknown'
        }
      })
      expect(JSON.stringify(result)).not.toContain(sensitive)
      for (const call of [
        host.connect,
        host.disconnect,
        host.publish,
        host.backend,
        host.loadSettings,
        host.settings,
        host.credentials,
        host.save,
        host.virtual,
        host.cookie,
        fetch
      ])
        expect(call).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each(['connection', 'commands', 'interactions', 'publication'] as const)(
    'contains secret-bearing %s getter failures locally',
    async (name) => {
      host[name].mockImplementationOnce(() => {
        throw new Error(sensitive)
      })
      const { readHostStatus } = await import('./hostReadinessService')
      const result = readHostStatus()
      expect(result.status).toBe('status-unavailable')
      expect(result.login.state).toBe('unknown')
      expect(JSON.stringify(result)).not.toContain(sensitive)
    }
  )

  it('is an empty-schema read tool with no mutation policy and an explicit agent-only boundary', async () => {
    const {
      agentToolDefinitions,
      agentOnlyToolNames,
      mutationToolNames,
      executeReadTool,
      executeAgentTool
    } = await import('./agentTools')
    expect(
      agentToolDefinitions.find((item) => item.function.name === 'read_host_status')!.function
        .parameters
    ).toEqual({ type: 'object', properties: {}, required: [], additionalProperties: false })
    expect(mutationToolNames.has('read_host_status')).toBe(false)
    expect(agentOnlyToolNames.has('read_host_status')).toBe(true)
    await expect(executeReadTool('read_host_status', {})).resolves.toMatchObject({
      status: 'available'
    })
    await expect(executeReadTool('read_host_status', { token: sensitive })).resolves.toEqual({
      success: false,
      error: 'read_host_status accepts no arguments'
    })
    host.connection.mockClear()
    await expect(executeAgentTool('read_host_status', {}, 'mcp')).resolves.toEqual({
      success: false,
      error: 'Tool is available only to the desktop agent'
    })
    expect(host.connection).not.toHaveBeenCalled()
    expect(host.save).not.toHaveBeenCalled()
  })
})
