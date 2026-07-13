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
  randomUUID: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.appGetPath
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
    mocks.getCommands.mockImplementation(
      () => mocks.setCommands.mock.calls.at(-1)?.[0] ?? { bcfdCommands: [], bcfdSlashCommands: [] }
    )
    mocks.getSettings.mockReturnValue({ theme: 'light' })
    mocks.getBotStatus.mockReturnValue({ status: 'Online', activity: 'None', activityDetails: '', streamUrl: '' })
    mocks.getInteractions.mockReturnValue([])
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('creates an empty commands file on first run', async () => {
    const { loadCommands } = await import('./fileService')

    await loadCommands()

    await expect(fs.readFile(join(userDataPath, 'commands.json'), 'utf-8')).resolves.toBe(
      '{"bcfdCommands":[]}'
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
})
