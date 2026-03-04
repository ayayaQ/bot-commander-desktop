import { writable } from 'svelte/store'

export type ApiAuthState = {
  authenticated: boolean
  username: string | null
  isLoading: boolean
  error: string | null
}

function emptyState(): ApiAuthState {
  return {
    authenticated: false,
    username: null,
    isLoading: false,
    error: null
  }
}

function createApiAuthStore() {
  const { subscribe, set, update } = writable<ApiAuthState>(emptyState())

  const ipc = {
    register,
    login,
    logout,
    checkAuth
  }

  function clearError() {
    update((state) => ({
      ...state,
      error: null
    }))
  }

  return {
    subscribe,
    set,
    update,
    ipc,
    clearError
  }
}

export const apiAuthStore = createApiAuthStore()

async function register(username: string, password: string) {
  apiAuthStore.update((state) => ({
    ...state,
    isLoading: true,
    error: null
  }))

  try {
    const result = await window.electron.ipcRenderer.invoke('api-auth-register', {
      username,
      password
    })

    if (result.success) {
      apiAuthStore.update((state) => ({
        ...state,
        isLoading: false,
        authenticated: true,
        username: result.username
      }))
    } else {
      apiAuthStore.update((state) => ({
        ...state,
        isLoading: false,
        error: result.error || 'Registration failed'
      }))
    }

    return result
  } catch (error) {
    apiAuthStore.update((state) => ({
      ...state,
      isLoading: false,
      error: (error as Error).message || 'Registration failed'
    }))
    return { success: false, error: (error as Error).message }
  }
}

async function login(username: string, password: string) {
  apiAuthStore.update((state) => ({
    ...state,
    isLoading: true,
    error: null
  }))

  try {
    const result = await window.electron.ipcRenderer.invoke('api-auth-login', {
      username,
      password
    })

    if (result.success) {
      apiAuthStore.update((state) => ({
        ...state,
        isLoading: false,
        authenticated: true,
        username: result.username
      }))
    } else {
      apiAuthStore.update((state) => ({
        ...state,
        isLoading: false,
        error: result.error || 'Login failed'
      }))
    }

    return result
  } catch (error) {
    apiAuthStore.update((state) => ({
      ...state,
      isLoading: false,
      error: (error as Error).message || 'Login failed'
    }))
    return { success: false, error: (error as Error).message }
  }
}

async function logout() {
  try {
    await window.electron.ipcRenderer.invoke('api-auth-logout')
    apiAuthStore.set(emptyState())
  } catch (error) {
    console.error('Logout error:', error)
    apiAuthStore.set(emptyState())
  }
}

async function checkAuth() {
  try {
    const result = await window.electron.ipcRenderer.invoke('api-auth-check')

    if (result.authenticated) {
      apiAuthStore.update((state) => ({
        ...state,
        authenticated: true,
        username: result.username
      }))
    }
  } catch (error) {
    console.error('Auth check error:', error)
  }
}
