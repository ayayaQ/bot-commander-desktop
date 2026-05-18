import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getCooldownManager } from './cooldownManager'

describe('CooldownManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    getCooldownManager().clear()
  })

  it('tracks user cooldowns independently', () => {
    const manager = getCooldownManager()

    manager.record('command-1', 30, 'user', 'user-a', 'guild-1')

    expect(manager.check('command-1', 30, 'user', 'user-a', 'guild-1')).toEqual({
      allowed: false,
      remaining: 30,
      level: 'user'
    })
    expect(manager.check('command-1', 30, 'user', 'user-b', 'guild-1')).toEqual({
      allowed: true,
      remaining: 0,
      level: 'user'
    })
  })

  it('expires cooldowns and clears by command id', () => {
    const manager = getCooldownManager()

    manager.record('command-1', 10, 'global')
    vi.advanceTimersByTime(4500)
    expect(manager.getRemaining('command-1', 'global', 10)).toBe(6)

    manager.clear('command-1')
    expect(manager.check('command-1', 10, 'global')).toEqual({
      allowed: true,
      remaining: 0,
      level: 'global'
    })
  })
})
