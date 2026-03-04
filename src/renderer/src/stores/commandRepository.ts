import { writable } from 'svelte/store'
import type { BCFDCommand } from '../types/types'

export interface SharedCommandResponse {
  id: string
  user_id: string
  author_username: string
  command_name: string
  command_description?: string
  command_data: BCFDCommand
  downloads: number
  created_at: string
  updated_at: string
}

export interface CommandListResponse {
  commands: SharedCommandResponse[]
  page: number
  page_size: number
  total_count: number
  total_pages: number
}

export type SortBy = 'newest' | 'downloads'

export type CommandRepoState = {
  commands: SharedCommandResponse[]
  myCommands: SharedCommandResponse[]
  isLoading: boolean
  error: string | null
  currentPage: number
  totalPages: number
  totalCount: number
  sortBy: SortBy
  searchQuery: string
}

function emptyState(): CommandRepoState {
  return {
    commands: [],
    myCommands: [],
    isLoading: false,
    error: null,
    currentPage: 1,
    totalPages: 1,
    totalCount: 0,
    sortBy: 'newest',
    searchQuery: ''
  }
}

function createCommandRepoStore() {
  const { subscribe, set, update } = writable<CommandRepoState>(emptyState())

  const ipc = {
    fetchCommands,
    searchCommands,
    shareCommand,
    importCommand,
    deleteSharedCommand,
    fetchMyCommands
  }

  function clearError() {
    update((state) => ({
      ...state,
      error: null
    }))
  }

  function setSortBy(sortBy: SortBy) {
    update((state) => ({
      ...state,
      sortBy
    }))
  }

  function setSearchQuery(query: string) {
    update((state) => ({
      ...state,
      searchQuery: query
    }))
  }

  function reset() {
    set(emptyState())
  }

  return {
    subscribe,
    set,
    update,
    ipc,
    clearError,
    setSortBy,
    setSearchQuery,
    reset
  }
}

export const commandRepoStore = createCommandRepoStore()

async function fetchCommands(page: number = 1, sortBy: SortBy = 'newest') {
  commandRepoStore.update((state) => ({
    ...state,
    isLoading: true,
    error: null,
    sortBy,
    searchQuery: ''
  }))

  try {
    const result = await window.electron.ipcRenderer.invoke('repo-fetch-commands', {
      page,
      pageSize: 20,
      sort: sortBy
    })

    if (result.success) {
      const data: CommandListResponse = result.data
      commandRepoStore.update((state) => ({
        ...state,
        isLoading: false,
        commands: data.commands,
        currentPage: data.page,
        totalPages: data.total_pages,
        totalCount: data.total_count
      }))
    } else {
      commandRepoStore.update((state) => ({
        ...state,
        isLoading: false,
        error: result.error || 'Failed to fetch commands'
      }))
    }

    return result
  } catch (error) {
    commandRepoStore.update((state) => ({
      ...state,
      isLoading: false,
      error: (error as Error).message || 'Failed to fetch commands'
    }))
    return { success: false, error: (error as Error).message }
  }
}

async function searchCommands(query: string, page: number = 1) {
  commandRepoStore.update((state) => ({
    ...state,
    isLoading: true,
    error: null,
    searchQuery: query
  }))

  try {
    const result = await window.electron.ipcRenderer.invoke('repo-search-commands', {
      query,
      page,
      pageSize: 20
    })

    if (result.success) {
      const data: CommandListResponse = result.data
      commandRepoStore.update((state) => ({
        ...state,
        isLoading: false,
        commands: data.commands,
        currentPage: data.page,
        totalPages: data.total_pages,
        totalCount: data.total_count
      }))
    } else {
      commandRepoStore.update((state) => ({
        ...state,
        isLoading: false,
        error: result.error || 'Failed to search commands'
      }))
    }

    return result
  } catch (error) {
    commandRepoStore.update((state) => ({
      ...state,
      isLoading: false,
      error: (error as Error).message || 'Failed to search commands'
    }))
    return { success: false, error: (error as Error).message }
  }
}

async function shareCommand(
  commandName: string,
  commandDescription: string,
  commandData: BCFDCommand
) {
  try {
    // Strip the local id before sharing
    const { id, ...commandWithoutId } = commandData
    const result = await window.electron.ipcRenderer.invoke('repo-share-command', {
      command_name: commandName,
      command_description: commandDescription,
      command_data: commandWithoutId
    })

    return result
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

async function importCommand(id: string): Promise<{
  success: boolean
  command?: BCFDCommand
  error?: string
}> {
  try {
    const result = await window.electron.ipcRenderer.invoke('repo-import-command', {
      id
    })

    if (result.success) {
      const data: SharedCommandResponse = result.data
      // Add a new local id to the imported command
      const importedCommand: BCFDCommand = {
        ...data.command_data,
        id: crypto.randomUUID()
      }
      return { success: true, command: importedCommand }
    } else {
      return { success: false, error: result.error }
    }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

async function deleteSharedCommand(id: string) {
  try {
    const result = await window.electron.ipcRenderer.invoke('repo-delete-command', {
      id
    })

    if (result.success) {
      // Remove from local state
      commandRepoStore.update((state) => ({
        ...state,
        commands: state.commands.filter((c) => c.id !== id),
        myCommands: state.myCommands.filter((c) => c.id !== id)
      }))
    }

    return result
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

async function fetchMyCommands(page: number = 1) {
  commandRepoStore.update((state) => ({
    ...state,
    isLoading: true,
    error: null
  }))

  try {
    const result = await window.electron.ipcRenderer.invoke('repo-my-commands', {
      page,
      pageSize: 20
    })

    if (result.success) {
      const data: CommandListResponse = result.data
      commandRepoStore.update((state) => ({
        ...state,
        isLoading: false,
        myCommands: data.commands
      }))
    } else {
      commandRepoStore.update((state) => ({
        ...state,
        isLoading: false,
        error: result.error || 'Failed to fetch your commands'
      }))
    }

    return result
  } catch (error) {
    commandRepoStore.update((state) => ({
      ...state,
      isLoading: false,
      error: (error as Error).message || 'Failed to fetch your commands'
    }))
    return { success: false, error: (error as Error).message }
  }
}
