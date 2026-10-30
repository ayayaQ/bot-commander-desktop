import { markIncomplete, recordFailure } from './failures'
import { SCHEDULER_LIMITS, VirtualScheduler, type SchedulerLimits } from './scheduler'
import type { PlaygroundState } from './types'
import { cascadeSignal } from './cascades'

export type OperationTiming = { delayMs?: number; latencyMs?: number; failure?: string }
export type TimingConfiguration = {
  operations?: Record<string, OperationTiming>
  limits?: Partial<SchedulerLimits>
}

export const TIMED_OPERATIONS = [
  'message.send',
  'message.dm',
  'message.delete',
  'message.purge',
  'message.react',
  'member.kicked',
  'member.banned',
  'member.muted',
  'member.roles.toggle',
  'member.roles.add',
  'member.roles.remove',
  'channel.rename',
  'channel.topic',
  'channel.nsfw',
  'channel.slowmode',
  'channel.position',
  'channel.parent',
  'channel.clone',
  'channel.permissions',
  'channel.create',
  'channel.delete',
  'role.create',
  'role.delete',
  'ai.chat',
  'channel.typing',
  'interaction.defer'
] as const

export function validateTiming(state: PlaygroundState): void {
  const config = state.timing
  if (config === undefined) return
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (!object(config) || Object.keys(config).some((key) => !['operations', 'limits'].includes(key)))
    throw new Error('Invalid timing configuration')
  if (config.limits !== undefined) {
    if (
      !object(config.limits) ||
      Object.entries(config.limits).some(
        ([key, value]) =>
          !Object.hasOwn(SCHEDULER_LIMITS, key) ||
          !Number.isSafeInteger(value) ||
          Number(value) < 1 ||
          Number(value) > SCHEDULER_LIMITS[key]
      )
    )
      throw new Error('Invalid timing limits')
  }
  if (config.operations !== undefined) {
    if (
      !object(config.operations) ||
      Object.keys(config.operations).length > TIMED_OPERATIONS.length
    )
      throw new Error('Invalid timing operations')
    for (const [name, timing] of Object.entries(config.operations)) {
      if (
        !(TIMED_OPERATIONS as readonly string[]).includes(name) ||
        !object(timing) ||
        Object.keys(timing).some((key) => !['delayMs', 'latencyMs', 'failure'].includes(key))
      )
        throw new Error(`Invalid timing operation: ${name}`)
      for (const key of ['delayMs', 'latencyMs'])
        if (
          timing[key] !== undefined &&
          (!Number.isSafeInteger(timing[key]) ||
            timing[key] < 0 ||
            timing[key] > SCHEDULER_LIMITS.maxTimeMs)
        )
          throw new Error(`Invalid timing ${name}.${key}`)
      if (
        timing.failure !== undefined &&
        (typeof timing.failure !== 'string' ||
          !timing.failure.length ||
          timing.failure.length > 16384)
      )
        throw new Error(`Invalid timing ${name}.failure`)
    }
  }
}

const schedulers = new WeakMap<PlaygroundState, VirtualScheduler>()
export function schedulerFor(state: PlaygroundState): VirtualScheduler | undefined {
  return schedulers.get(state)
}

export async function withScheduler<T>(
  state: PlaygroundState,
  execute: () => Promise<T>
): Promise<T> {
  validateTiming(state)
  const scheduler = new VirtualScheduler(
    {
      now: () => state.clockMs,
      set: (value) => {
        state.clockMs = value
      }
    },
    state.timing?.limits
  )
  schedulers.set(state, scheduler)
  try {
    return await scheduler.run(execute, cascadeSignal(state))
  } catch (error) {
    recordFailure(state, error)
    throw error
  } finally {
    for (const entry of state.operations ?? []) {
      if (entry.status === 'scheduled' || entry.status === 'started') {
        markIncomplete(state, 'Virtual scheduler discarded pending operations')
        entry.status = 'cancelled'
        entry.cancelledAt = state.clockMs
      }
    }
    scheduler.dispose()
    schedulers.delete(state)
  }
}
