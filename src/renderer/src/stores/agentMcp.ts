import { writable } from 'svelte/store'
import type {
  AgentMcpCatalogKind,
  AgentMcpHttpServerConfig,
  AgentMcpLaunchPreparation,
  AgentMcpServerConfig,
  AgentMcpStartResult,
  AgentMcpStdioServerConfig,
  AgentMcpStatus
} from '../../../shared/agentMcpTypes'
import type {
  AgentMcpOAuthPublicClient,
  AgentMcpOAuthRegistrationSettings,
  AgentMcpOAuthReview,
  AgentMcpOAuthSignInResult
} from '../../../shared/agentMcpOAuthTypes'

export interface AgentMcpBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (status: AgentMcpStatus) => void): void
  removeListener(channel: string, listener: (status: AgentMcpStatus) => void): void
}
export interface AgentMcpControlsState {
  status: AgentMcpStatus | null
  preparation: AgentMcpLaunchPreparation | null
  oauthReview: AgentMcpOAuthReview | null
  oauthServerId: string | null
  busy:
    | 'load'
    | 'configure'
    | 'remove'
    | 'prepare'
    | 'start'
    | 'refresh'
    | 'disconnect'
    | 'oauth-configure'
    | 'oauth-prepare-registration'
    | 'oauth-register'
    | 'oauth-prepare-sign-in'
    | 'oauth-sign-in'
    | null
  error: string
  notice: string
}
export interface AgentMcpConfigDraft {
  transport?: 'stdio' | 'http'
  id: string
  label: string
  executable?: string
  argsJson?: string
  cwd?: string
  endpoint?: string
  allowLoopbackHttp?: boolean
  protocol: AgentMcpServerConfig['protocol']
  environment?: readonly string[]
}
export interface AgentMcpOAuthDraft {
  clientId: string
  issuer: string
  redirectPort: string
  redirectPath: string
  scopes: string
  clientName: string
}

/** Public launch-only input checks; main owns discovery, authorization and all credentials. */
export function parseAgentMcpOAuthDraft(
  draft: AgentMcpOAuthDraft
): AgentMcpOAuthRegistrationSettings {
  const issuer = draft.issuer.trim()
  let url: URL
  try {
    url = new URL(issuer)
  } catch {
    throw new Error('Enter an absolute HTTPS OAuth issuer.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    /[?#\\\s]/.test(issuer) ||
    issuer.length > 4096
  )
    throw new Error('Use an HTTPS OAuth issuer without credentials, query or fragment.')
  const redirectPort = Number(draft.redirectPort)
  if (
    !/^\d{1,5}$/.test(draft.redirectPort) ||
    !Number.isInteger(redirectPort) ||
    redirectPort < 1 ||
    redirectPort > 65535
  )
    throw new Error('Enter an exact loopback port from 1 to 65535.')
  const redirectPath = draft.redirectPath
  if (
    redirectPath.length > 512 ||
    !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(redirectPath) ||
    new URL(redirectPath, 'http://127.0.0.1').pathname !== redirectPath
  )
    throw new Error('Enter an exact absolute loopback callback path without a query or fragment.')
  const scopes = draft.scopes.trim() ? draft.scopes.trim().split(/\s+/) : []
  if (
    scopes.length > 32 ||
    scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope)) ||
    new Set(scopes).size !== scopes.length
  )
    throw new Error('Use up to 32 distinct public scope names, separated by spaces.')
  const clientName = draft.clientName.trim()
  if (!clientName || clientName.length > 128 || /[\u0000-\u001f\u007f-\u009f]/.test(clientName))
    throw new Error('Enter a registration client name of at most 128 characters.')
  return { issuer, redirectPort, redirectPath, scopes, clientName }
}

export function parseAgentMcpOAuthPublicClient(
  draft: AgentMcpOAuthDraft
): AgentMcpOAuthPublicClient {
  const { clientName: _clientName, ...settings } = parseAgentMcpOAuthDraft({
    ...draft,
    clientName: 'Public client'
  })
  const id = draft.clientId.trim()
  if (!id || id.length > 1024 || /[\u0000-\u0020\u007f-\u009f]/.test(id))
    throw new Error('Enter a public client ID without whitespace or control characters.')
  return { id, ...settings }
}

/** UX checks only. Main owns endpoint policy, privacy screening and installed-file identity. */
export function parseAgentMcpDraft(
  draft: AgentMcpConfigDraft & { transport: 'http' },
  environmentNames: readonly string[]
): AgentMcpHttpServerConfig
export function parseAgentMcpDraft(
  draft: AgentMcpConfigDraft & { transport?: 'stdio' },
  environmentNames: readonly string[]
): AgentMcpStdioServerConfig
export function parseAgentMcpDraft(
  draft: AgentMcpConfigDraft,
  environmentNames: readonly string[]
): AgentMcpServerConfig
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
  if (draft.protocol !== 'legacy' && draft.protocol !== '2026-07-28')
    throw new Error('Select a supported protocol.')
  if (draft.transport === 'http') {
    const endpoint = draft.endpoint?.trim() ?? ''
    if (!endpoint || endpoint.length > 4096 || /[\s\\]/.test(endpoint) || controls.test(endpoint))
      throw new Error('Enter a bounded HTTP endpoint URL without whitespace or control characters.')
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new Error('Enter an absolute HTTPS endpoint URL.')
    }
    if (url.username || url.password || /[?#]/.test(endpoint))
      throw new Error('The endpoint cannot contain credentials, a query or a fragment.')
    if (!/^https?:\/\//i.test(endpoint)) throw new Error('Enter an absolute HTTPS endpoint URL.')
    if (url.protocol !== 'https:') {
      if (
        url.protocol !== 'http:' ||
        draft.allowLoopbackHttp !== true ||
        !/^http:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/|$)/i.test(endpoint) ||
        !['127.0.0.1', '[::1]'].includes(url.hostname)
      )
        throw new Error(
          'Use HTTPS, or explicitly allow HTTP with literal 127.0.0.1 or [::1] for local testing.'
        )
    }
    return {
      transport: 'http',
      id,
      label,
      endpoint,
      protocol: draft.protocol,
      allowLoopbackHttp: draft.allowLoopbackHttp === true
    }
  }
  if (draft.transport !== undefined && draft.transport !== 'stdio')
    throw new Error('Select a supported transport.')
  const executable = draft.executable ?? ''
  const cwd = draft.cwd ?? ''
  if (!absolute(executable) || !absolute(cwd))
    throw new Error('The executable and working directory must be absolute paths.')
  if (executable.length > 4096 || cwd.length > 4096 || controls.test(executable + cwd))
    throw new Error('Paths must be bounded and contain no control characters.')
  let args: unknown
  try {
    args = JSON.parse(draft.argsJson ?? '')
  } catch {
    throw new Error('Arguments must be a JSON array of strings, such as ["--stdio"].')
  }
  if (
    !Array.isArray(args) ||
    args.length > 16 ||
    args.some((value) => typeof value !== 'string' || value.length > 4096 || controls.test(value))
  )
    throw new Error('Use a JSON array of up to 16 bounded string arguments.')
  const environment = [...new Set(draft.environment ?? [])]
  if (
    environment.length > environmentNames.length ||
    environment.some((name) => !environmentNames.includes(name) || !/^[A-Z_][A-Z0-9_]*$/.test(name))
  )
    throw new Error('Choose only the safe environment names offered by this app.')
  const config: AgentMcpStdioServerConfig = {
    id,
    label,
    executable,
    args: args as string[],
    cwd,
    protocol: draft.protocol,
    environment,
    ...(draft.transport === 'stdio' ? { transport: 'stdio' as const } : {})
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
    oauthReview: null,
    oauthServerId: null,
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
  let launchAuthRevision: string | undefined
  let oauthServerId: string | undefined
  let oauthServerJson: string | undefined
  let oauthConfigRevision: string | undefined
  let oauthReviewRevision: string | undefined
  let oauthGrantServerId: string | undefined
  const pendingOAuthCancels = new Set<string>()
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
  const revokeOAuth = async (id: string, reportError = active) => {
    if (pendingOAuthCancels.has(id)) return
    pendingOAuthCancels.add(id)
    const expected = generation
    const events = eventGeneration
    try {
      const result = (await ipc.invoke('agent-mcp:oauth-cancel', id)) as AgentMcpStatus
      if (active && generation === expected && events === eventGeneration) patch({ status: result })
    } catch (error) {
      if (reportError && active && generation === expected)
        patch({ error: error instanceof Error ? error.message : 'Could not cancel OAuth.' })
    } finally {
      pendingOAuthCancels.delete(id)
    }
  }
  const cancel = (notice?: string) => {
    const token = launchToken
    const oauthId = oauthServerId ?? oauthGrantServerId
    launchToken = undefined
    launchServerId = undefined
    launchServerJson = undefined
    launchAuthRevision = undefined
    oauthServerId = undefined
    oauthServerJson = undefined
    oauthConfigRevision = undefined
    oauthReviewRevision = undefined
    oauthGrantServerId = undefined
    clearExpiry()
    if (
      current.busy === 'prepare' ||
      current.busy === 'start' ||
      current.busy?.startsWith('oauth-')
    ) {
      generation++
      patch({ busy: null })
    }
    patch({
      preparation: null,
      oauthReview: null,
      oauthServerId: null,
      notice:
        notice ?? (oauthId ? 'OAuth cancellation requested.' : 'Start cancellation requested.')
    })
    if (token) void revoke(token)
    if (oauthId) void revokeOAuth(oauthId)
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
        entry.oauth?.revision !== launchAuthRevision ||
        entry.cleanupPending ||
        (current.busy !== 'start' && (entry.state === 'connected' || entry.state === 'connecting')))
    )
      cancel('Server state changed. Review a fresh Start disclosure.')
    const oauthEntry = status.servers.find((value) => value.server.id === oauthServerId)
    if (
      oauthServerId &&
      (status.paused ||
        status.revision !== oauthConfigRevision ||
        !oauthEntry ||
        JSON.stringify(oauthEntry.server) !== oauthServerJson ||
        oauthEntry.cleanupPending ||
        oauthEntry.state === 'connected' ||
        oauthEntry.state === 'connecting' ||
        (current.oauthReview && oauthEntry.oauth?.revision !== oauthReviewRevision))
    )
      cancel('Server state changed. Review a fresh OAuth action.')
    patch({ status })
  }
  const begin = (action: AgentMcpControlsState['busy']) => {
    if (
      !active ||
      current.busy ||
      current.preparation ||
      current.oauthReview ||
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
  const oauthEntry = (id: string) => {
    const entry = current.status?.servers.find((value) => value.server.id === id)
    return entry &&
      entry.server.transport === 'http' &&
      /^https:\/\//i.test(entry.server.endpoint) &&
      !entry.cleanupPending &&
      entry.state !== 'connected' &&
      entry.state !== 'connecting'
      ? entry
      : undefined
  }
  const oauthCurrent = (id: string, serverJson: string, revision: string) => {
    const entry = oauthEntry(id)
    return (
      !current.status?.paused &&
      current.status?.revision === revision &&
      !!entry &&
      JSON.stringify(entry.server) === serverJson
    )
  }
  const ownOAuth = (id: string) => {
    const entry = oauthEntry(id)
    if (!entry || pendingOAuthCancels.has(id)) return false
    oauthServerId = id
    oauthServerJson = JSON.stringify(entry.server)
    oauthConfigRevision = current.status!.revision
    patch({ oauthServerId: id })
    return true
  }
  const releaseOAuth = () => {
    oauthServerId = undefined
    oauthServerJson = undefined
    oauthConfigRevision = undefined
    oauthReviewRevision = undefined
    patch({ oauthServerId: null })
  }
  const adoptLaunch = (preparation: AgentMcpLaunchPreparation, entryJson: string) => {
    launchToken = preparation.token
    launchServerId = preparation.serverId
    launchServerJson = entryJson
    launchAuthRevision = current.status?.servers.find((entry) => entry.server.id === launchServerId)
      ?.oauth?.revision
    patch({ preparation })
    expiry = setTimeout(
      () => {
        if (active && launchToken === preparation.token)
          cancel('The Start disclosure expired. Review a fresh launch.')
      },
      Math.max(0, preparation.expiresAt - now())
    )
  }
  async function prepareOAuth(
    id: string,
    kind: AgentMcpOAuthReview['kind'],
    settings?: AgentMcpOAuthRegistrationSettings
  ) {
    if (
      !oauthEntry(id) ||
      pendingOAuthCancels.has(id) ||
      (kind === 'sign-in' && !oauthEntry(id)?.oauth?.hasClient)
    )
      return false
    const ticket = begin(
      kind === 'registration' ? 'oauth-prepare-registration' : 'oauth-prepare-sign-in'
    )
    if (!ticket) return false
    ownOAuth(id)
    const serverJson = oauthServerJson!
    const revision = oauthConfigRevision!
    try {
      const review = (await ipc.invoke(
        kind === 'registration'
          ? 'agent-mcp:oauth-prepare-registration'
          : 'agent-mcp:oauth-prepare-sign-in',
        ...(kind === 'registration' ? [id, settings] : [id])
      )) as AgentMcpOAuthReview
      if (
        !matches(ticket.expected) ||
        review.serverId !== id ||
        review.kind !== kind ||
        review.configRevision !== revision ||
        !oauthCurrent(id, serverJson, revision) ||
        now() >= review.expiresAt
      ) {
        // Cancel already revoked in-flight main work. A late response must never cancel a newer owner.
        if (matches(ticket.expected)) cancel('OAuth review changed or expired. Review again.')
        return false
      }
      oauthReviewRevision = current.status?.servers.find((entry) => entry.server.id === id)?.oauth
        ?.revision
      patch({ oauthReview: review })
      expiry = setTimeout(
        () => {
          if (active && current.oauthReview?.token === review.token)
            cancel('The OAuth disclosure expired. Review a fresh action.')
        },
        Math.max(0, review.expiresAt - now())
      )
      return true
    } catch (error) {
      if (matches(ticket.expected))
        patch({ error: error instanceof Error ? error.message : 'Could not prepare OAuth review.' })
      return false
    } finally {
      if (matches(ticket.expected)) {
        if (!current.oauthReview) releaseOAuth()
        patch({ busy: null })
      }
    }
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
      if (
        current.preparation ||
        current.oauthReview ||
        oauthServerId ||
        current.busy === 'prepare' ||
        current.busy === 'start'
      )
        cancel('Configuration draft changed. Review a fresh disclosure.')
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
    async configureOAuth(id: string, client: AgentMcpOAuthPublicClient) {
      if (!oauthEntry(id) || pendingOAuthCancels.has(id)) return false
      const ticket = begin('oauth-configure')
      if (!ticket) return false
      ownOAuth(id)
      try {
        const result = (await ipc.invoke(
          'agent-mcp:oauth-configure-client',
          id,
          client
        )) as AgentMcpStatus
        if (!matches(ticket.expected)) return false
        acceptResponse(result, ticket.events)
        if (!oauthCurrent(id, oauthServerJson!, oauthConfigRevision!)) {
          cancel('Server state changed. Configure a fresh public client.')
          return false
        }
        patch({ notice: 'Public client configured for this app session. Nothing was started.' })
        return true
      } catch (error) {
        if (matches(ticket.expected))
          patch({
            error: error instanceof Error ? error.message : 'Could not configure public client.'
          })
        return false
      } finally {
        if (matches(ticket.expected)) {
          releaseOAuth()
          patch({ busy: null })
        }
      }
    },
    prepareRegistration: (id: string, settings: AgentMcpOAuthRegistrationSettings) =>
      prepareOAuth(id, 'registration', settings),
    prepareSignIn: (id: string) => prepareOAuth(id, 'sign-in'),
    async confirmOAuth() {
      const review = current.oauthReview
      if (!active || current.busy || !review || oauthServerId !== review.serverId) return false
      const id = review.serverId
      const serverJson = oauthServerJson!
      const revision = oauthConfigRevision!
      if (now() >= review.expiresAt || !oauthCurrent(id, serverJson, revision)) {
        cancel('The OAuth disclosure expired or server changed.')
        return false
      }
      const expected = ++generation
      const events = eventGeneration
      clearExpiry()
      patch({
        oauthReview: null,
        busy: review.kind === 'registration' ? 'oauth-register' : 'oauth-sign-in',
        error: '',
        notice: ''
      })
      try {
        if (review.kind === 'registration') {
          const result = (await ipc.invoke(
            'agent-mcp:oauth-register',
            review.token
          )) as AgentMcpStatus
          if (!matches(expected)) return false
          acceptResponse(result, events)
          if (!oauthCurrent(id, serverJson, revision)) {
            cancel('Server state changed. Review a fresh registration.')
            return false
          }
          patch({
            notice: 'Public client registered for this app session. Review sign-in separately.'
          })
          return true
        }
        const result = (await ipc.invoke(
          'agent-mcp:oauth-sign-in',
          review.token
        )) as AgentMcpOAuthSignInResult
        const preparation = result.preparation
        const responseEntry = result.status.servers.find((entry) => entry.server.id === id)
        if (!matches(expected)) {
          if (preparation) void revoke(preparation.token, false)
          return false
        }
        acceptResponse(result.status, events)
        const latest = current.status?.servers.find((entry) => entry.server.id === id)
        if (
          !preparation ||
          preparation.serverId !== id ||
          now() >= preparation.expiresAt ||
          !oauthCurrent(id, serverJson, revision) ||
          latest?.oauth?.revision !== responseEntry?.oauth?.revision
        ) {
          if (preparation) void revoke(preparation.token)
          cancel('Sign-in changed or expired. Review a fresh sign-in and connection.')
          return false
        }
        releaseOAuth()
        oauthGrantServerId = id
        adoptLaunch(preparation, serverJson)
        patch({ notice: 'Sign-in completed. Review this fresh MCP connection before Start once.' })
        return true
      } catch (error) {
        if (matches(expected))
          patch({ error: error instanceof Error ? error.message : 'OAuth action failed.' })
        return false
      } finally {
        if (matches(expected)) {
          releaseOAuth()
          patch({ busy: null })
        }
      }
    },
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
      launchAuthRevision = entry.oauth?.revision
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
          latest.oauth?.revision !== launchAuthRevision ||
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
        adoptLaunch(preparation, launchServerJson!)
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
            launchAuthRevision = undefined
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
          launchAuthRevision = undefined
          oauthGrantServerId = undefined
          patch({ busy: null })
        }
      }
    }
  }
}
