export interface AgentSkillSaveSupport {
  available: false
  reason: string
}

/** This release provides skill reads and creator drafts only, on every platform. */
export function getAgentSkillSaveSupport(): AgentSkillSaveSupport {
  return {
    available: false,
    reason:
      'Automatic skill saving is disabled on every platform. The creator can draft standard SKILL.md content for manual saving.'
  }
}
