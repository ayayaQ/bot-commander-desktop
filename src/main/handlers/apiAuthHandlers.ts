import { ipcMain, session, app } from 'electron'

// API base URL - production when packaged, localhost for development
const API_BASE_URL = app.isPackaged
  ? 'https://bcfd.ayayaq.com'
  : process.env.API_URL || 'http://localhost:8080'

// Cookie configuration
const COOKIE_URL = 'http://localhost'
const JWT_COOKIE_NAME = 'api-jwt'
const USERNAME_COOKIE_NAME = 'api-username'
const COOKIE_EXPIRY_DAYS = 30

async function setAuthCookies(jwt: string, username: string) {
  const expirationDate = Date.now() / 1000 + COOKIE_EXPIRY_DAYS * 24 * 60 * 60

  await session.defaultSession.cookies.set({
    url: COOKIE_URL,
    name: JWT_COOKIE_NAME,
    value: jwt,
    expirationDate
  })

  await session.defaultSession.cookies.set({
    url: COOKIE_URL,
    name: USERNAME_COOKIE_NAME,
    value: username,
    expirationDate
  })
}

async function clearAuthCookies() {
  await session.defaultSession.cookies.remove(COOKIE_URL, JWT_COOKIE_NAME)
  await session.defaultSession.cookies.remove(COOKIE_URL, USERNAME_COOKIE_NAME)
}

async function getStoredAuth(): Promise<{ jwt: string | null; username: string | null }> {
  const jwtCookies = await session.defaultSession.cookies.get({ name: JWT_COOKIE_NAME })
  const usernameCookies = await session.defaultSession.cookies.get({ name: USERNAME_COOKIE_NAME })

  return {
    jwt: jwtCookies[0]?.value ?? null,
    username: usernameCookies[0]?.value ?? null
  }
}

export function addApiAuthHandlers() {
  // Register - creates a new user account
  ipcMain.handle(
    'api-auth-register',
    async (_event, payload: { username: string; password: string }) => {
      try {
        const response = await fetch(`${API_BASE_URL}/auth/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
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

        // Store JWT and username in cookies
        await setAuthCookies(data.jwt, data.username)

        return { success: true, username: data.username }
      } catch (error) {
        console.error('Register error:', error)
        return {
          success: false,
          error: (error as Error).message || 'Failed to connect to server'
        }
      }
    }
  )

  // Login - authenticates existing user
  ipcMain.handle(
    'api-auth-login',
    async (_event, payload: { username: string; password: string }) => {
      try {
        const response = await fetch(`${API_BASE_URL}/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          return {
            success: false,
            error: errorData.message || 'Invalid username or password'
          }
        }

        const data = await response.json()

        // Store JWT and username in cookies
        await setAuthCookies(data.jwt, data.username)

        return { success: true, username: data.username }
      } catch (error) {
        console.error('Login error:', error)
        return {
          success: false,
          error: (error as Error).message || 'Login failed'
        }
      }
    }
  )

  // Logout - clears stored JWT
  ipcMain.handle('api-auth-logout', async () => {
    try {
      await clearAuthCookies()
      return { success: true }
    } catch (error) {
      console.error('Logout error:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  // Check auth - validates stored JWT with server
  ipcMain.handle('api-auth-check', async () => {
    try {
      const { jwt, username } = await getStoredAuth()

      if (!jwt || !username) {
        return { authenticated: false }
      }

      // Validate JWT with server
      const response = await fetch(`${API_BASE_URL}/auth/me`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${jwt}`
        }
      })

      if (!response.ok) {
        // JWT is invalid or expired, clear cookies
        await clearAuthCookies()
        return { authenticated: false }
      }

      return {
        authenticated: true,
        username
      }
    } catch (error) {
      console.error('Auth check error:', error)
      // On network error, keep the user logged in if they have valid cookies
      // This allows offline usage
      const { jwt, username } = await getStoredAuth()
      if (jwt && username) {
        return { authenticated: true, username }
      }
      return { authenticated: false }
    }
  })
}
