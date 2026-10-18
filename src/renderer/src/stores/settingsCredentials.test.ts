import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { get } from 'svelte/store'

describe('DeepSeek narrow credential IPC boundary', () => {
  let settings: typeof import('./settings')
  let invoke: Mock<(channel: string, ...args: unknown[]) => Promise<unknown>>
  let chatRevision: string
  let webRevision: string
  let chatConfigured: boolean
  let webConfigured: boolean

  beforeEach(async () => {
    vi.resetModules()
    chatRevision = 'chat-account-fixture-1'
    webRevision = 'web-account-fixture-1'
    chatConfigured = false
    webConfigured = false
    invoke = vi.fn(async (channel, ...args) => {
      if (channel === 'save-deepseek-key') {
        const request = args[0] as { purpose: 'chat' | 'web'; value: string }
        if (request.purpose === 'chat') {
          chatConfigured = Boolean(request.value)
          chatRevision = 'chat-account-fixture-2'
        } else {
          webConfigured = Boolean(request.value)
          webRevision = 'web-account-fixture-2'
        }
        return { deepseekKeyConfigured: chatConfigured, deepseekWebKeyConfigured: webConfigured }
      }
      const result = {
        theme: 'light',
        language: 'en',
        aiProvider: 'deepseek',
        openaiApiKey: '',
        deepseekKeyConfigured: chatConfigured,
        deepseekWebKeyConfigured: webConfigured,
        deepseekChatAccountRevision: chatRevision,
        agentWebAccountRevision: webRevision
      }
      return channel === 'save-settings' ? { ...(args[0] as object), ...result } : result
    })
    vi.stubGlobal('window', {
      electron: { ipcRenderer: { invoke, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }
    })
    settings = await import('./settings')
    await settings.loadSettings()
  })

  afterEach(() => vi.unstubAllGlobals())

  function expectCredentialFree() {
    for (const store of [settings.settingsStore, settings.settingsDraftStore]) {
      expect(get(store)).not.toHaveProperty('deepseekApiKey')
      expect(get(store)).not.toHaveProperty('deepseekWebApiKey')
      expect(JSON.stringify(get(store))).not.toContain('transient-secret-fixture')
    }
  }

  it('saves a chat key only through narrow IPC with the exact host revision', async () => {
    const pending = settings.saveDeepSeekKey('chat', 'transient-secret-fixture')
    expectCredentialFree()
    await pending
    expect(invoke).toHaveBeenCalledWith('save-deepseek-key', {
      purpose: 'chat',
      value: 'transient-secret-fixture',
      expectedRevision: 'chat-account-fixture-1'
    })
    expect(get(settings.settingsStore)).toMatchObject({
      deepseekKeyConfigured: true,
      deepseekChatAccountRevision: 'chat-account-fixture-2'
    })
    expect(invoke.mock.calls.some(([channel]) => channel === 'save-settings')).toBe(false)
    expectCredentialFree()
  })

  it('clears the separate web key independently with its web-account revision', async () => {
    await settings.saveDeepSeekKey('web', '')
    expect(invoke).toHaveBeenCalledWith('save-deepseek-key', {
      purpose: 'web',
      value: '',
      expectedRevision: 'web-account-fixture-1'
    })
    expect(get(settings.settingsStore)).toMatchObject({
      deepseekWebKeyConfigured: false,
      agentWebAccountRevision: 'web-account-fixture-2',
      deepseekChatAccountRevision: 'chat-account-fixture-1'
    })
    expectCredentialFree()
  })

  it('retains credential-free settings after a rejected or stale key save', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'save-deepseek-key') throw new Error('Credential account changed')
      return original(channel, ...args)
    })
    await expect(settings.saveDeepSeekKey('chat', 'transient-secret-fixture')).rejects.toThrow(
      'changed'
    )
    expect(get(settings.settingsStore).deepseekKeyConfigured).toBe(false)
    expectCredentialFree()
  })

  it('requires the appropriate loaded revision before sending a key', async () => {
    chatRevision = ''
    await settings.loadSettings()
    await expect(settings.saveDeepSeekKey('chat', 'transient-secret-fixture')).rejects.toThrow(
      'settings to load'
    )
    expect(invoke.mock.calls.some(([channel]) => channel === 'save-deepseek-key')).toBe(false)
    expectCredentialFree()
  })

  it('preserves failed ordinary-save reporting when the host returns no settings', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) =>
      channel === 'save-settings' ? null : original(channel, ...args)
    )
    expect(await settings.patchSettings({ theme: 'dark' })).toBe(false)
    expect(get(settings.settingsSaveStatus).error).toContain('not confirmed')
    expect(get(settings.settingsStore).theme).toBe('light')
    expectCredentialFree()
  })

  it('does not admit mixed-version or forged key fields through ordinary settings reads or saves', async () => {
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation(async (channel, ...args) => ({
      ...((await original(channel, ...args)) as object),
      deepseekApiKey: 'transient-secret-fixture',
      deepseekWebApiKey: 'transient-secret-fixture'
    }))
    await settings.loadSettings()
    expectCredentialFree()
    await settings.patchSettings({ deepseekApiKey: 'transient-secret-fixture' } as never)
    expectCredentialFree()
    const sent = invoke.mock.calls.find(([channel]) => channel === 'save-settings')![1]
    expect(sent).not.toHaveProperty('deepseekApiKey')
    expect(sent).not.toHaveProperty('deepseekWebApiKey')
  })
})
