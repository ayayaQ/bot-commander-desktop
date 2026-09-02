import net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const mocks = vi.hoisted(() => ({
  config: { enabled: true, accessMode: 'read-only' as 'read-only' | 'read-write', port: 43721 },
  token: 'test-secret-token',
  execute: vi.fn(async (name: string, args: Record<string, unknown>) => ({ name, args }))
}))

vi.mock('electron', () => ({ app: { getVersion: () => '1.7.0' } }))

vi.mock('./mcpConfigService', () => ({
  loadMcpConfig: async () => ({ ...mocks.config }),
  getMcpConfig: () => ({ ...mocks.config }),
  updateMcpConfig: async (updates: Partial<typeof mocks.config>) => {
    Object.assign(mocks.config, updates)
    return { ...mocks.config }
  },
  ensureMcpToken: async () => mocks.token,
  getMcpToken: async () => mocks.token,
  hasMcpToken: () => true,
  isMcpSecureStorageAvailable: () => true,
  rotateMcpToken: async () => mocks.token
}))

vi.mock('./agentTools', () => ({
  agentToolDefinitions: [
    {
      type: 'function',
      function: {
        name: 'read_example',
        description: 'Read an example',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    },
    {
      type: 'function',
      function: {
        name: 'edit_example',
        description: 'Edit an example',
        parameters: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false
        }
      }
    }
  ],
  mutationToolNames: new Set(['edit_example']),
  agentToolTargetLabel: () => 'example',
  executeAgentTool: mocks.execute
}))

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

function createClient(port: number, token = mocks.token) {
  const client = new Client({ name: 'vitest-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
  })
  return { client, transport }
}

describe('mcpServerService', () => {
  beforeEach(async () => {
    mocks.config.enabled = true
    mocks.config.accessMode = 'read-only'
    mocks.config.port = await freePort()
    mocks.execute.mockClear()
  })

  afterEach(async () => {
    const service = await import('./mcpServerService')
    await service.stopMcpServer()
  })

  it('requires its bearer token and serves the live tool catalog over Streamable HTTP', async () => {
    const service = await import('./mcpServerService')
    const status = await service.startMcpServer()
    expect(status.running).toBe(true)

    const unauthorized = await fetch(status.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(unauthorized.status).toBe(401)

    const { client, transport } = createClient(mocks.config.port)
    await client.connect(transport)
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(['read_example'])
    await expect(client.callTool({ name: 'read_example', arguments: {} })).resolves.toMatchObject({
      content: [{ type: 'text' }]
    })
    expect(mocks.execute).toHaveBeenCalledWith('read_example', {}, 'mcp')
    expect(service.getMcpActivity()[0]).toMatchObject({
      tool: 'read_example',
      kind: 'read',
      status: 'success'
    })
    await client.close()
  })

  it('adds mutation tools only after the app is switched to read-write access', async () => {
    const service = await import('./mcpServerService')
    await service.startMcpServer()
    await service.updateMcpServerConfig({ accessMode: 'read-write' })

    const { client, transport } = createClient(mocks.config.port)
    await client.connect(transport)
    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(['read_example', 'edit_example'])
    await client.callTool({ name: 'edit_example', arguments: { value: 'updated' } })
    expect(mocks.execute).toHaveBeenCalledWith('edit_example', { value: 'updated' }, 'mcp')
    await client.close()
  })
})
