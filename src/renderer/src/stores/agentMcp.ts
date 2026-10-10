import { writable } from 'svelte/store'
import type {
  AgentMcpCatalogKind,
  AgentMcpLaunchPreparation,
  AgentMcpServerConfig,
  AgentMcpStartResult,
  AgentMcpStatus
} from '../../../shared/agentMcpTypes'

export interface AgentMcpBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (status: AgentMcpStatus) => void): void
  removeListener(channel: string, listener: (status: AgentMcpStatus) => void): void
}
export interface AgentMcpControlsState {
  status: AgentMcpStatus | null
  preparation: AgentMcpLaunchPreparation | null
  busy: 'load' | 'configure' | 'remove' | 'prepare' | 'start' | 'refresh' | 'disconnect' | null
  error: string
  notice: string
}
export interface AgentMcpConfigDraft {
  id: string
  label: string
  executable: string
  argsJson: string
  cwd: string
  protocol: AgentMcpServerConfig['protocol']
  environment: readonly string[]
}

/** Main remains responsible for validation, privacy screening and installed-file identity. */
export function parseAgentMcpDraft(
  draft: AgentMcpConfigDraft,
  environmentNames: readonly string[]
): AgentMcpServerConfig {
  const controls = /[\u0000-\u001f\u007f-\u009f]/
  const absolute = (value: string) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
  const id = draft.id.trim()
  const label = draft.label.trim()
  if (!/^[a-z][a-z0-9_-]{0,15}$/.test(id))
    throw new Error(
      'Use 1–16 lowercase letters, numbers, underscores or hyphens, starting with a letter.'
    )
  if (!label || label.length > 80 || controls.test(label))
    throw new Error('Enter a label of at most 80 characters without control characters.')
  if (!absolute(draft.executable) || !absolute(draft.cwd))
    throw new Error('The executable and working directory must be absolute paths.')
  if (
    draft.executable.length > 4096 ||
    draft.cwd.length > 4096 ||
    controls.test(draft.executable + draft.cwd)
  )
    throw new Error('Paths must be bounded and contain no control characters.')
  if (draft.protocol !== 'legacy' && draft.protocol !== '2026-07-28')
    throw new Error('Select a supported protocol.')
  let args: unknown
  try {
    args = JSON.parse(draft.argsJson)
  } catch {
    throw new Error('Arguments must be a JSON array of strings, such as ["--stdio"].')
  }
  if (
    !Array.isArray(args) ||
    args.length > 16 ||
    args.some((value) => typeof value !== 'string' || value.length > 4096 || controls.test(value))
  )
    throw new Error('Use a JSON array of up to 16 bounded string arguments.')
  const environment = [...new Set(draft.environment)]
  if (
    environment.length > environmentNames.length ||
    environment.some((name) => !environmentNames.includes(name) || !/^[A-Z_][A-Z0-9_]*$/.test(name))
  )
    throw new Error('Choose only the safe environment names offered by this app.')
  const config: AgentMcpServerConfig = {
    id,
    label,
    executable: draft.executable,
    args: args as string[],
    cwd: draft.cwd,
    protocol: draft.protocol,
    environment
  }
  if (new TextEncoder().encode(JSON.stringify(config)).length > 16 * 1024)
    throw new Error('The server configuration exceeds the 16 KiB limit.')
  return config
}

/** Each mounted card owns its controls; neither configuration nor navigation can replay Start. */
export function createAgentMcpControls(ipc: AgentMcpBridge, now = () => Date.now()) {
  let current: AgentMcpControlsState = {
    status: null,
    preparation: null,
    busy: null,
    error: '',
    notice: ''
  }
  const state = writable(current)
  let active = false
  let generation = 0
  let eventGeneration = 0
  let launchToken: string | undefined
  let launchServerId: string | undefined
  let launchServerJson: string | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  const patch = (value: Partial<AgentMcpControlsState>) => {
    current = { ...current, ...value }
    state.set(current)
  }
  const clearExpiry = () => {
    if (expiry !== undefined) clearTimeout(expiry)
    expiry = undefined
  }
  const revoke = async (token: string, reportError = active) => {
    const expected = generation
    try {
      await ipc.invoke('agent-mcp:cancel-launch', token)
    } catch (error) {
      if (reportError && active && generation === expected)
        patch({ error: error instanceof Error ? error.message : 'Could not cancel the launch.' })
    }
  }
  const cancel = (notice = 'Start cancellation requested.') => {
    const token = launchToken
    launchToken = undefined
    launchServerId = undefined
    launchServerJson = undefined
    clearExpiry()
    if (current.busy === 'prepare' || current.busy === 'start') {
      generation++
      patch({ busy: null })
    }
    patch({ preparation: null, notice })
    if (token) void revoke(token)
  }
  const receive = (status: AgentMcpStatus) => {
    if (!active) return
    eventGeneration++
    const entry = status.servers.find((value) => value.server.id === launchServerId)
    if (
      launchServerId &&
      (status.paused ||
        current.status?.revision !== status.revision ||
        !entry ||
        JSON.stringify(entry.server) !== launchServerJson ||
        entry.cleanupPending ||
        (current.busy !== 'start' && (entry.state === 'connected' || entry.state === 'connecting')))
    )
      cancel('Server state changed. Review a fresh Start disclosure.')
    patch({ status })
  }
  const begin = (action: AgentMcpControlsState['busy']) => {
    if (
      !active ||
      current.busy ||
      current.preparation ||
      (action !== 'load' && current.status?.paused)
    )
      return null
    patch({ busy: action, error: '', notice: '' })
    return { expected: ++generation, events: eventGeneration }
  }
  const matches = (expected: number) => active && generation === expected
  const acceptResponse = (status: AgentMcpStatus, events: number) => {
    // Main emits full terminal statuses. A newer event wins over a delayed invocation response.
    if (events === eventGeneration) patch({ status })
  }
  async function update(
    action: AgentMcpControlsState['busy'],
    channel: string,
    args: unknown[] = [],
    notice = ''
  ) {
    const ticket = begin(action)
    if (!ticket) return false
    try {
      const result = (await ipc.invoke(channel, ...args)) as AgentMcpStatus
      if (!matches(ticket.expected)) return false
      acceptResponse(result, ticket.events)
      patch({ notice })
      return true
    } catch (error) {
      if (matches(ticket.expected))
        patch({ error: error instanceof Error ? error.message : 'MCP control failed.' })
      return false
    } finally {
      if (matches(ticket.expected)) patch({ busy: null })
    }
  }
  return {
    subscribe: state.subscribe,
    mount() {
      if (active) return
      active = true
      ipc.on('agent-mcp:status', receive)
      void update('load', 'agent-mcp:list')
    },
    unmount() {
      if (!active) return
      active = false
      generation++
      ipc.removeListener('agent-mcp:status', receive)
      cancel('')
      patch({ busy: null })
    },
    cancel: () => cancel(),
    configurationChanged() {
      if (current.preparation || current.busy === 'prepare' || current.busy === 'start')
        cancel('Configuration draft changed. Review a fresh Start disclosure.')
    },
    reload: () => update('load', 'agent-mcp:list'),
    configure: (server: AgentMcpServerConfig) =>
      update(
        'configure',
        'agent-mcp:configure',
        [server],
        'Configuration saved. Nothing was started.'
      ),
    remove: (id: string) =>
      update('remove', 'agent-mcp:remove', [id], 'Server configuration removed.'),
    refresh: (id: string, kinds: readonly AgentMcpCatalogKind[]) =>
      kinds.length
        ? update(
            'refresh',
            'agent-mcp:refresh',
            [id, [...new Set(kinds)]],
            'Selected catalogs refreshed.'
          )
        : Promise.resolve(false),
    disconnect: (id: string) =>
      update(
        'disconnect',
        'agent-mcp:disconnect',
        [id],
        'Disconnected. A new Start needs fresh approval.'
      ),
    async prepare(id: string) {
      const entry = current.status?.servers.find((value) => value.server.id === id)
      if (
        !entry ||
        entry.state === 'connected' ||
        entry.state === 'connecting' ||
        entry.cleanupPending
      )
        return false
      const ticket = begin('prepare')
      if (!ticket) return false
      launchServerId = id
      launchServerJson = JSON.stringify(entry.server)
      try {
        const preparation = (await ipc.invoke(
          'agent-mcp:prepare-launch',
          id
        )) as AgentMcpLaunchPreparation
        const latest = current.status?.servers.find((value) => value.server.id === id)
        if (
          !matches(ticket.expected) ||
          preparation.serverId !== id ||
          !latest ||
          current.status?.paused ||
          JSON.stringify(latest.server) !== launchServerJson ||
          latest.cleanupPending ||
          latest.state === 'connected' ||
          latest.state === 'connecting' ||
          now() >= preparation.expiresAt
        ) {
          void revoke(preparation.token, matches(ticket.expected))
          if (matches(ticket.expected))
            patch({ notice: 'The launch changed or expired. Press Start again.' })
          return false
        }
        launchToken = preparation.token
        patch({ preparation })
        expiry = setTimeout(
          () => {
            if (active && launchToken === preparation.token)
              cancel('The Start disclosure expired. Review a fresh launch.')
          },
          Math.max(0, preparation.expiresAt - now())
        )
        return true
      } catch (error) {
        if (matches(ticket.expected))
          patch({ error: error instanceof Error ? error.message : 'Could not prepare launch.' })
        return false
      } finally {
        if (matches(ticket.expected)) {
          if (!current.preparation) {
            launchServerId = undefined
            launchServerJson = undefined
          }
          patch({ busy: null })
        }
      }
    },
    async start() {
      const preparation = current.preparation
      if (!active || current.busy || !preparation || launchToken !== preparation.token) return false
      if (now() >= preparation.expiresAt || current.status?.paused) {
        cancel('The Start disclosure expired or controls paused.')
        return false
      }
      const expected = ++generation
      const events = eventGeneration
      clearExpiry()
      patch({ preparation: null, busy: 'start', error: '', notice: '' })
      try {
        const result = (await ipc.invoke(
          'agent-mcp:start',
          preparation.token
        )) as AgentMcpStartResult
        if (!matches(expected)) return false
        acceptResponse(result.status, events)
        patch({ notice: result.started ? 'Server started.' : 'The server was not started.' })
        return result.started
      } catch (error) {
        if (matches(expected))
          patch({ error: error instanceof Error ? error.message : 'Could not start server.' })
        return false
      } finally {
        if (matches(expected)) {
          launchToken = undefined
          launchServerId = undefined
          launchServerJson = undefined
          patch({ busy: null })
        }
      }
    }
  }
}
