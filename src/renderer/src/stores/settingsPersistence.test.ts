import { describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { createSettingsPersistence } from './settingsPersistence'
import type { AppSettings } from '../types/types'

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    theme: 'light',
    showToken: false,
    hideOutput: false,
    language: 'en',
    aiProvider: 'openai',
    openaiApiKey: '',
    openrouterApiKey: '',
    selectedAiModel: 'gpt-5.4-nano',
    selectedOpenAiModel: 'gpt-5.4-nano',
    selectedOpenRouterModel: 'openai/gpt-5.4-nano',
    aiReasoningEffort: 'none',
    openaiModel: 'gpt-5.4-nano',
    developerPrompt: '',
    useCustomApi: false,
    useLegacyInterpreter: false,
    agentNotificationsEnabled: true,
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('settings persistence model', () => {
  it('retains failed edits for retry without committing live settings or effects', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockImplementationOnce(async (value) => value)
    const onCommitted = vi.fn()
    const model = createSettingsPersistence(settings(), persist, onCommitted)

    expect(await model.patch({ theme: 'dark', language: 'ja', developerPrompt: 'draft' })).toBe(
      false
    )
    expect(get(model.committed)).toEqual(settings())
    expect(onCommitted).not.toHaveBeenCalled()
    expect(get(model.draft)).toMatchObject({
      theme: 'dark',
      language: 'ja',
      developerPrompt: 'draft'
    })
    expect(get(model.status)).toEqual({ saving: false, unsaved: true, error: 'Disk full' })

    expect(await model.retry()).toBe(true)
    expect(persist.mock.calls[1][0]).toEqual(persist.mock.calls[0][0])
    expect(get(model.committed)).toEqual(get(model.draft))
    expect(get(model.status)).toEqual({ saving: false, unsaved: false, error: '' })
    expect(onCommitted).toHaveBeenCalledTimes(1)
  })

  it('serializes rapid edits and keeps later input visible while an older save finishes', async () => {
    const first = deferred<AppSettings>()
    const second = deferred<AppSettings>()
    const persist = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const model = createSettingsPersistence(settings(), persist)

    const saving = model.patch({ theme: 'dark' })
    await Promise.resolve()
    model.patch({ developerPrompt: 'latest draft' })
    model.patch({ hideOutput: true })
    expect(persist).toHaveBeenCalledTimes(1)
    expect(get(model.committed).theme).toBe('light')
    first.resolve(settings({ theme: 'dark' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(persist).toHaveBeenCalledTimes(2)
    expect(get(model.committed).developerPrompt).toBe('')
    expect(get(model.draft).developerPrompt).toBe('latest draft')
    expect(persist.mock.calls[1][0]).toMatchObject({
      theme: 'dark',
      hideOutput: true,
      developerPrompt: 'latest draft'
    })
    second.resolve(persist.mock.calls[1][0])
    expect(await saving).toBe(true)
    expect(get(model.committed)).toEqual(get(model.draft))
  })

  it('retries the latest draft when edits arrive during a failing request', async () => {
    const first = deferred<AppSettings>()
    const persist = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockImplementationOnce(async (value) => value)
    const model = createSettingsPersistence(settings(), persist)
    const saving = model.patch({ openaiApiKey: 'example key' })
    await Promise.resolve()
    model.patch({ developerPrompt: 'Keep this text' })
    first.reject(new Error('Unavailable'))
    expect(await saving).toBe(false)
    expect(await model.retry()).toBe(true)
    expect(get(model.committed)).toMatchObject({
      openaiApiKey: 'example key',
      developerPrompt: 'Keep this text'
    })
  })

  it('does not erase failed drafts on an external reload or mutate retry snapshots', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('Failed'))
      .mockImplementationOnce(async (value) => value)
    const model = createSettingsPersistence(settings(), persist)
    const input = settings({ developerPrompt: 'Preserved' })
    await model.save(input)
    input.developerPrompt = 'Mutated caller'
    model.setLoaded(settings({ theme: 'dark' }))
    expect(get(model.committed).theme).toBe('dark')
    expect(get(model.draft).developerPrompt).toBe('Preserved')
    await model.retry()
    expect(persist.mock.calls[1][0].developerPrompt).toBe('Preserved')
  })

  it('contains synchronous transport errors and allows a subsequent retry', async () => {
    const persist = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Bridge unavailable')
      })
      .mockImplementationOnce(async (value) => value)
    const model = createSettingsPersistence(settings(), persist)
    expect(await model.patch({ hideOutput: true })).toBe(false)
    expect(await model.retry()).toBe(true)
    expect(get(model.committed).hideOutput).toBe(true)
  })

  it('uses the normalized disk-confirmed response and rejects unconfirmed responses', async () => {
    const persist = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(settings({ theme: 'dark', selectedAiModel: 'normalized' }))
    const model = createSettingsPersistence(settings(), persist)
    expect(await model.patch({ theme: 'dark' })).toBe(false)
    expect(get(model.committed).theme).toBe('light')
    expect(await model.retry()).toBe(true)
    expect(get(model.draft).selectedAiModel).toBe('normalized')
  })
})

describe('settings external-change rebasing', () => {
  it('retries local edits without reverting unrelated confirmed external changes', async () => {
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error('Disk full'))
      .mockImplementation(async (value) => value)
    const model = createSettingsPersistence(settings(), persist)
    await model.patch({ developerPrompt: 'Local edit' })
    model.setLoaded(settings({ theme: 'dark', hideOutput: true }))
    expect(get(model.draft)).toMatchObject({
      developerPrompt: 'Local edit',
      theme: 'dark',
      hideOutput: true
    })
    model.setLoaded(settings({ theme: 'dark', hideOutput: true, language: 'ja' }))
    expect(await model.retry()).toBe(true)
    expect(get(model.committed)).toMatchObject({
      developerPrompt: 'Local edit',
      theme: 'dark',
      hideOutput: true,
      language: 'ja'
    })
  })

  it('rebases an in-flight snapshot before the next serialized save', async () => {
    const waiting = deferred<AppSettings>()
    const persist = vi
      .fn()
      .mockImplementationOnce(() => waiting.promise)
      .mockImplementation(async (value) => value)
    const model = createSettingsPersistence(settings(), persist)
    const saving = model.patch({ developerPrompt: 'Local edit' })
    await Promise.resolve()
    model.setLoaded(settings({ theme: 'dark' }))
    void model.patch({ hideOutput: true })
    waiting.resolve(settings({ developerPrompt: 'Local edit' }))
    expect(await saving).toBe(true)
    expect(persist).toHaveBeenCalledTimes(2)
    expect(get(model.committed)).toMatchObject({
      developerPrompt: 'Local edit',
      theme: 'dark',
      hideOutput: true
    })
  })
})

describe('settings refresh ordering and effects', () => {
  it('keeps a confirmed newer save when an earlier load returns stale settings', async () => {
    const reading = deferred<AppSettings>()
    const model = createSettingsPersistence(settings(), async (value) => value)
    const loading = model.load(() => reading.promise)
    await model.patch({ theme: 'dark' })
    reading.resolve(settings())
    expect(await loading).toBe(false)
    expect(get(model.committed).theme).toBe('dark')
    expect(get(model.draft).theme).toBe('dark')
  })

  it('keeps failed drafts and error feedback when an external refresh completes', async () => {
    const model = createSettingsPersistence(settings(), async () => {
      throw new Error('Disk full')
    })
    await model.patch({ developerPrompt: 'Preserved draft' })
    expect(await model.load(async () => settings({ hideOutput: true }))).toBe(true)
    expect(get(model.draft).developerPrompt).toBe('Preserved draft')
    expect(get(model.committed).hideOutput).toBe(true)
    expect(get(model.status)).toEqual({ saving: false, unsaved: true, error: 'Disk full' })
  })

  it('does not report disk failure when a post-commit renderer effect throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const model = createSettingsPersistence(
        settings(),
        async (value) => value,
        () => {
          throw new Error('Effect failed')
        }
      )
      expect(await model.patch({ theme: 'dark' })).toBe(true)
      expect(get(model.committed).theme).toBe('dark')
      expect(get(model.status)).toEqual({ saving: false, unsaved: false, error: '' })
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })
})
