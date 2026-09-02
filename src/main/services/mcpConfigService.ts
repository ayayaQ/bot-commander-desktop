import { app, safeStorage } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import type { McpAccessMode, McpConfig } from '../../shared/mcpTypes'

const MCP_CONFIG_FILENAME = 'mcp-config.json'
const ENCRYPTED_TOKEN_PREFIX = 'bcfd-mcp-encrypted:v1:'
export const DEFAULT_MCP_PORT = 43721

interface StoredMcpConfig extends McpConfig {
  version: 1
  token: string
}

const defaultConfig: StoredMcpConfig = {
  version: 1,
  enabled: false,
  accessMode: 'read-only',
  port: DEFAULT_MCP_PORT,
  token: ''
}

let config: StoredMcpConfig = { ...defaultConfig }
let loaded = false

function configPath(): string {
  return join(app.getPath('userData'), MCP_CONFIG_FILENAME)
}

function validAccessMode(value: unknown): value is McpAccessMode {
  return value === 'read-only' || value === 'read-write'
}

function normalizePort(value: unknown): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('MCP port must be an integer between 1024 and 65535')
  }
  return port
}

export function isMcpSecureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function encryptToken(token: string): string {
  if (!token) return ''
  if (!isMcpSecureStorageAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system')
  }
  return ENCRYPTED_TOKEN_PREFIX + safeStorage.encryptString(token).toString('base64')
}

function decryptToken(token: unknown): string {
  if (typeof token !== 'string' || !token) return ''
  if (!token.startsWith(ENCRYPTED_TOKEN_PREFIX)) return ''
  if (!isMcpSecureStorageAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system')
  }
  return safeStorage.decryptString(
    Buffer.from(token.slice(ENCRYPTED_TOKEN_PREFIX.length), 'base64')
  )
}

async function persist(): Promise<void> {
  const path = configPath()
  const temporary = `${path}.tmp`
  const stored = { ...config, token: encryptToken(config.token) }
  await fs.writeFile(temporary, JSON.stringify(stored, null, 2))
  await fs.rename(temporary, path)
}

export async function loadMcpConfig(): Promise<McpConfig> {
  if (loaded) return getMcpConfig()
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(), 'utf-8')) as Partial<StoredMcpConfig>
    config = {
      version: 1,
      enabled: parsed.enabled === true,
      accessMode: validAccessMode(parsed.accessMode) ? parsed.accessMode : 'read-only',
      port: normalizePort(parsed.port ?? DEFAULT_MCP_PORT),
      token: decryptToken(parsed.token)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to load MCP configuration:', error)
    }
    config = { ...defaultConfig }
  }
  loaded = true
  return getMcpConfig()
}

export function getMcpConfig(): McpConfig {
  return {
    enabled: config.enabled,
    accessMode: config.accessMode,
    port: config.port
  }
}

export function hasMcpToken(): boolean {
  return config.token.length > 0
}

export async function getMcpToken(): Promise<string> {
  await loadMcpConfig()
  if (!config.token) throw new Error('MCP access has not been enabled yet')
  return config.token
}

export async function ensureMcpToken(): Promise<string> {
  await loadMcpConfig()
  if (!isMcpSecureStorageAvailable()) {
    throw new Error('Secure credential storage is unavailable; MCP access cannot be enabled')
  }
  if (!config.token) {
    config.token = crypto.randomBytes(32).toString('base64url')
    await persist()
  }
  return config.token
}

export async function updateMcpConfig(updates: Partial<McpConfig>): Promise<McpConfig> {
  await loadMcpConfig()
  const previous = { ...config }
  const next: StoredMcpConfig = {
    ...config,
    ...(typeof updates.enabled === 'boolean' ? { enabled: updates.enabled } : {}),
    ...(validAccessMode(updates.accessMode) ? { accessMode: updates.accessMode } : {}),
    ...(updates.port === undefined ? {} : { port: normalizePort(updates.port) })
  }
  try {
    config = next
    if (config.enabled) await ensureMcpToken()
    await persist()
  } catch (error) {
    config = previous
    throw error
  }
  return getMcpConfig()
}

export async function rotateMcpToken(): Promise<string> {
  await loadMcpConfig()
  if (!isMcpSecureStorageAvailable()) {
    throw new Error('Secure credential storage is unavailable; the MCP token cannot be rotated')
  }
  config.token = crypto.randomBytes(32).toString('base64url')
  await persist()
  return config.token
}

export function resetMcpConfigForTests(): void {
  config = { ...defaultConfig }
  loaded = false
}
