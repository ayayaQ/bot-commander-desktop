import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../types/types'

function legacySettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: '' as AppSettings['theme'],
    showToken: false,
    hideOutput: undefined as unknown as boolean,
    language: '' as AppSettings['language'],
    openaiApiKey: '',
    openaiModel: '',
    developerPrompt: '',
    useCustomApi: undefined as unknown as boolean,
    useLegacyInterpreter: undefined as unknown as boolean,
    agentNotificationsEnabled: undefined as unknown as boolean,
    ...overrides
  }
}

describe('settingsService', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('fills defaults for legacy settings without optional AI fields', async () => {
    const { getSettings, setSettings } = await import('./settingsService')

    setSettings(legacySettings())

    expect(getSettings()).toMatchObject({
      theme: 'light',
      showToken: false,
      hideOutput: false,
      language: 'en',
      aiProvider: 'openai',
      openaiApiKey: '',
      openrouterApiKey: '',
      spamProtectionEnabled: false,
      openaiModel: 'gpt-5.4-nano',
      selectedAiModel: 'gpt-5.4-nano',
      selectedOpenAiModel: 'gpt-5.4-nano',
      selectedOpenRouterModel: 'openai/gpt-5.4-nano',
      aiReasoningEffort: 'none',
      developerPrompt: '',
      useCustomApi: false,
      useLegacyInterpreter: false,
      agentNotificationsEnabled: true
    })
  })

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'keeps saved $chat %s intact, including unknown custom models',
    async (aiReasoningEffort) => {
      const { getSettings, setSettings } = await import('./settingsService')
      setSettings(legacySettings({ selectedAiModel: 'custom-unverified', aiReasoningEffort }))
      expect(getSettings()).toMatchObject({
        selectedAiModel: 'custom-unverified',
        aiReasoningEffort
      })
    }
  )

  it('keeps provider-specific selected model values in sync', async () => {
    const { getSettings, setSettings } = await import('./settingsService')

    setSettings(
      legacySettings({
        aiProvider: 'openrouter',
        selectedAiModel: 'anthropic/claude-test',
        selectedOpenRouterModel: 'meta/test-model',
        selectedOpenAiModel: 'gpt-4.1-mini'
      })
    )

    expect(getSettings()).toMatchObject({
      aiProvider: 'openrouter',
      selectedAiModel: 'meta/test-model',
      selectedOpenAiModel: 'gpt-4.1-mini',
      selectedOpenRouterModel: 'meta/test-model'
    })
  })

  it('discards retired command-assistant settings', async () => {
    const { getSettings, setSettings } = await import('./settingsService')
    const retiredSettings = {
      ...legacySettings(),
      selectedCommandOpenAiModel: 'gpt-4.1-mini',
      selectedCommandOpenRouterModel: 'meta/test-model',
      disableReasoningApi: true
    } as AppSettings

    setSettings(retiredSettings)

    expect(getSettings()).not.toHaveProperty('selectedCommandOpenAiModel')
    expect(getSettings()).not.toHaveProperty('selectedCommandOpenRouterModel')
    expect(getSettings()).not.toHaveProperty('disableReasoningApi')
  })

  it('preserves the toggle and notifies runtime consumers synchronously', async () => {
    const { getSettings, setSettings, onSettingsChanged } = await import('./settingsService')
    const listener = vi.fn()
    const unsubscribe = onSettingsChanged(listener)
    setSettings(legacySettings({ spamProtectionEnabled: true }))
    expect(getSettings().spamProtectionEnabled).toBe(true)
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ spamProtectionEnabled: true }),
      expect.objectContaining({ spamProtectionEnabled: false })
    )
    setSettings({ ...getSettings(), spamProtectionEnabled: false })
    expect(getSettings().spamProtectionEnabled).toBe(false)
    unsubscribe()
    setSettings(legacySettings())
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('independent DeepSeek configuration and credential revisions', () => {
  it('keeps web disabled and saved secrets private without inferring key reuse', async () => {
    vi.resetModules()
    const service = await import('./settingsService')
    service.setSettings(legacySettings({ aiProvider: 'deepseek', deepseekApiKey: 'chat-only' }))
    expect(service.getSettings()).toMatchObject({
      webProvider: 'disabled',
      deepseekWebKeySource: 'separate',
      deepseekWebApiKey: '',
      selectedAiModel: 'deepseek-flash'
    })
    expect(service.publicSettings()).not.toHaveProperty('deepseekApiKey')
    expect(service.publicSettings()).toMatchObject({
      deepseekKeyConfigured: true,
      deepseekWebKeyConfigured: false,
      deepseekChatAccountRevision: expect.any(String)
    })
  })
  it('rotates only relevant account revisions and preserves explicit reviewer across chat switches', async () => {
    vi.resetModules()
    const service = await import('./settingsService')
    service.setSettings(
      legacySettings({
        aiProvider: 'deepseek',
        agentReviewerProvider: 'openai',
        openaiApiKey: 'reviewer',
        deepseekApiKey: 'chat',
        webProvider: 'deepseek',
        deepseekWebApiKey: 'web',
        deepseekWebKeySource: 'separate'
      })
    )
    const first = service.getSettings()
    service.setSettings({ ...first, deepseekApiKey: 'new-chat' })
    const second = service.getSettings()
    expect(second.deepseekChatAccountRevision).not.toBe(first.deepseekChatAccountRevision)
    expect(second.agentDecisionAccountRevision).toBe(first.agentDecisionAccountRevision)
    expect(second.agentWebAccountRevision).toBe(first.agentWebAccountRevision)
    service.setSettings({ ...second, deepseekWebKeySource: 'chat' })
    const reuse = service.getSettings()
    expect(reuse.agentWebAccountRevision).not.toBe(second.agentWebAccountRevision)
    service.setSettings({ ...reuse, deepseekApiKey: '' })
    expect(service.getSettings().agentWebAccountRevision).not.toBe(reuse.agentWebAccountRevision)
    expect(service.publicSettings().deepseekKeyConfigured).toBe(false)
    service.setSettings({
      ...service.getSettings(),
      agentReviewerProvider: 'openrouter',
      openrouterApiKey: 'reviewer2'
    })
    expect(service.getSettings().agentDecisionAccountRevision).not.toBe(
      first.agentDecisionAccountRevision
    )
    const reviewer = service.getSettings().agentDecisionAccountRevision
    service.setSettings({ ...service.getSettings(), aiProvider: 'openai' })
    expect(service.getSettings().agentDecisionAccountRevision).toBe(reviewer)
  })
})

it('rotates the web write nonce for separate-key replacement/removal even while chat-key reuse is selected', async () => {
  vi.resetModules()
  const service = await import('./settingsService')
  service.setSettings(
    legacySettings({
      aiProvider: 'deepseek',
      deepseekApiKey: 'chat',
      webProvider: 'deepseek',
      deepseekWebKeySource: 'chat',
      deepseekWebApiKey: 'stored-old'
    })
  )
  const old = service.getSettings().agentWebAccountRevision
  service.setSettings({ ...service.getSettings(), deepseekWebApiKey: 'stored-new' })
  const replaced = service.getSettings().agentWebAccountRevision
  expect(replaced).not.toBe(old)
  service.setSettings({ ...service.getSettings(), deepseekWebApiKey: '' })
  expect(service.getSettings().agentWebAccountRevision).not.toBe(replaced)
  expect(service.publicSettings().deepseekWebKeyConfigured).toBe(false)
})

it('initializes fresh public nonces before the first key write and preserves explicit startup hydration', async () => {
  vi.resetModules()
  let service = await import('./settingsService')
  const fresh = service.publicSettings()
  expect(fresh.agentWebAccountRevision).toMatch(/^[a-f0-9-]{36}$/)
  expect(fresh.deepseekChatAccountRevision).toMatch(/^[a-f0-9-]{36}$/)
  service.setSettings({ ...service.getSettings(), deepseekApiKey: 'first-chat-fixture' })
  expect(service.getSettings().deepseekChatAccountRevision).not.toBe(
    fresh.deepseekChatAccountRevision
  )
  const persisted = service.getSettings()
  vi.resetModules()
  service = await import('./settingsService')
  service.setSettings(service.normalizeSettings({ ...persisted }))
  expect(service.getSettings().deepseekChatAccountRevision).toBe(
    persisted.deepseekChatAccountRevision
  )
  expect(service.getSettings().agentWebAccountRevision).toBe(persisted.agentWebAccountRevision)
})

describe('legacy provider write-only boundary', () => {
  it('omits every saved key from public snapshots and uses independent opaque revisions', async () => {
    vi.resetModules()
    const service = await import('./settingsService')
    service.setSettings(
      legacySettings({
        openaiApiKey: 'fake-openai-only',
        openrouterApiKey: 'fake-router-only',
        deepseekApiKey: 'fake-chat-only',
        deepseekWebApiKey: 'fake-web-only'
      })
    )
    const first = service.publicSettings()
    expect(first).toMatchObject({ openaiKeyConfigured: true, openrouterKeyConfigured: true })
    for (const name of ['openaiApiKey', 'openrouterApiKey', 'deepseekApiKey', 'deepseekWebApiKey'])
      expect(first).not.toHaveProperty(name)
    expect(JSON.stringify(first)).not.toContain('fake-')
    for (const provider of ['openai', 'openrouter'] as const)
      expect(first[`${provider}AccountRevision`]).toMatch(/^[a-f0-9-]{36}$/)
    service.setSettings({ ...service.getSettings(), openrouterApiKey: 'fake-router-replaced' })
    const second = service.publicSettings()
    expect(second.openaiAccountRevision).toBe(first.openaiAccountRevision)
    expect(second.openrouterAccountRevision).not.toBe(first.openrouterAccountRevision)
    // Changing a non-reviewer account must not invalidate the active OpenAI reviewer.
    expect(second.agentDecisionAccountRevision).toBe(first.agentDecisionAccountRevision)
    service.setSettings({ ...service.getSettings(), openaiApiKey: '' })
    expect(service.publicSettings().openaiKeyConfigured).toBe(false)
    expect(service.publicSettings().agentDecisionAccountRevision).not.toBe(
      first.agentDecisionAccountRevision
    )
  })

  it.each(['openaiApiKey', 'openrouterApiKey', 'deepseekApiKey', 'deepseekWebApiKey'] as const)(
    'keeps all live keys/nonces/generation on failed %s writes and commits exact persisted revisions on retry',
    async (key) => {
      vi.resetModules()
      const service = await import('./settingsService')
      service.setSettings(
        legacySettings({ openaiApiKey: 'fake-original', agentReviewerProvider: 'openai' })
      )
      const first = service.getSettings()
      const publicBefore = service.publicSettings()
      const generation = service.getAgentDecisionSettingsGeneration()
      const changed = vi.fn()
      service.onSettingsChanged(changed)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const persist = vi.fn().mockRejectedValueOnce(new Error('fake-replacement-secret'))
      await expect(
        service.persistSettingsUpdate({ ...first, [key]: 'fake-replacement-secret' }, persist)
      ).rejects.toThrow('existing keys remain active')
      expect(service.getSettings()).toEqual(first)
      expect(service.publicSettings()).toEqual(publicBefore)
      expect(service.getAgentDecisionSettingsGeneration()).toBe(generation)
      expect(changed).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
      log.mockRestore()
      // An unrelated normalization after rollback must not advance any account nonce.
      service.setSettings({ ...first, theme: 'dark' })
      expect(service.publicSettings()).toEqual({ ...publicBefore, theme: 'dark' })
      persist.mockResolvedValueOnce(undefined)
      await service.persistSettingsUpdate(
        { ...service.getSettings(), [key]: 'fake-replacement-secret' },
        persist
      )
      expect(service.getSettings()).toEqual(persist.mock.calls[1][0])
      expect(service.getSettings()[key]).toBe('fake-replacement-secret')
      expect(JSON.stringify(service.publicSettings())).not.toContain('fake-replacement-secret')
    }
  )

  it('does not accept renderer-chosen initial legacy account revisions on a first ordinary save', async () => {
    vi.resetModules()
    const service = await import('./settingsService')
    const forged = '11111111-1111-1111-1111-111111111111'
    await service.persistSettingsUpdate(
      {
        ...service.getSettings(),
        openaiAccountRevision: forged,
        openrouterAccountRevision: forged
      },
      async () => {}
    )
    expect(service.publicSettings().openaiAccountRevision).not.toBe(forged)
    expect(service.publicSettings().openrouterAccountRevision).not.toBe(forged)
  })

  it('retains both legacy account nonces through startup hydration and unrelated saves', async () => {
    vi.resetModules()
    let service = await import('./settingsService')
    service.setSettings(legacySettings({ openaiApiKey: 'fake-a', openrouterApiKey: 'fake-b' }))
    const persisted = service.getSettings()
    vi.resetModules()
    service = await import('./settingsService')
    service.setSettings(service.normalizeSettings({ ...persisted }))
    service.setSettings({
      ...service.getSettings(),
      theme: 'dark',
      openaiAccountRevision: 'forged'
    })
    expect(service.getSettings().openaiAccountRevision).toBe(persisted.openaiAccountRevision)
    expect(service.getSettings().openrouterAccountRevision).toBe(
      persisted.openrouterAccountRevision
    )
  })
})
