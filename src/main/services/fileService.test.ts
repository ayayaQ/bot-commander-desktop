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
  getSelectedStorageBackend: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.appGetPath
  },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    getSelectedStorageBackend: mocks.getSelectedStorageBackend,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString
  }
}))

vi.mock('crypto', () => ({
  randomUUID: mocks.randomUUID,
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
  setSettings: mocks.setSettings,
  normalizeSettings: (settings: unknown) => settings
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
    mocks.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
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

  it('creates an empty commands file on first run', async () => {
    const { loadCommands } = await import('./fileService')

    await loadCommands()

    expect(JSON.parse(await fs.readFile(join(userDataPath, 'commands.json'), 'utf-8'))).toEqual({
      bcfdCommands: [],
      bcfdSlashCommands: []
    })
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
      openrouterApiKey: 'openrouter-secret',
      spamProtectionEnabled: true
    })
    const { saveSettings } = await import('./fileService')

    await saveSettings()

    const stored = await fs.readFile(join(userDataPath, 'settings.json'), 'utf-8')
    expect(stored).not.toContain('openai-secret')
    expect(stored).not.toContain('openrouter-secret')
    expect(JSON.parse(stored)).toMatchObject({
      openaiApiKey: expect.stringMatching(/^bcfd-encrypted:v1:/),
      openrouterApiKey: expect.stringMatching(/^bcfd-encrypted:v1:/),
      spamProtectionEnabled: true
    })
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
  })

  it('recovers commands from backup and never replaces it with malformed primary', async () => {
    const good = { bcfdCommands: [], bcfdSlashCommands: [] }
    await fs.writeFile(join(userDataPath, 'commands.json'), '{truncated')
    await fs.writeFile(join(userDataPath, 'commands.json.bak'), JSON.stringify(good))
    const { loadCommands, saveCommands } = await import('./fileService')
    await loadCommands()
    expect(mocks.setCommands).toHaveBeenCalledWith(good)
    await saveCommands({ bcfdCommands: [], bcfdSlashCommands: [] })
    expect(JSON.parse(await fs.readFile(join(userDataPath, 'commands.json.bak'), 'utf8'))).toEqual(
      good
    )
  })

  it('rejects write errors for every user resource rather than reporting success', async () => {
    const { saveCommands, saveSettings, saveBotStatus, saveWebhookPresets, saveOnboarding } =
      await import('./fileService')
    for (const name of [
      'commands.json',
      'settings.json',
      'botStatus.json',
      'webhook_presets.json',
      'onboarding.json'
    ]) {
      await fs.mkdir(join(userDataPath, name))
    }
    await expect(saveCommands()).rejects.toThrow()
    await expect(saveSettings()).rejects.toThrow()
    await expect(saveBotStatus()).rejects.toThrow()
    await expect(saveWebhookPresets([])).rejects.toThrow()
    await expect(
      saveOnboarding({ stepperDismissed: false, botHostedOnce: false, dismissedTips: [] })
    ).rejects.toThrow()
  })

  it('encrypts legacy credentials in both primary and backup during migration', async () => {
    await fs.writeFile(
      join(userDataPath, 'settings.json'),
      JSON.stringify({ theme: 'light', openaiApiKey: 'legacy-secret' })
    )
    await fs.writeFile(
      join(userDataPath, 'settings.json.bak'),
      JSON.stringify({ theme: 'dark', openaiApiKey: 'older-secret' })
    )
    const { loadSettings } = await import('./fileService')
    await loadSettings()
    for (const name of await fs.readdir(userDataPath)) {
      const text = await fs.readFile(join(userDataPath, name), 'utf8')
      expect(text).not.toContain('legacy-secret')
      expect(text).not.toContain('older-secret')
    }
  })

  it('propagates encryption failures and does not commit a legacy load before secure migration', async () => {
    const path = join(userDataPath, 'settings.json')
    const original = JSON.stringify({ theme: 'light', openaiApiKey: 'legacy-secret' })
    await fs.writeFile(path, original)
    mocks.encryptString.mockImplementation(() => {
      throw new Error('Keychain locked')
    })
    const { loadSettings, saveSettings } = await import('./fileService')
    await expect(
      saveSettings({ theme: 'dark', openaiApiKey: 'new-secret' } as any)
    ).rejects.toThrow('Keychain locked')
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await loadSettings()
    expect(mocks.setSettings).not.toHaveBeenCalled()
    expect(await fs.readFile(path, 'utf8')).toBe(original)
    expect(await fs.readdir(userDataPath)).toEqual(['settings.json'])
    log.mockRestore()
  })

  it('secures a legacy backup when saving over a corrupt settings primary', async () => {
    await fs.writeFile(join(userDataPath, 'settings.json'), '{truncated')
    await fs.writeFile(
      join(userDataPath, 'settings.json.bak'),
      JSON.stringify({ openaiApiKey: 'backup-secret' })
    )
    const { saveSettings } = await import('./fileService')
    await saveSettings({ theme: 'dark', openaiApiKey: 'new-secret' } as any)
    const backup = await fs.readFile(join(userDataPath, 'settings.json.bak'), 'utf8')
    expect(backup).not.toContain('backup-secret')
    expect(JSON.parse(backup).openaiApiKey).toMatch(/^bcfd-encrypted:v1:/)
  })

  it('captures a settings snapshot before a pending disk operation', async () => {
    const settings = { theme: 'dark', openaiApiKey: 'first-secret' } as any
    const { saveSettings } = await import('./fileService')
    const pending = saveSettings(settings)
    settings.openaiApiKey = 'second-secret'
    await pending
    const stored = JSON.parse(await fs.readFile(join(userDataPath, 'settings.json'), 'utf8'))
    expect(mocks.decryptString(Buffer.from(stored.openaiApiKey.split(':v1:')[1], 'base64'))).toBe(
      'first-secret'
    )
  })

  it('skips unreadable encrypted primary credentials without replacing the valid backup', async () => {
    const path = join(userDataPath, 'settings.json')
    const encrypted = (secret: string) =>
      'bcfd-encrypted:v1:' + Buffer.from(`encrypted:${secret}`).toString('base64')
    await fs.writeFile(path, JSON.stringify({ openaiApiKey: encrypted('corrupt') }))
    await fs.writeFile(`${path}.bak`, JSON.stringify({ openaiApiKey: encrypted('recoverable') }))
    mocks.decryptString.mockImplementation((value: Buffer) => {
      const decoded = value.toString().replace('encrypted:', '')
      if (decoded === 'corrupt') throw new Error('Invalid ciphertext')
      return decoded
    })
    const { loadSettings, saveSettings } = await import('./fileService')
    await loadSettings()
    expect(mocks.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ openaiApiKey: 'recoverable' })
    )
    await saveSettings({ theme: 'light', openaiApiKey: 'new-secret' } as any)
    const backup = JSON.parse(await fs.readFile(`${path}.bak`, 'utf8'))
    expect(mocks.decryptString(Buffer.from(backup.openaiApiKey.split(':v1:')[1], 'base64'))).toBe(
      'recoverable'
    )
  })

  it('recovers shape-invalid commands and bot status from valid backups', async () => {
    const commandsPath = join(userDataPath, 'commands.json')
    const statusPath = join(userDataPath, 'botStatus.json')
    await fs.writeFile(commandsPath, JSON.stringify({ bcfdCommands: [{}] }))
    await fs.writeFile(
      `${commandsPath}.bak`,
      JSON.stringify({ bcfdCommands: [], bcfdSlashCommands: [] })
    )
    await fs.writeFile(statusPath, '{}')
    const goodStatus = { status: 'Online', activity: 'None', activityDetails: '', streamUrl: '' }
    await fs.writeFile(`${statusPath}.bak`, JSON.stringify(goodStatus))
    const { loadCommands, loadBotStatus } = await import('./fileService')
    await loadCommands()
    await loadBotStatus()
    expect(mocks.setCommands).toHaveBeenCalledWith({ bcfdCommands: [], bcfdSlashCommands: [] })
    expect(mocks.setBotStatus).toHaveBeenCalledWith(goodStatus)
  })

  it('rejects duplicate command ids without overwriting a previously saved list', async () => {
    const { saveCommands } = await import('./fileService')
    await saveCommands({ bcfdCommands: [], bcfdSlashCommands: [] })
    const command = {
      id: 'same-id',
      command: 'test',
      commandDescription: '',
      type: 0,
      channelMessage: '',
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {}
    } as any
    await expect(
      saveCommands({ bcfdCommands: [command, command], bcfdSlashCommands: [] })
    ).rejects.toThrow('Duplicate persisted command id')
    expect(JSON.parse(await fs.readFile(join(userDataPath, 'commands.json'), 'utf8'))).toEqual({
      bcfdCommands: [],
      bcfdSlashCommands: []
    })
  })
})
