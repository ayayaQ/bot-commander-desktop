import { PLAYGROUND_LIMITS } from './types'
import { validateBotState } from './sessionState'

/** Drafts are inert text until the user explicitly applies one to the fake session. */
export function parseBotStateDraft(draft: string): Record<string, unknown> {
  if (draft.length > PLAYGROUND_LIMITS.stateBytes)
    throw new Error(`Bot state draft exceeds ${PLAYGROUND_LIMITS.stateBytes} characters`)
  const parsed: unknown = JSON.parse(draft)
  validateBotState(parsed)
  return parsed
}

/** Refresh from committed state after an accepted result or whole-session reset. */
export function formatBotStateDraft(botState: Record<string, unknown>): string {
  const formatted = JSON.stringify(botState, null, 2)
  return formatted.length <= PLAYGROUND_LIMITS.stateBytes ? formatted : JSON.stringify(botState)
}
