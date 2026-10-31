export interface AgentSkillSaveSupport {
  available: boolean
  reason: string
}

/** Saves use the same reviewed mutation flow as other persistent agent edits. */
export function getAgentSkillSaveSupport(): AgentSkillSaveSupport {
  return {
    available: true,
    reason:
      'Ask the agent to create or update a skill. Manual mode asks for approval; Auto mode can save after review. Planning mode cannot save. Saved skills apply next turn.'
  }
}
