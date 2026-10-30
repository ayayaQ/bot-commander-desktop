import { commandEvents } from '../../../shared/runtime/dispatch'
import {
  PLAYGROUND_LIMITS,
  type PlaygroundResult,
  type PlaygroundState
} from '../../../shared/playground/types'
import { allocateEntityId, commitWorld } from '../../../shared/playground/world'
import type { BCFDCommand } from '../types/types'

/** A picker prepares an event; dispatch still decides which enabled commands match. */
export function commandEventDraft(command: Pick<BCFDCommand, 'type' | 'command'>) {
  const mode = commandEvents[command.type]
  return {
    mode,
    content: mode === 'message' || mode === 'dm' || mode === 'reaction' ? command.command : ''
  }
}

export function playgroundFeedback(result: PlaygroundResult): string[] {
  const notices = [
    ...(result.warnings ?? []),
    ...(result.incomplete ?? []).map((reason) => `Simulation incomplete: ${reason}`)
  ]
  const matched = result.resources?.filter((resource) => resource.matched) ?? []
  for (const resource of matched) {
    if (resource.outcome === 'blocked' && resource.reason) notices.push(resource.reason)
  }
  if (!matched.length && !result.errors.length && !notices.length)
    notices.push('No saved command matched. Choose a saved command below to try its trigger.')
  return [...new Set(notices)]
}

export function addPlaygroundMember(state: PlaygroundState, name: string): string {
  const memberName = name.trim().slice(0, 100)
  if (!memberName) throw new Error('Enter a member name')
  if (!state.guildId) throw new Error('Choose a server channel before adding a member')
  if (
    state.members.length >= PLAYGROUND_LIMITS.members ||
    (state.world && state.world.users.length >= PLAYGROUND_LIMITS.members)
  )
    throw new Error('This session has reached its member limit')

  const id = allocateEntityId(state)
  state.members = [
    ...state.members,
    {
      id,
      name: memberName,
      roles: [],
      permissions: [],
      kicked: false,
      banned: false,
      muted: false
    }
  ]
  state.world?.users.push({ id, name: memberName })
  commitWorld(state)
  return id
}
