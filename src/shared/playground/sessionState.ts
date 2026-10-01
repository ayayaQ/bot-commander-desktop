import { PLAYGROUND_LIMITS } from './types'
import type { PlaygroundState } from './types'

/** Validate JSON data without invoking accessors or silently dropping values. */
export function validateBotState(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('botState must be a JSON object')
  let visited = 0
  let remaining = PLAYGROUND_LIMITS.stateBytes as number
  const seen = new Set<object>()
  const walk = (item: unknown, depth: number): void => {
    if (++visited > PLAYGROUND_LIMITS.nodes || depth > PLAYGROUND_LIMITS.depth)
      throw new Error('botState exceeds the nesting/work limit')
    if (typeof item === 'string') {
      remaining -= item.length
      if (remaining < 0) throw new Error('botState exceeds the size limit')
      return
    }
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object') throw new Error('botState requires valid JSON values')
    if (seen.has(item)) throw new Error('botState must not contain cycles')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      throw new Error('botState requires plain JSON objects')
    seen.add(item)
    if (Array.isArray(item) && item.length > PLAYGROUND_LIMITS.nodes)
      throw new Error('botState exceeds the work limit')
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') throw new Error('botState requires string keys')
      if (Array.isArray(item) && key === 'length') continue
      if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key))
        throw new Error('botState arrays require index keys')
      remaining -= key.length
      if (remaining < 0) throw new Error('botState exceeds the size limit')
      const property = Object.getOwnPropertyDescriptor(item, key)!
      if (!Object.hasOwn(property, 'value') || !property.enumerable)
        throw new Error('botState must not contain accessors or hidden properties')
      walk(property.value, depth + 1)
    }
    if (Array.isArray(item))
      for (let index = 0; index < item.length; index++)
        if (!Object.hasOwn(item, index)) throw new Error('botState must not contain sparse arrays')
    seen.delete(item)
  }
  walk(value, 0)
  if (JSON.stringify(value).length > PLAYGROUND_LIMITS.stateBytes)
    throw new Error('botState exceeds the size limit')
}

export function validateSessionState(state: PlaygroundState): void {
  validateBotState(state.botState)
  validateBotState(state.variables)
  if (Object.hasOwn(state.variables, 'botState'))
    throw new Error('botState is separate from VM variables')
  if (!Number.isSafeInteger(state.clockMs) || state.clockMs < 0)
    throw new Error('Invalid simulated clock')
  if (
    !state.ai ||
    typeof state.ai.response !== 'string' ||
    typeof state.ai.error !== 'string' ||
    state.ai.response.length > PLAYGROUND_LIMITS.output ||
    state.ai.error.length > PLAYGROUND_LIMITS.output
  )
    throw new Error('Invalid simulated AI configuration')
  if (
    !state.cooldowns ||
    typeof state.cooldowns !== 'object' ||
    Array.isArray(state.cooldowns) ||
    Object.keys(state.cooldowns).length > 1000 ||
    Object.entries(state.cooldowns).some(
      ([key, timestamp]) => key.length > 500 || !Number.isSafeInteger(timestamp) || timestamp < 0
    )
  )
    throw new Error('Invalid or oversized simulated cooldowns')
}

export type CooldownCommand = {
  id: string
  cooldown?: number
  cooldownType?: string
  cooldownMessage?: string
}

export function cooldownKey(
  commandId: string,
  level: string,
  userId: string,
  guildId: string
): string {
  if (!['user', 'server', 'global'].includes(level)) throw new Error('Invalid cooldown scope')
  // Same command/user/server/global keys as production, without its truthy-timestamp-zero bug.
  return `${commandId}:${level}${level === 'global' ? '' : `:${level === 'user' ? userId : guildId}`}`
}

export function remainingCooldown(
  state: PlaygroundState,
  command: CooldownCommand,
  senderId: string,
  requestedLevel?: string
): number {
  const seconds = command.cooldown ?? 0
  if (!command.id || seconds <= 0) return 0
  if (!Number.isFinite(seconds)) throw new Error('Invalid cooldown duration')
  const level =
    requestedLevel?.trim().toLowerCase() || command.cooldownType?.toLowerCase() || 'user'
  const key = cooldownKey(command.id, level, senderId, state.guildId)
  const timestamp = Object.hasOwn(state.cooldowns, key) ? state.cooldowns[key] : undefined
  return timestamp === undefined
    ? 0
    : Math.max(0, Math.ceil(seconds - (state.clockMs - timestamp) / 1000))
}

export function recordCooldown(
  state: PlaygroundState,
  command: CooldownCommand,
  senderId: string
): void {
  if (!((command.cooldown ?? 0) > 0) || !command.cooldownType) return
  if (!Number.isFinite(command.cooldown)) throw new Error('Invalid cooldown duration')
  state.cooldowns[
    cooldownKey(command.id, command.cooldownType.toLowerCase(), senderId, state.guildId)
  ] = state.clockMs
  validateSessionState(state)
}
