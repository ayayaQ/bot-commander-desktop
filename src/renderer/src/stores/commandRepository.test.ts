import { beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import type { BCFDCommand } from '../types/types'

const invokeMock = vi.fn()

function setWindowMock() {
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        invoke: invokeMock,
        send: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn()
      }
    },
    api: {}
  })
  vi.stubGlobal('crypto', {
    randomUUID: vi.fn(() => 'local-import-id')
  })
}

function command(overrides: Partial<BCFDCommand> = {}): BCFDCommand {
  return {
    id: 'local-id',
    channelMessage: '',
    command: '!test',
    commandDescription: 'Test',
    deleteAfter: false,
    deleteIfStrings: '',
    deleteNum: 0,
    ignoreErrorMessage: false,
    isBan: false,
    isKick: false,
    isNSFW: false,
    requiredRole: '',
    isVoiceMute: false,
    isAdmin: false,
    phrase: false,
    privateMessage: '',
    reaction: '',
    roleToAssign: '',
    specificChannel: '',
    specificMessage: '',
    startsWith: false,
    type: 0,
    channelEmbed: {
      title: '',
      description: '',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    },
    privateEmbed: {
      title: '',
      description: '',
      hexColor: '',
      imageURL: '',
      thumbnailURL: '',
      footer: ''
    },
    ...overrides
  }
}

describe('commandRepositoryStore', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    setWindowMock()
  })

  it('fetches commands and stores pagination state', async () => {
    const { commandRepoStore } = await import('./commandRepository')
    invokeMock.mockResolvedValue({
      success: true,
      data: {
        commands: [{ id: 'shared-1', command_name: 'Shared' }],
        page: 2,
        page_size: 20,
        total_count: 25,
        total_pages: 2
      }
    })

    await commandRepoStore.ipc.fetchCommands(2, 'downloads')

    expect(invokeMock).toHaveBeenCalledWith('repo-fetch-commands', {
      page: 2,
      pageSize: 20,
      sort: 'downloads'
    })
    expect(get(commandRepoStore)).toMatchObject({
      isLoading: false,
      error: null,
      sortBy: 'downloads',
      searchQuery: '',
      currentPage: 2,
      totalPages: 2,
      totalCount: 25,
      commands: [{ id: 'shared-1', command_name: 'Shared' }]
    })
  })

  it('stores an error when search fails', async () => {
    const { commandRepoStore } = await import('./commandRepository')
    invokeMock.mockResolvedValue({ success: false, error: 'Backend unavailable' })

    await commandRepoStore.ipc.searchCommands('music')

    expect(get(commandRepoStore)).toMatchObject({
      isLoading: false,
      searchQuery: 'music',
      error: 'Backend unavailable'
    })
  })

  it('strips local ids when sharing and generates local ids when importing', async () => {
    const { commandRepoStore } = await import('./commandRepository')
    invokeMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: true,
        data: {
          id: 'shared-1',
          command_data: command({ id: 'remote-id', command: '!remote' })
        }
      })

    await commandRepoStore.ipc.shareCommand('Name', 'Description', command({ id: 'secret-id' }))
    expect(invokeMock).toHaveBeenCalledWith('repo-share-command', {
      command_name: 'Name',
      command_description: 'Description',
      command_data: expect.not.objectContaining({ id: expect.anything() })
    })

    await expect(commandRepoStore.ipc.importCommand('shared-1')).resolves.toEqual({
      success: true,
      command: expect.objectContaining({ id: 'local-import-id', command: '!remote' })
    })
  })

  it('removes deleted shared commands from both local lists', async () => {
    const { commandRepoStore } = await import('./commandRepository')
    commandRepoStore.set({
      commands: [{ id: 'shared-1' }, { id: 'shared-2' }] as any,
      myCommands: [{ id: 'shared-1' }] as any,
      isLoading: false,
      error: null,
      currentPage: 1,
      totalPages: 1,
      totalCount: 2,
      sortBy: 'newest',
      searchQuery: ''
    })
    invokeMock.mockResolvedValue({ success: true })

    await commandRepoStore.ipc.deleteSharedCommand('shared-1')

    expect(get(commandRepoStore).commands).toEqual([{ id: 'shared-2' }])
    expect(get(commandRepoStore).myCommands).toEqual([])
  })
})
