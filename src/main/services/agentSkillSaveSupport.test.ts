import { describe, expect, it } from 'vitest'
import { getAgentSkillSaveSupport } from './agentSkillSaveSupport'

describe('production skill save capability', () => {
  it('advertises reviewed saves and explains each mode', () => {
    const support = getAgentSkillSaveSupport()
    expect(support.available).toBe(true)
    expect(support.reason).toContain('Manual mode asks for approval')
    expect(support.reason).toContain('Auto mode can save after review')
    expect(support.reason).toContain('Planning mode cannot save')
    expect(support.reason).toContain('next turn')
  })
})
