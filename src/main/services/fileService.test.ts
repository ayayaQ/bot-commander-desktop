import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const mocks = vi.hoisted(() => ({
  appGetPath: vi.fn(),
  getCommands: vi.fn(),
  setCommands: vi.fn(),
  getSettings: vi.fn(),
  setSettings: vi.fn(),
  getBotStatus: vi.fn(),
  setBotStatus: vi.fn(),
  getInteractions: vi.fn(),
  setInteractions: vi.fn(),
  randomUUID: vi.fn(),
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.appGetPath
  },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString
  }
}))

vi.mock('crypto', () => ({
  default: {
    randomUUID: mocks.randomUUID
  }
}))

vi.mock('./botService', () => ({
  getCommands: mocks.getCommands,
  setCommands: mocks.setCommands
}))

vi.mock('./settingsService', () => ({
  getSettings: mocks.getSettings,
  setSettings: mocks.setSettings
}))

vi.mock('./statusService', () => ({
  getBotStatus: mocks.getBotStatus,
  setBotStatus: mocks.setBotStatus
}))

vi.mock('./interactionService', () => ({
  getInteractions: mocks.getInteractions,
  setInteractions: mocks.setInteractions
}))

describe('fileService', () => {
  let userDataPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    userDataPath = await fs.mkdtemp(join(tmpdir(), 'bcfd-file-service-'))
    mocks.appGetPath.mockReturnValue(userDataPath)
    mocks.randomUUID.mockReturnValue('generated-id')
    mocks.isEncryptionAvailable.mockReturnValue(true)
    mocks.encryptString.mockImplementation((value) => Buffer.from(`encrypted:${value}`))
    mocks.decryptString.mockImplementation((value) => value.toString().replace('encrypted:', ''))
    mocks.getCommands.mockImplementation(
      () => mocks.setCommands.mock.calls.at(-1)?.[0] ?? { bcfdCommands: [], bcfdSlashCommands: [] }
    )
    mocks.getSettings.mockReturnValue({ theme: 'light' })
    mocks.getBotStatus.mockReturnValue({
      status: 'Online',
      activity: 'None',
      activityDetails: '',
      streamUrl: ''
    })
    mocks.getInteractions.mockReturnValue([])
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('propagates interaction save failures so publishing cannot report persisted success', async () => {
    const { saveInteractions } = await import('./fileService')
    // An existing directory at the file path makes the write fail on every platform.
    await fs.mkdir(join(userDataPath, 'interactions.json'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(saveInteractions()).rejects.toThrow()
    } finally {
      log.mockRestore()
    }
  })

  it('propagates command save failures without changing the in-memory commands', async () => {
    const current = { bcfdCommands: [{ id: 'existing' }], bcfdSlashCommands: [] }
    const next = { bcfdCommands: [{ id: 'new' }], bcfdSlashCommands: [] }
    mocks.getCommands.mockReturnValue(current)
    await fs.mkdir(join(userDataPath, 'commands.json'))
    const { persistCommands } = await import('./fileService')

    await expect(persistCommands(next as any)).rejects.toThrow()
    expect(mocks.setCommands).not.toHaveBeenCalled()
  })

  it('creates an empty commands file on first run', async () => {
    const { loadCommands } = await import('./fileService')

    await loadCommands()

    await expect(fs.readFile(join(userDataPath, 'commands.json'), 'utf-8')).resolves.toBe(
      '{\n  "bcfdCommands": [],\n  "bcfdSlashCommands": []\n}'
    )
    expect(mocks.setCommands).not.toHaveBeenCalled()
  })

  it('migrates legacy commands by assigning missing ids and saving once', async () => {
    const legacyCommand = {
      commandDescription: 'Legacy',
      type: 0,
      channelMessage: '',
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {}
    }
    await fs.writeFile(
      join(userDataPath, 'commands.json'),
      JSON.stringify({
        bcfdCommands: [
          { ...legacyCommand, command: '!legacy' },
          { ...legacyCommand, id: 'existing-id', command: '!newer' }
        ],
        bcfdSlashCommands: []
      })
    )
    const { loadCommands } = await import('./fileService')

    await loadCommands()

    expect(mocks.setCommands).toHaveBeenCalledWith({
      bcfdCommands: [
        expect.objectContaining({ id: 'generated-id', command: '!legacy' }),
        expect.objectContaining({ id: 'existing-id', command: '!newer' })
      ],
      bcfdSlashCommands: []
    })
    await expect(fs.readFile(join(userDataPath, 'commands.json'), 'utf-8')).resolves.toContain(
      '"id": "generated-id"'
    )
  })

  it('loads onboarding defaults when the file is missing or invalid', async () => {
    const { getOnboarding } = await import('./fileService')

    await expect(getOnboarding()).resolves.toEqual({
      stepperDismissed: false,
      botHostedOnce: false,
      dismissedTips: []
    })

    await fs.writeFile(join(userDataPath, 'onboarding.json'), '{bad json')
    await expect(getOnboarding()).resolves.toEqual({
      stepperDismissed: false,
      botHostedOnce: false,
      dismissedTips: []
    })
  })

  it('encrypts API keys at rest', async () => {
    mocks.getSettings.mockReturnValue({
      theme: 'light',
      openaiApiKey: 'openai-secret',
      openrouterApiKey: 'openrouter-secret'
    })
    const { saveSettings } = await import('./fileService')

    await saveSettings()

    const stored = await fs.readFile(join(userDataPath, 'settings.json'), 'utf-8')
    expect(stored).not.toContain('openai-secret')
    expect(stored).not.toContain('openrouter-secret')
    expect(JSON.parse(stored)).toMatchObject({
      openaiApiKey: expect.stringMatching(/^bcfd-encrypted:v1:/),
      openrouterApiKey: expect.stringMatching(/^bcfd-encrypted:v1:/)
    })
  })

  it('propagates encryption failures and preserves the previous settings file', async () => {
    const settingsPath = join(userDataPath, 'settings.json')
    await fs.writeFile(settingsPath, JSON.stringify({ theme: 'light' }))
    mocks.getSettings.mockReturnValue({ theme: 'dark', openaiApiKey: 'secret' })
    mocks.isEncryptionAvailable.mockReturnValue(false)
    const { saveSettings } = await import('./fileService')

    await expect(saveSettings()).rejects.toThrow('Secure credential storage is unavailable')
    await expect(fs.readFile(settingsPath, 'utf-8')).resolves.toBe('{"theme":"light"}')
  })

  it('migrates plaintext API keys after loading them', async () => {
    await fs.writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({ theme: 'light', openaiApiKey: 'old-secret', openrouterApiKey: '' })
    )
    const { loadSettings } = await import('./fileService')

    await loadSettings()

    expect(mocks.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ openaiApiKey: 'old-secret' })
    )
    const stored = await fs.readFile(join(userDataPath, 'settings.json'), 'utf-8')
    expect(stored).not.toContain('old-secret')
    expect(JSON.parse(stored).openaiApiKey).toMatch(/^bcfd-encrypted:v1:/)
    await expect(fs.stat(`${join(userDataPath, 'settings.json')}.bak`)).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('recovers commands from the backup when the primary file is corrupt', async () => {
    const commandsPath = join(userDataPath, 'commands.json')
    const backup = {
      bcfdCommands: [
        {
          id: 'recovered',
          command: '!recovered',
          commandDescription: 'Recovered command',
          type: 0,
          channelMessage: '',
          privateMessage: '',
          channelEmbed: {},
          privateEmbed: {}
        }
      ],
      bcfdSlashCommands: []
    }
    await fs.writeFile(commandsPath, '{partial')
    await fs.writeFile(`${commandsPath}.bak`, JSON.stringify(backup))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { loadCommands } = await import('./fileService')

    try {
      await loadCommands()
    } finally {
      warning.mockRestore()
    }

    expect(mocks.setCommands).toHaveBeenCalledWith({
      bcfdCommands: [expect.objectContaining({ id: 'recovered', command: '!recovered' })],
      bcfdSlashCommands: []
    })
    await expect(fs.readFile(commandsPath, 'utf-8')).resolves.toContain('"id":"recovered"')
  })
})
