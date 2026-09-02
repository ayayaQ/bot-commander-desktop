import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  files: new Map<string, string>(),
  encryptionAvailable: true
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/user-data' },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    getSelectedStorageBackend: () => 'kwallet6',
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`),
    decryptString: (value: Buffer) => value.toString().slice('encrypted:'.length)
  }
}))

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async (path: string) => {
      const value = mocks.files.get(path)
      if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return value
    }),
    writeFile: vi.fn(async (path: string, value: string) => {
      mocks.files.set(path, value)
    }),
    rename: vi.fn(async (from: string, to: string) => {
      mocks.files.set(to, mocks.files.get(from) || '')
      mocks.files.delete(from)
    })
  }
}))

describe('mcpConfigService', () => {
  beforeEach(() => {
    mocks.files.clear()
    mocks.encryptionAvailable = true
    vi.resetModules()
  })

  it('is opt-in and stores a generated token only through safeStorage encryption', async () => {
    const service = await import('./mcpConfigService')

    await expect(service.loadMcpConfig()).resolves.toEqual({
      enabled: false,
      accessMode: 'read-only',
      port: service.DEFAULT_MCP_PORT
    })
    await service.updateMcpConfig({ enabled: true })

    const token = await service.getMcpToken()
    const stored =
      [...mocks.files.entries()].find(([path]) => path.endsWith('mcp-config.json'))?.[1] || ''
    expect(token).toHaveLength(43)
    expect(stored).not.toContain(token)
    expect(JSON.parse(stored)).toMatchObject({
      enabled: true,
      accessMode: 'read-only',
      port: service.DEFAULT_MCP_PORT
    })
    expect(JSON.parse(stored).token).toMatch(/^bcfd-mcp-encrypted:v1:/)
  })

  it('refuses to enable without secure storage and rolls back the in-memory setting', async () => {
    mocks.encryptionAvailable = false
    const service = await import('./mcpConfigService')
    await service.loadMcpConfig()

    await expect(service.updateMcpConfig({ enabled: true })).rejects.toThrow('Secure credential')
    expect(service.getMcpConfig().enabled).toBe(false)
    expect([...mocks.files.keys()].some((path) => path.endsWith('mcp-config.json'))).toBe(false)
  })

  it('validates the loopback port range', async () => {
    const service = await import('./mcpConfigService')
    await service.loadMcpConfig()

    await expect(service.updateMcpConfig({ port: 80 })).rejects.toThrow('between 1024 and 65535')
    await expect(service.updateMcpConfig({ port: 65536 })).rejects.toThrow('between 1024 and 65535')
  })
})
