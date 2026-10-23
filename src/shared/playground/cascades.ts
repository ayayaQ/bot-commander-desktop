import type { BCFDCommand } from '../../main/types/types'
import { schedulerFor } from './scheduling'
import { IncompleteSimulationError, markIncomplete } from './failures'
import { PLAYGROUND_BOT_ID } from './world'
import type {
  PlaygroundGatewayEvent,
  PlaygroundMessage,
  PlaygroundOperation,
  PlaygroundRequest,
  PlaygroundResult,
  PlaygroundState,
  PlaygroundMessageRequest,
  PlaygroundResourceResult
} from './types'

export const CASCADE_LIMITS = { maxEvents: 200, maxDepth: 16, maxWork: 1000 } as const

export function validateCascades(state: PlaygroundState): void {
  if (
    state.events !== undefined &&
    (!Array.isArray(state.events) ||
      state.events.length > 1000 ||
      state.events.some(
        (event, index) =>
          !event ||
          event.id !== `event:${index + 1}` ||
          ![
            'message',
            'dm',
            'reaction',
            'memberJoin',
            'memberLeave',
            'memberBan',
            'slash',
            'button'
          ].includes(event.kind) ||
          typeof event.senderId !== 'string' ||
          typeof event.content !== 'string' ||
          !event.context ||
          typeof event.context.channelId !== 'string' ||
          (event.context.guildId !== null && typeof event.context.guildId !== 'string') ||
          !['queued', 'dispatched', 'ignored', 'cancelled'].includes(event.status) ||
          !Number.isSafeInteger(event.depth) ||
          event.depth < 0 ||
          !Number.isSafeInteger(event.scheduledAt) ||
          event.scheduledAt < 0
      ))
  )
    throw new Error('Invalid gateway event history')
  const config = state.cascades
  if (config === undefined) return
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.entries(config).some(
      ([key, value]) =>
        !Object.hasOwn(CASCADE_LIMITS, key) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > CASCADE_LIMITS[key]
    )
  )
    throw new Error('Invalid gateway cascade limits')
}

type Cascade = {
  current: PlaygroundGatewayEvent
  events: PlaygroundGatewayEvent[]
  ready: PlaygroundGatewayEvent[]
  reasons: string[]
  limits: { [K in keyof typeof CASCADE_LIMITS]: number }
  eventCount: number
  work: number
  signal?: AbortSignal
  states: WeakRef<PlaygroundState>[]
}
const sessions = new WeakMap<PlaygroundState, Cascade>()

/** Host execution metadata follows drafts, never fixtures or guest-accessible objects. */
export function inheritCascade(source: PlaygroundState, draft: PlaygroundState): void {
  const session = sessions.get(source)
  if (!session) return
  sessions.set(draft, session)
  session.states.push(new WeakRef(draft))
  draft.events = session.events
}
export function currentGatewayEvent(state: PlaygroundState) {
  return sessions.get(state)?.current
}
export function cascadeSignal(state: PlaygroundState) {
  return sessions.get(state)?.signal
}
function incomplete(session: Cascade, state: PlaygroundState, reason: string) {
  if (!session.reasons.includes(reason)) session.reasons.push(reason)
  markIncomplete(state, reason)
}
export function consumeCascadeWork(state: PlaygroundState): void {
  const session = sessions.get(state)
  if (!session) return
  if (
    session.signal?.aborted ||
    session.reasons.length ||
    ++session.work > session.limits.maxWork
  ) {
    const reason = session.signal?.aborted
      ? 'Gateway cascade cancelled'
      : (session.reasons[0] ?? 'Gateway cascade total work budget exhausted')
    incomplete(session, state, reason)
    throw new IncompleteSimulationError(reason)
  }
}

/** Called only after an adapter has successfully applied its effect. Notification admission
 * can make the simulation incomplete, but never turns a successful effect into a failed one.
 */
export function enqueueGatewayEvent(
  state: PlaygroundState,
  operation: PlaygroundOperation,
  event: Pick<PlaygroundGatewayEvent, 'kind' | 'senderId' | 'content' | 'messageId' | 'context'>
): void {
  const session = sessions.get(state)
  if (!session) return
  const depth = session.current.depth + 1
  if (
    session.eventCount >= session.limits.maxEvents ||
    depth > session.limits.maxDepth ||
    session.events.length >= 1000
  ) {
    incomplete(session, state, 'Gateway cascade event count/depth budget exhausted')
    return
  }
  const record: PlaygroundGatewayEvent = {
    ...event,
    id: `event:${session.events.length + 1}`,
    parentEventId: operation.eventId,
    parentOperationId: operation.id,
    depth,
    scheduledAt: state.clockMs,
    status: 'queued'
  }
  session.events.push(record)
  session.eventCount++
  try {
    consumeCascadeWork(state)
    const scheduler = schedulerFor(state)
    if (!scheduler) throw new IncompleteSimulationError('Gateway event requires virtual scheduler')
    const delivery = scheduler.schedule(0, () => session.ready.push(record))
    void delivery.promise.catch((error) => {
      record.status = 'cancelled'
      record.reason = String(error)
      incomplete(session, state, 'Gateway cascade discarded pending events')
    })
  } catch (error) {
    record.status = 'cancelled'
    record.reason = error instanceof Error ? error.message : String(error)
    incomplete(session, state, record.reason)
  }
}

/** Snapshot only the observable transition, before run() mutates the world. */
export function observeGatewayEffect(state: PlaygroundState, name: string, args: unknown[]) {
  if (!sessions.has(state)) return () => {}
  const member = state.members.find((item) => item.id === args[0])
  const wasPresent = member && !member.kicked && !member.banned
  const wasBanned = member?.banned
  const reaction = state.messages.find((item) => item.id === args[0])
  const hadReaction = reaction?.reactions?.includes(String(args[1]))
  const context = { guildId: state.guildId || null, channelId: state.channelId }
  return (operation: PlaygroundOperation, value: unknown) => {
    const emit = (
      kind: PlaygroundGatewayEvent['kind'],
      senderId: string,
      content = '',
      messageId?: PlaygroundMessage['id'],
      selected = context
    ) =>
      enqueueGatewayEvent(state, operation, {
        kind,
        senderId,
        content,
        messageId,
        context: selected
      })
    if (name === 'member.kicked' && wasPresent && member?.kicked) emit('memberLeave', member.id)
    if (name === 'member.banned' && member?.banned && !wasBanned) {
      emit('memberBan', member.id)
      if (wasPresent) emit('memberLeave', member.id)
    }
    if (name === 'message.send' || name === 'message.dm') {
      const message = value as PlaygroundMessage
      if (!message.ephemeral)
        emit(
          message.kind === 'dm' ? 'dm' : 'message',
          PLAYGROUND_BOT_ID,
          message.content,
          message.id,
          {
            guildId: message.kind === 'dm' ? null : context.guildId,
            channelId: message.channelId ?? context.channelId
          }
        )
    }
    if (name === 'message.react' && reaction && !hadReaction)
      emit('reaction', PLAYGROUND_BOT_ID, String(args[1]), reaction.id, {
        guildId: reaction.guildId ?? context.guildId,
        channelId: reaction.channelId ?? context.channelId
      })
  }
}

function mergeResources(target: PlaygroundResourceResult[], additions: PlaygroundResourceResult[]) {
  for (const resource of additions) {
    const index = target.findIndex(
      (item) => item.resourceId === resource.resourceId && item.kind === resource.kind
    )
    if (index < 0) target.push({ ...resource })
    else {
      const previous = target[index]
      // Any failure of this exact resource survives a later successful invocation.
      const priority = {
        unmatched: 0,
        blocked: 1,
        executed: 2,
        unsupported: 3,
        error: 4,
        not_run: 5
      }
      target[index] = {
        ...(priority[resource.outcome] >= priority[previous.outcome] ? resource : previous),
        matched: previous.matched || resource.matched,
        executed: previous.executed || resource.executed
      }
    }
  }
}

/** Delivery notifications use #43's queue. Handlers run serially at the next completed
 * input-event boundary, in completion/insertion order, against the latest committed world.
 */
export async function runGatewayCascade(
  request: PlaygroundRequest,
  execute: (request: PlaygroundRequest) => Promise<PlaygroundResult>,
  dispatch: (request: PlaygroundMessageRequest) => Promise<PlaygroundResult>
): Promise<PlaygroundResult> {
  validateCascades(request.state)
  if ((request.state.events?.length ?? 0) >= 1000)
    throw new IncompleteSimulationError('Gateway event history limit reached; reset the playground')
  const state = structuredClone(request.state)
  const root: PlaygroundGatewayEvent = {
    id: `event:${(state.events?.length ?? 0) + 1}`,
    kind: request.kind ?? 'message',
    senderId: request.senderId,
    context: request.context ?? { guildId: state.guildId || null, channelId: state.channelId },
    content: 'content' in request ? request.content : '',
    messageId: request.messageId,
    depth: 0,
    scheduledAt: state.clockMs,
    status: 'dispatched',
    dispatchedAt: state.clockMs
  }
  const session: Cascade = {
    current: root,
    events: [...(state.events ?? []), root],
    ready: [],
    reasons: [],
    limits: { ...CASCADE_LIMITS, ...state.cascades },
    eventCount: 1,
    work: 0,
    signal: request.signal,
    states: [new WeakRef(state)]
  }
  sessions.set(state, session)
  state.events = session.events
  try {
    if (request.signal?.aborted) consumeCascadeWork(state)
    let result = await execute({ ...request, state })
    for (const reason of result.incomplete ?? []) incomplete(session, result.state, reason)
    root.context = request.context ?? {
      guildId: result.state.guildId || null,
      channelId: result.state.channelId
    }
    root.resources = result.resources?.filter((item) => item.matched).map((item) => ({ ...item }))
    root.messageId ??= result.state.messages.find(
      (message) => message.kind === 'user' && !state.messages.some((old) => old.id === message.id)
    )?.id
    const resources: PlaygroundResourceResult[] = []
    mergeResources(resources, result.resources ?? [])
    const commands: BCFDCommand[] = request.commands ?? []
    while (session.ready.length && !session.reasons.length) {
      const event = session.ready.shift()!
      if (request.signal?.aborted) {
        incomplete(session, result.state, 'Gateway cascade cancelled')
        break
      }
      const bot =
        event.senderId === PLAYGROUND_BOT_ID ||
        result.state.world?.users.find((user) => user.id === event.senderId)?.bot ||
        result.state.members.find((member) => member.id === event.senderId)?.bot
      event.dispatchedAt = result.state.clockMs
      if (bot) {
        event.status = 'ignored'
        event.reason = 'Live bot-origin filter'
        continue
      }
      session.current = event
      event.status = 'dispatched'
      inheritCascade(state, result.state)
      try {
        consumeCascadeWork(result.state)
        const downstream = await dispatch({
          state: result.state,
          commands,
          kind: event.kind as PlaygroundMessageRequest['kind'],
          senderId: event.senderId,
          content: event.content,
          messageId: event.messageId,
          context: event.context,
          wrapEvalInIIFE: request.wrapEvalInIIFE,
          signal: request.signal
        })
        for (const reason of downstream.incomplete ?? [])
          incomplete(session, downstream.state, reason)
        event.resources = downstream.resources?.filter((item) => item.matched)
        mergeResources(resources, downstream.resources ?? [])
        result = {
          ...result,
          state: downstream.state,
          trace: [
            ...result.trace,
            `Gateway ${event.id}: ${event.kind} caused by ${event.parentOperationId}`,
            ...downstream.trace
          ],
          errors: [...result.errors, ...downstream.errors],
          diagnostics: [...(result.diagnostics ?? []), ...(downstream.diagnostics ?? [])],
          incomplete: [...(result.incomplete ?? []), ...(downstream.incomplete ?? [])],
          warnings: [...(result.warnings ?? []), ...(downstream.warnings ?? [])]
        }
      } catch (error) {
        event.status = 'cancelled'
        event.reason = error instanceof Error ? error.message : String(error)
        incomplete(session, result.state, `Gateway event could not dispatch: ${event.reason}`)
      }
    }
    for (const event of session.events)
      if (event.status === 'queued') {
        event.status = 'cancelled'
        event.reason = 'Gateway cascade discarded pending events'
        incomplete(session, result.state, event.reason)
      }
    result.state.events = session.events
    result.resources = resources
    result.incomplete = [...new Set([...(result.incomplete ?? []), ...session.reasons])]
    return result
  } finally {
    for (const reference of session.states) {
      const draft = reference.deref()
      if (draft) sessions.delete(draft)
    }
    session.ready.length = 0
  }
}
