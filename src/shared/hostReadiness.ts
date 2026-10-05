import type { InteractionPublicationState, PublicationOperation } from './interactionPublication'

export type HostLoginState =
  'never-attempted' | 'pending' | 'initializing' | 'ready' | 'failed' | 'disconnected'
export type HostLoginFailure = 'login-failed' | 'state-load-failed'

/** In-process evidence only. No client objects, credentials or remote verification. */
export interface HostConnectionObservation {
  attempt: HostLoginState
  failure: HostLoginFailure | null
  observedAt: number | null
  servingReady: boolean
  gatewayReady: boolean | null
  guildCount: number | null
}

export interface HostReadinessSnapshot {
  connection: HostConnectionObservation
  commandCount: number
  interactionCount: number
  localRegisteredCount: number
  publication: { state: InteractionPublicationState; observedAt: number | null }
}

export interface HostReadiness {
  schemaVersion: 1
  observation: 'local-cache'
  /** When this local read was captured; not a remote verification timestamp. */
  observedAt: string | null
  status: 'available' | 'status-unavailable'
  /** No current remote freshness is tracked by the host. */
  freshness: 'unknown'
  login: {
    state: HostLoginState | 'unknown'
    failure: HostLoginFailure | null
    /** Last owned login lifecycle transition in this process, if observed. */
    observedAt: string | null
  }
  connection: {
    state: 'ready' | 'stale' | 'connecting' | 'disconnected' | 'unknown'
    servingReady: boolean | null
    cachedGuildCount: number | null
  }
  gateway: { state: 'ready' | 'not-ready' | 'unknown'; portalPermissions: 'unknown' }
  resources: { commandCount: number | null; interactionCount: number | null }
  publication: {
    state:
      'not-observed' | 'running' | 'succeeded' | 'partial-failure' | 'failed' | 'stale' | 'unknown'
    operation: PublicationOperation | null
    /** Last in-process publisher transition, including historical outcomes. */
    observedAt: string | null
    freshness: 'unknown'
    remoteRegistration: 'unknown'
    localRegisteredCount: number | null
    pendingCount: number | null
    failedCount: number | null
    failedTargetCount: number | null
    staleCount: number | null
    targetCount: number | null
  }
  nextActions: Array<{
    control: 'Login sidebar' | 'Interactions'
    action: 'connect' | 'wait' | 'review-connection' | 'review-publication' | 'verify-registration'
    guidance: string
  }>
}

const loginStates: readonly HostLoginState[] = [
  'never-attempted',
  'pending',
  'initializing',
  'ready',
  'failed',
  'disconnected'
]

function count(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function timestamp(value: number | null): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15
    ? new Date(value).toISOString()
    : null
}

export function unavailableHostReadiness(observedAt: number): HostReadiness {
  return {
    schemaVersion: 1,
    observation: 'local-cache',
    observedAt: timestamp(observedAt),
    status: 'status-unavailable',
    freshness: 'unknown',
    login: { state: 'unknown', failure: null, observedAt: null },
    connection: { state: 'unknown', servingReady: null, cachedGuildCount: null },
    gateway: { state: 'unknown', portalPermissions: 'unknown' },
    resources: { commandCount: null, interactionCount: null },
    publication: {
      state: 'unknown',
      operation: null,
      observedAt: null,
      freshness: 'unknown',
      remoteRegistration: 'unknown',
      localRegisteredCount: null,
      pendingCount: null,
      failedCount: null,
      failedTargetCount: null,
      staleCount: null,
      targetCount: null
    },
    nextActions: [
      {
        control: 'Login sidebar',
        action: 'review-connection',
        guidance: 'Local status is unavailable. Review the Login sidebar and Interactions UI.'
      }
    ]
  }
}

/** Strict allowlist: never serialize, spread or return any input object. */
export function projectHostReadiness(
  snapshot: HostReadinessSnapshot,
  observedAt: number
): HostReadiness {
  const result = unavailableHostReadiness(observedAt)
  const connection = snapshot.connection
  const attemptValue = connection.attempt
  const failureValue = connection.failure
  const servingLatch = connection.servingReady
  const gatewayReady = connection.gatewayReady
  const attempt = loginStates.includes(attemptValue) ? attemptValue : 'unknown'
  const servingReady =
    servingLatch === false
      ? false
      : servingLatch === true
        ? gatewayReady === true
          ? true
          : gatewayReady === false
            ? false
            : null
        : null
  const state: HostReadiness['connection']['state'] =
    servingLatch === true
      ? servingReady
        ? 'ready'
        : gatewayReady === false
          ? 'stale'
          : 'unknown'
      : attempt === 'pending' || attempt === 'initializing'
        ? 'connecting'
        : attempt === 'unknown'
          ? 'unknown'
          : 'disconnected'
  const publication = snapshot.publication.state
  const operation = publication.operation
  const busy = publication.busy
  const completed = publication.completed
  const topError = publication.error
  const pendingIds = publication.pendingIds
  const failedIds = publication.failedIds
  const staleIds = publication.staleIds
  const targets = publication.targets
  if (
    typeof busy !== 'boolean' ||
    typeof completed !== 'boolean' ||
    !Array.isArray(pendingIds) ||
    !Array.isArray(failedIds) ||
    !Array.isArray(staleIds) ||
    !Array.isArray(targets) ||
    (topError != null && typeof topError !== 'object')
  )
    return result
  let failedTargets = 0
  for (const target of targets) {
    if (!target || typeof target !== 'object' || !Array.isArray(target.commandIds)) return result
    const error = target.error
    if (error != null && typeof error !== 'object') return result
    if (error != null) failedTargets++
  }
  const successfulTargets = targets.length - failedTargets
  const publicationState: HostReadiness['publication']['state'] =
    busy === true
      ? 'running'
      : topError != null
        ? 'failed'
        : failedTargets
          ? successfulTargets
            ? 'partial-failure'
            : 'failed'
          : failedIds.length
            ? 'failed'
            : staleIds.length
              ? 'stale'
              : completed === true
                ? 'succeeded'
                : 'not-observed'
  result.status = 'available'
  result.login = {
    state: attempt,
    failure:
      failureValue === 'login-failed' || failureValue === 'state-load-failed' ? failureValue : null,
    observedAt: timestamp(connection.observedAt)
  }
  result.connection = { state, servingReady, cachedGuildCount: count(connection.guildCount) }
  result.gateway.state =
    gatewayReady === true ? 'ready' : gatewayReady === false ? 'not-ready' : 'unknown'
  result.resources = {
    commandCount: count(snapshot.commandCount),
    interactionCount: count(snapshot.interactionCount)
  }
  result.publication = {
    state: publicationState,
    operation:
      publicationState !== 'not-observed' && ['sync', 'register', 'unregister'].includes(operation)
        ? operation
        : null,
    observedAt: timestamp(snapshot.publication.observedAt),
    freshness: 'unknown',
    remoteRegistration: 'unknown',
    localRegisteredCount: count(snapshot.localRegisteredCount),
    pendingCount: count(pendingIds.length),
    failedCount: count(failedIds.length),
    failedTargetCount: count(failedTargets),
    staleCount: count(staleIds.length),
    targetCount: count(targets.length)
  }
  result.nextActions = []
  if (state === 'connecting') {
    result.nextActions.push({
      control: 'Login sidebar',
      action: 'wait',
      guidance:
        'Wait for the current Login attempt and local bot-state initialization in the sidebar.'
    })
  } else if (state !== 'ready') {
    result.nextActions.push(
      state === 'disconnected' && attempt !== 'failed'
        ? {
            control: 'Login sidebar',
            action: 'connect',
            guidance:
              'Use the existing token field and Login button in the sidebar. Do not share credentials in chat.'
          }
        : {
            control: 'Login sidebar',
            action: 'review-connection',
            guidance:
              'Review the Login sidebar and its existing error guidance. Use the existing Logout/Login controls to retry when ready.'
          }
    )
  }
  result.nextActions.push(
    publicationState === 'running'
      ? {
          control: 'Interactions',
          action: 'wait',
          guidance: 'Wait for the current publication in Interactions.'
        }
      : ['failed', 'partial-failure', 'stale'].includes(publicationState)
        ? {
            control: 'Interactions',
            action: 'review-publication',
            guidance:
              'Review publication feedback in Interactions. Use its existing Register or Sync All controls when ready.'
          }
        : {
            control: 'Interactions',
            action: 'verify-registration',
            guidance:
              'Remote registration and portal permissions are unknown. Local flags and past success are not current remote proof; review Interactions and the existing Discord Developer Portal control.'
          }
  )
  return result
}

/** Getter failures may contain secrets. Never propagate their text into persisted agent results. */
export function readHostReadiness(
  snapshot: () => HostReadinessSnapshot,
  observedAt: number = Date.now()
): HostReadiness {
  try {
    return projectHostReadiness(snapshot(), observedAt)
  } catch {
    return unavailableHostReadiness(observedAt)
  }
}
