import { beforeEach, describe, expect, it, vi } from 'vitest'

interface FixtureBridge {
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
    send(channel: string, ...args: unknown[]): void
    on(channel: string, callback: (...args: unknown[]) => void): void
  }
}

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn()
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    removeListener: mocks.removeListener
  }
}))

async function bridge(): Promise<FixtureBridge> {
  await import('./index')
  return mocks.expose.mock.calls.find(([name]) => name === 'electron')![1]
}

describe('public agent MCP OAuth preload whitelist', () => {
  const channels = [
    'agent:compact',
    'save-deepseek-key',
    'agent-mcp:oauth-configure-client',
    'agent-mcp:oauth-prepare-registration',
    'agent-mcp:oauth-register',
    'agent-mcp:oauth-prepare-sign-in',
    'agent-mcp:oauth-sign-in',
    'agent-mcp:oauth-cancel'
  ]

  beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
  })

  it.each(channels)(
    'forwards the explicit %s invoke without exposing Electron',
    async (channel) => {
      const exposed = await bridge()
      const result = { revision: 'public-host-result', servers: [] }
      const args = ['fixture-server', { id: 'fixture-public-client' }]
      mocks.invoke.mockResolvedValueOnce(result)

      expect(await exposed.ipcRenderer.invoke(channel, ...args)).toBe(result)
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(channel, ...args)
      expect(Object.keys(exposed)).toEqual(['ipcRenderer'])
    }
  )

  it.each([
    'agent-mcp:oauth',
    'agent-mcp:oauth-get-token',
    'agent-mcp:oauth-set-token',
    'agent-mcp:oauth-bearer',
    'agent-mcp:oauth-credentials',
    'agent-mcp:oauth-browser-url',
    'agent-mcp:oauth-request'
  ])('rejects the undeclared %s invoke', async (channel) => {
    const exposed = await bridge()

    await expect(exposed.ipcRenderer.invoke(channel, 'fixture')).rejects.toThrow(
      `Invalid invoke channel: ${channel}`
    )
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('exposes OAuth actions only through invokes and uses the existing public status event', async () => {
    const exposed = await bridge()
    const receive = vi.fn()
    for (const channel of channels) {
      exposed.ipcRenderer.send(channel, 'fixture')
      exposed.ipcRenderer.on(channel, receive)
    }
    exposed.ipcRenderer.on('agent-mcp:oauth-status', receive)
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.on).not.toHaveBeenCalled()

    exposed.ipcRenderer.on('agent-mcp:status', receive)
    expect(mocks.on).toHaveBeenCalledExactlyOnceWith('agent-mcp:status', expect.any(Function))
    const status = {
      servers: [
        {
          id: 'fixture',
          oauth: { state: 'configured', hasClient: true, revision: 'public-status-revision' }
        }
      ]
    }
    mocks.on.mock.calls[0][1]({ sender: 'privileged-fixture-event' }, status)
    expect(receive).toHaveBeenCalledExactlyOnceWith(status)
  })

  it('preserves the separate external MCP server channel', async () => {
    const exposed = await bridge()
    mocks.invoke.mockResolvedValueOnce(true)

    expect(await exposed.ipcRenderer.invoke('mcp:copy-token')).toBe(true)
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('mcp:copy-token')
  })
})
