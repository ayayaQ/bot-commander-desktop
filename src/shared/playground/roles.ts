import type { FakeMember, FakeRole, PlaygroundState } from './types'

/** Discord includes the guild-ID @everyone role in every member's role cache. */
export function hasFakeRole(state: PlaygroundState, member: FakeMember, roleId: string): boolean {
  return roleId === state.guildId || member.roles.includes(roleId)
}

export function fakeMemberRoles(state: PlaygroundState, member: FakeMember): FakeRole[] {
  return [
    { id: state.guildId, name: '@everyone' },
    ...state.roles.filter(
      (role) => role.id !== state.guildId && hasFakeRole(state, member, role.id)
    )
  ]
}
