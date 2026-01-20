import { ipcMain, session, app } from 'electron'
import type { BCFDCommand } from '../types/types'

// API base URL - production when packaged, localhost for development
const API_BASE_URL = app.isPackaged
  ? 'https://bcfd.ayayaq.com'
  : process.env.API_URL || 'http://localhost:8080'

// Cookie configuration
//const COOKIE_URL = 'http://localhost'
const JWT_COOKIE_NAME = 'api-jwt'

async function getStoredJwt(): Promise<string | null> {
  const jwtCookies = await session.defaultSession.cookies.get({ name: JWT_COOKIE_NAME })
  return jwtCookies[0]?.value ?? null
}

// Types for API responses
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

export function addCommandRepoHandlers() {
  // Fetch commands from repository (public)
  ipcMain.handle(
    'repo-fetch-commands',
    async (
      _event,
      payload: { page?: number; pageSize?: number; sort?: 'newest' | 'downloads' }
    ) => {
      try {
        const params = new URLSearchParams()
        if (payload.page) params.set('page', payload.page.toString())
        if (payload.pageSize) params.set('page_size', payload.pageSize.toString())
        if (payload.sort) params.set('sort', payload.sort)

        const response = await fetch(`${API_BASE_URL}/commands?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          return {
            success: false,
            error: errorData.message || `Server error: ${response.status}`
          }
        }

        const data: CommandListResponse = await response.json()
        return { success: true, data }
      } catch (error) {
        console.error('Fetch commands error:', error)
        return {
          success: false,
          error: (error as Error).message || 'Failed to fetch commands'
        }
      }
    }
  )

  // Search commands (public)
  ipcMain.handle(
    'repo-search-commands',
    async (_event, payload: { query: string; page?: number; pageSize?: number }) => {
      try {
        const params = new URLSearchParams()
        params.set('q', payload.query)
        if (payload.page) params.set('page', payload.page.toString())
        if (payload.pageSize) params.set('page_size', payload.pageSize.toString())

        const response = await fetch(`${API_BASE_URL}/commands/search?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json'
          }
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          return {
            success: false,
            error: errorData.message || `Server error: ${response.status}`
          }
        }

        const data: CommandListResponse = await response.json()
        return { success: true, data }
      } catch (error) {
        console.error('Search commands error:', error)
        return {
          success: false,
          error: (error as Error).message || 'Failed to search commands'
        }
      }
    }
  )

  // Share a command (authenticated)
  ipcMain.handle(
    'repo-share-command',
    async (
      _event,
      payload: { command_name: string; command_description: string; command_data: BCFDCommand }
    ) => {
      try {
        const jwt = await getStoredJwt()
        if (!jwt) {
          return { success: false, error: 'Not authenticated' }
        }

        const response = await fetch(`${API_BASE_URL}/commands`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`
          },
          body: JSON.stringify(payload)
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          return {
            success: false,
            error: errorData.message || `Server error: ${response.status}`
          }
        }

        const data = await response.json()
        return { success: true, data }
      } catch (error) {
        console.error('Share command error:', error)
        return {
          success: false,
          error: (error as Error).message || 'Failed to share command'
        }
      }
    }
  )

  // Import (download) a command (public - increments download counter)
  ipcMain.handle('repo-import-command', async (_event, payload: { id: string }) => {
    try {
      const response = await fetch(`${API_BASE_URL}/commands/${payload.id}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        return {
          success: false,
          error: errorData.message || `Server error: ${response.status}`
        }
      }

      const data: SharedCommandResponse = await response.json()
      return { success: true, data }
    } catch (error) {
      console.error('Import command error:', error)
      return {
        success: false,
        error: (error as Error).message || 'Failed to import command'
      }
    }
  })

  // Delete a shared command (authenticated)
  ipcMain.handle('repo-delete-command', async (_event, payload: { id: string }) => {
    try {
      const jwt = await getStoredJwt()
      if (!jwt) {
        return { success: false, error: 'Not authenticated' }
      }

      const response = await fetch(`${API_BASE_URL}/commands/${payload.id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${jwt}`
        }
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        return {
          success: false,
          error: errorData.message || `Server error: ${response.status}`
        }
      }

      return { success: true }
    } catch (error) {
      console.error('Delete command error:', error)
      return {
        success: false,
        error: (error as Error).message || 'Failed to delete command'
      }
    }
  })

  // Get user's shared commands (authenticated)
  ipcMain.handle(
    'repo-my-commands',
    async (_event, payload?: { page?: number; pageSize?: number }) => {
      try {
        const jwt = await getStoredJwt()
        if (!jwt) {
          return { success: false, error: 'Not authenticated' }
        }

        const params = new URLSearchParams()
        if (payload?.page) params.set('page', payload.page.toString())
        if (payload?.pageSize) params.set('page_size', payload.pageSize.toString())

        const response = await fetch(`${API_BASE_URL}/commands/mine?${params.toString()}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${jwt}`
          }
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          return {
            success: false,
            error: errorData.message || `Server error: ${response.status}`
          }
        }

        const data: CommandListResponse = await response.json()
        return { success: true, data }
      } catch (error) {
        console.error('Fetch my commands error:', error)
        return {
          success: false,
          error: (error as Error).message || 'Failed to fetch your commands'
        }
      }
    }
  )
}
