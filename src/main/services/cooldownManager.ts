/**
 * In-memory cooldown tracking for commands.
 * Cooldowns reset on bot restart (standard behavior).
 */

type CooldownLevel = 'user' | 'server' | 'global'

interface CooldownCheck {
  allowed: boolean
  remaining: number // seconds remaining, 0 if allowed
  level: CooldownLevel // which level blocked it
}

class CooldownManager {
  private timestamps: Map<string, number> = new Map()

  private makeKey(commandId: string, level: CooldownLevel, scopeId?: string): string {
    switch (level) {
      case 'user':
        return `${commandId}:user:${scopeId}`
      case 'server':
        return `${commandId}:server:${scopeId}`
      case 'global':
        return `${commandId}:global`
    }
  }

  /**
   * Check if a command is on cooldown.
   */
  check(
    commandId: string,
    cooldown: number,
    cooldownType: CooldownLevel,
    userId?: string,
    guildId?: string
  ): CooldownCheck {
    if (!cooldown || cooldown <= 0) return { allowed: true, remaining: 0, level: cooldownType }

    const now = Date.now()
    let scopeId: string | undefined

    switch (cooldownType) {
      case 'user':
        scopeId = userId
        break
      case 'server':
        scopeId = guildId
        break
      case 'global':
        scopeId = undefined
        break
    }

    const key = this.makeKey(commandId, cooldownType, scopeId)
    const lastUsed = this.timestamps.get(key)
    if (lastUsed) {
      const elapsed = (now - lastUsed) / 1000
      if (elapsed < cooldown) {
        return {
          allowed: false,
          remaining: Math.ceil(cooldown - elapsed),
          level: cooldownType
        }
      }
    }

    return { allowed: true, remaining: 0, level: cooldownType }
  }

  /**
   * Record a command usage for the configured cooldown level.
   */
  record(
    commandId: string,
    cooldown: number,
    cooldownType: CooldownLevel,
    userId?: string,
    guildId?: string
  ): void {
    if (!cooldown || cooldown <= 0) return

    const now = Date.now()
    let scopeId: string | undefined

    switch (cooldownType) {
      case 'user':
        scopeId = userId
        break
      case 'server':
        scopeId = guildId
        break
      case 'global':
        scopeId = undefined
        break
    }

    this.timestamps.set(this.makeKey(commandId, cooldownType, scopeId), now)
  }

  /**
   * Clear cooldowns for a specific command, or all cooldowns.
   */
  clear(commandId?: string): void {
    if (!commandId) {
      this.timestamps.clear()
      return
    }
    for (const key of this.timestamps.keys()) {
      if (key.startsWith(commandId + ':')) {
        this.timestamps.delete(key)
      }
    }
  }

  /**
   * Get remaining cooldown seconds for a specific level.
   */
  getRemaining(
    commandId: string,
    level: CooldownLevel,
    cooldownSeconds: number,
    scopeId?: string
  ): number {
    const key = this.makeKey(commandId, level, scopeId)
    const lastUsed = this.timestamps.get(key)
    if (!lastUsed || cooldownSeconds <= 0) return 0
    const elapsed = (Date.now() - lastUsed) / 1000
    return elapsed < cooldownSeconds ? Math.ceil(cooldownSeconds - elapsed) : 0
  }
}

let instance: CooldownManager | null = null

export function getCooldownManager(): CooldownManager {
  if (!instance) {
    instance = new CooldownManager()
  }
  return instance
}

export type { CooldownCheck, CooldownLevel }
