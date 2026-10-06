export interface AgentSkillSaveSupport {
  available: boolean
  reason: string
}

/**
 * Fail closed on every platform until a host-owned, handle-bound transaction adapter is
 * implemented and independently accepted. Pathname validation plus fs.rename does not pin
 * the mutation operands. Tests may substitute this module for ordinary fixture workflows;
 * no runtime flag, renderer setting, environment variable or skill can enable that path.
 */
export function getAgentSkillSaveSupport(): AgentSkillSaveSupport {
  return {
    available: false,
    reason:
      'Agent skill saving is unavailable pending a validated handle-bound filesystem adapter. The creator can draft standard SKILL.md content for manual saving.'
  }
}
