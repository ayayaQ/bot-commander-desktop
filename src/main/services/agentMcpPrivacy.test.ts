import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/unused-offline-privacy-state' } }))
const credential = 'synthetic-known-only-main-secret'
const encoded = (text: string) =>
  [...Buffer.from(text)].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')

describe('main-only MCP known credential privacy', () => {
  let privacy: typeof import('./agentDecisionPrivacy')
  let service: import('./agentMcpService').AgentMcpService
  beforeEach(async () => {
    vi.resetModules()
    privacy = await import('./agentDecisionPrivacy')
    privacy.registerAgentDecisionSecret(credential)
    const { AgentMcpService } = await import('./agentMcpService')
    const { McpConfigStore } = await import('./agentMcpConfig')
    service = new AgentMcpService({ store: new McpConfigStore('/unused-offline-private'), env: {} })
  })
  for (const suffix of ['', '%FF', '%C0%AF', '%E2%28%A1', '%broken'])
    it(`rejects a main-registered encoded credential beside malformed bytes (${suffix || 'valid'})`, () => {
      const value = { query: encoded(credential) + suffix }
      expect(() => privacy.assertAgentMcpPrivacy(value)).toThrow('known credential')
      expect(() => service.assertAllowed(value)).toThrow('known credential')
    })
  it('compares the final32-pass decoded form in the actual service default policy', () => {
    let value = encoded(credential)
    for (let pass = 1; pass < 32; pass++) value = encodeURIComponent(value)
    expect(() => privacy.assertAgentMcpPrivacy({ query: value })).toThrow('known credential')
    expect(() => service.assertAllowed({ query: value })).toThrow('known credential')
  })
  it('allows benign Unicode and malformed escapes without invoking an Auto classifier', () => {
    expect(() =>
      service.assertAllowed({ query: 'Ordinary café metadata %FF %broken' })
    ).not.toThrow()
  })
})
