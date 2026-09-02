import { app } from 'electron'
import crypto from 'node:crypto'
import http from 'node:http'
import {
  McpServer,
  createMcpHandler,
  fromJsonSchema,
  type JsonSchemaType,
  type McpHttpHandler,
  type ToolAnnotations
} from '@modelcontextprotocol/server'
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node'
import type { McpActivityEntry, McpConfig, McpServerStatus } from '../../shared/mcpTypes'
import {
  agentToolDefinitions,
  agentToolTargetLabel,
  executeAgentTool,
  mutationToolNames
} from './agentTools'
import {
  ensureMcpToken,
  getMcpConfig,
  getMcpToken,
  hasMcpToken,
  isMcpSecureStorageAvailable,
  loadMcpConfig,
  rotateMcpToken as rotateStoredMcpToken,
  updateMcpConfig as persistMcpConfig
} from './mcpConfigService'

const MAX_REQUEST_BYTES = 1024 * 1024
const MAX_CONCURRENT_REQUESTS = 8
const MAX_ACTIVITY_ENTRIES = 100

const SERVER_INSTRUCTIONS = `Bot Commander MCP controls the Bot Commander desktop app that is currently running. Read tools inspect the app's live data. Before editing an existing resource, call its exact read tool and pass the returned revision to the edit tool. Search for similar commands or interactions before creating one, and lint changed resources after writing. Never invent IDs or revisions. Mutation tools are available only when External agent access is set to Read and write in Bot Commander.`

let httpServer: http.Server | null = null
let mcpHandler: McpHttpHandler | null = null
let activeRequests = 0
let activeToken = ''
let lastClient: string | undefined
let serverError: string | undefined
let activity: McpActivityEntry[] = []
let statusSink: ((status: McpServerStatus) => void) | null = null
let activitySink: ((entries: McpActivityEntry[]) => void) | null = null

function endpoint(config: McpConfig = getMcpConfig()): string {
  return `http://127.0.0.1:${config.port}/mcp`
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function getMcpServerStatus(): McpServerStatus {
  const config = getMcpConfig()
  return {
    ...config,
    running: httpServer?.listening === true,
    endpoint: endpoint(config),
    tokenConfigured: hasMcpToken(),
    secureStorageAvailable: isMcpSecureStorageAvailable(),
    activeRequests,
    ...(lastClient ? { lastClient } : {}),
    ...(serverError ? { error: serverError } : {})
  }
}

export function getMcpActivity(): McpActivityEntry[] {
  return clone(activity)
}

export function setMcpEventSinks(sinks: {
  status?: ((status: McpServerStatus) => void) | null
  activity?: ((entries: McpActivityEntry[]) => void) | null
}): void {
  statusSink = sinks.status ?? null
  activitySink = sinks.activity ?? null
}

function emitStatus(): void {
  statusSink?.(clone(getMcpServerStatus()))
}

function emitActivity(): void {
  activitySink?.(getMcpActivity())
}

function addActivity(entry: McpActivityEntry): void {
  activity = [entry, ...activity.filter((item) => item.id !== entry.id)].slice(
    0,
    MAX_ACTIVITY_ENTRIES
  )
  emitActivity()
}

function updateActivity(id: string, updates: Partial<McpActivityEntry>): void {
  const existing = activity.find((entry) => entry.id === id)
  if (!existing) return
  addActivity({ ...existing, ...updates })
}

function clientLabel(value: string | null | undefined): string {
  const normalized = (value || 'MCP client').replace(/[^\x20-\x7e]/g, '').trim()
  return normalized.slice(0, 100) || 'MCP client'
}

function toolAnnotations(name: string): ToolAnnotations {
  const mutation = mutationToolNames.has(name)
  return {
    readOnlyHint: !mutation,
    destructiveHint: name === 'delete_memory',
    idempotentHint: false,
    openWorldHint: false
  }
}

function resultSummary(result: unknown): string {
  if (result && typeof result === 'object' && 'success' in result) {
    return (result as { success?: unknown }).success === false ? 'Denied' : 'Completed'
  }
  if (Array.isArray(result))
    return `Returned ${result.length} item${result.length === 1 ? '' : 's'}`
  return 'Completed'
}

export function createBotCommanderMcpServer(
  accessMode = getMcpConfig().accessMode,
  client = 'MCP client'
): McpServer {
  const server = new McpServer(
    { name: 'bot-commander', version: app.getVersion() },
    { instructions: SERVER_INSTRUCTIONS }
  )
  const definitions = agentToolDefinitions.filter(
    (definition) => accessMode === 'read-write' || !mutationToolNames.has(definition.function.name)
  )

  for (const definition of definitions) {
    const name = definition.function.name
    server.registerTool(
      name,
      {
        description: definition.function.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          definition.function.parameters as JsonSchemaType
        ),
        annotations: toolAnnotations(name)
      },
      async (args) => {
        const started = Date.now()
        const id = crypto.randomUUID()
        const targetLabel = agentToolTargetLabel(name, args)
        addActivity({
          id,
          timestamp: new Date().toISOString(),
          client,
          tool: name,
          ...(targetLabel ? { targetLabel } : {}),
          kind: mutationToolNames.has(name) ? 'write' : 'read',
          status: 'running'
        })
        try {
          const result = await executeAgentTool(name, args, 'mcp')
          updateActivity(id, {
            status: 'success',
            durationMs: Date.now() - started,
            summary: resultSummary(result)
          })
          return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          updateActivity(id, {
            status: 'error',
            durationMs: Date.now() - started,
            summary: message.slice(0, 240)
          })
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }
            ],
            isError: true
          }
        }
      }
    )
  }
  return server
}

function unauthorized(res: http.ServerResponse): void {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="Bot Commander MCP"'
  })
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authentication required' },
      id: null
    })
  )
}

function bearerToken(header: string | undefined): string {
  if (!header?.startsWith('Bearer ')) return ''
  return header.slice('Bearer '.length).trim()
}

function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(activeToken)
  const provided = Buffer.from(candidate)
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided)
}

async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

export async function startMcpServer(): Promise<McpServerStatus> {
  const config = await loadMcpConfig()
  if (!config.enabled) {
    serverError = undefined
    emitStatus()
    return getMcpServerStatus()
  }
  if (httpServer?.listening) return getMcpServerStatus()

  try {
    activeToken = await ensureMcpToken()
    serverError = undefined
    const validateHost = localhostHostValidation()
    const validateOrigin = localhostOriginValidation()
    mcpHandler = createMcpHandler((context) => {
      const client = clientLabel(context.requestInfo?.headers.get('user-agent'))
      return createBotCommanderMcpServer(config.accessMode, client)
    })
    const nodeHandler = toNodeHandler(mcpHandler, {
      onerror: (error) => {
        console.error('MCP request failed:', error)
      }
    })

    const server = http.createServer((req, res) => {
      if (req.url !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) return
      const contentLength = Number(req.headers['content-length'] || 0)
      if (contentLength > MAX_REQUEST_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Request body is too large' }))
        return
      }
      if (!tokenMatches(bearerToken(req.headers.authorization))) {
        unauthorized(res)
        return
      }
      if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' })
        res.end(JSON.stringify({ error: 'Too many concurrent MCP requests' }))
        return
      }

      const client = clientLabel(req.headers['user-agent'])
      lastClient = client
      activeRequests += 1
      emitStatus()
      void nodeHandler(req, res).finally(() => {
        activeRequests = Math.max(0, activeRequests - 1)
        emitStatus()
      })
    })
    httpServer = server
    await listen(server, config.port)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    serverError = `Could not start MCP on 127.0.0.1:${config.port}: ${message}`
    if (httpServer) httpServer.close()
    httpServer = null
    if (mcpHandler) await mcpHandler.close().catch(() => undefined)
    mcpHandler = null
  }
  emitStatus()
  return getMcpServerStatus()
}

export async function stopMcpServer(): Promise<McpServerStatus> {
  const server = httpServer
  const handler = mcpHandler
  httpServer = null
  mcpHandler = null
  activeToken = ''
  activeRequests = 0
  if (handler) await handler.close().catch(() => undefined)
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }
  emitStatus()
  return getMcpServerStatus()
}

async function restartMcpServer(): Promise<McpServerStatus> {
  await stopMcpServer()
  return startMcpServer()
}

export async function initializeMcpServer(): Promise<McpServerStatus> {
  await loadMcpConfig()
  return startMcpServer()
}

export async function updateMcpServerConfig(updates: Partial<McpConfig>): Promise<McpServerStatus> {
  const before = getMcpConfig()
  const after = await persistMcpConfig(updates)
  if (!after.enabled) return stopMcpServer()
  if (!before.enabled || before.port !== after.port || before.accessMode !== after.accessMode) {
    return restartMcpServer()
  }
  emitStatus()
  return getMcpServerStatus()
}

export async function copyMcpToken(): Promise<string> {
  return getMcpToken()
}

export async function rotateMcpToken(): Promise<McpServerStatus> {
  await rotateStoredMcpToken()
  return restartMcpServer()
}

export function clearMcpActivity(): McpActivityEntry[] {
  activity = []
  emitActivity()
  return []
}
