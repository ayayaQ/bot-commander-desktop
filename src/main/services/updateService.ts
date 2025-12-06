import { app } from 'electron'

interface GitHubRelease {
  tag_name: string
  name: string
  html_url: string
  published_at: string
  body: string
  prerelease: boolean
}

interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  releaseUrl?: string
  releaseName?: string
  releaseNotes?: string
  publishedAt?: string
}

let lastCheckTime = 0
let cachedUpdateInfo: UpdateInfo | null = null
const CACHE_DURATION = 60 * 60 * 1000 // 1 hour in milliseconds

/**
 * Compare two semver version strings
 * Returns true if version2 is greater than version1
 */
function isNewerVersion(version1: string, version2: string): boolean {
  // Remove 'v' prefix if present
  const v1 = version1.replace(/^v/, '')
  const v2 = version2.replace(/^v/, '')

  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const num1 = parts1[i] || 0
    const num2 = parts2[i] || 0

    if (num2 > num1) return true
    if (num2 < num1) return false
  }

  return false
}

/**
 * Check for updates from GitHub releases
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const currentTime = Date.now()

  // Return cached result if still valid
  if (cachedUpdateInfo && currentTime - lastCheckTime < CACHE_DURATION) {
    return cachedUpdateInfo
  }

  const currentVersion = app.getVersion()

  try {
    const response = await fetch(
      'https://api.github.com/repos/ayayaQ/bot-commander-desktop/releases/latest',
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'bot-commander-desktop'
        }
      }
    )

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`)
    }

    const release: GitHubRelease = await response.json()

    // Skip prereleases
    if (release.prerelease) {
      cachedUpdateInfo = {
        hasUpdate: false,
        currentVersion
      }
      lastCheckTime = currentTime
      return cachedUpdateInfo
    }

    const latestVersion = release.tag_name
    const hasUpdate = isNewerVersion(currentVersion, latestVersion)
    console.log(
      `Update check: current=${currentVersion}, latest=${latestVersion}, hasUpdate=${hasUpdate}`
    )

    cachedUpdateInfo = {
      hasUpdate,
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      releaseName: release.name,
      releaseNotes: release.body,
      publishedAt: release.published_at
    }

    lastCheckTime = currentTime
    return cachedUpdateInfo
  } catch (error) {
    console.error('Error checking for updates:', error)

    // Return no update available on error
    cachedUpdateInfo = {
      hasUpdate: false,
      currentVersion,
      latestVersion: undefined,
      releaseUrl: undefined
    }

    lastCheckTime = currentTime
    return cachedUpdateInfo
  }
}

/**
 * Clear the update check cache
 */
export function clearUpdateCache(): void {
  cachedUpdateInfo = null
  lastCheckTime = 0
}
