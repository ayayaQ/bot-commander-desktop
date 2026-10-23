import {
  createPlaygroundState,
  type FakeMember,
  type PlaygroundEventContext,
  type PlaygroundState
} from './types'

export const PLAYGROUND_BOT_ID = '900000000000000003'
export const WORLD_PERMISSIONS = [
  'Administrator',
  'ViewChannel',
  'SendMessages',
  'ReadMessageHistory',
  'AddReactions',
  'ManageMessages',
  'ManageChannels',
  'ManageRoles',
  'KickMembers',
  'BanMembers',
  'MuteMembers'
] as const
export const LEGACY_PERMISSIONS = {
  admin: 'Administrator',
  manageMessages: 'ManageMessages',
  kick: 'KickMembers',
  ban: 'BanMembers',
  mute: 'MuteMembers'
} as const

/** Explicit upgrade: retain old IDs as decimal strings; assertions must use strings too. */
export function normalizeWorld(source: PlaygroundState = createPlaygroundState()): PlaygroundState {
  const state = structuredClone(source)
  if (state.world) return state
  const botRole = allocateEntityId(state)
  state.world = {
    users: [
      ...state.members.map(({ id, name, bot, createdTimestamp }) => ({
        id,
        name,
        ...(bot === undefined ? {} : { bot }),
        ...(createdTimestamp === undefined ? {} : { createdTimestamp })
      })),
      { id: PLAYGROUND_BOT_ID, name: 'Playground Bot', bot: true }
    ],
    guilds: [{ id: state.guildId, name: state.guildName, ownerId: state.members[0].id }],
    memberships: [
      ...state.members.map(({ name: _name, bot: _bot, createdTimestamp: _created, ...member }) => ({
        ...member,
        guildId: state.guildId
      })),
      {
        id: PLAYGROUND_BOT_ID,
        guildId: state.guildId,
        roles: [botRole],
        permissions: [],
        kicked: false,
        banned: false,
        muted: false
      }
    ],
    roles: [
      ...state.roles.map((role, index) => ({
        ...role,
        guildId: state.guildId,
        position: role.position ?? index + 1
      })),
      ...(!state.roles.some((role) => role.id === state.guildId)
        ? [
            {
              id: state.guildId,
              guildId: state.guildId,
              name: '@everyone',
              position: 0,
              permissions: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions']
            }
          ]
        : []),
      {
        id: botRole,
        guildId: state.guildId,
        name: 'Playground Bot',
        position: 100,
        permissions: state.botPermissions ?? ['Administrator']
      }
    ],
    channels: structuredClone(
      state.channels ?? [
        {
          id: state.channelId,
          guildId: state.guildId,
          name: state.channelName,
          type: 0,
          topic: '',
          nsfw: state.nsfw,
          parentId: null,
          position: 0,
          slowmode: 0,
          overwrites: {}
        }
      ]
    )
  }
  for (const message of state.messages) {
    if (typeof message.id === 'number' && (!Number.isSafeInteger(message.id) || message.id < 1))
      throw new Error('Cannot migrate an unsafe numeric message ID')
    message.id = String(message.id)
    if (message.replyTo !== undefined) {
      if (
        typeof message.replyTo === 'number' &&
        (!Number.isSafeInteger(message.replyTo) || message.replyTo < 1)
      )
        throw new Error('Cannot migrate an unsafe numeric reply ID')
      message.replyTo = String(message.replyTo)
    }
    message.authorId =
      message.kind === 'user'
        ? state.world.users.find((user) => user.name === message.author)?.id
        : PLAYGROUND_BOT_ID
    message.channelId ??= state.channelId
    message.guildId = message.kind === 'dm' ? null : state.guildId
    if (message.kind === 'dm') message.channelId = dmChannel(state, message.recipient!).id
  }
  delete state.botPermissions
  selectWorldContext(state, { guildId: state.guildId, channelId: state.channelId })
  return state
}

export function allocateEntityId(state: PlaygroundState): string {
  const ids = new Set([
    state.guildId,
    state.channelId,
    PLAYGROUND_BOT_ID,
    ...state.messages.map((item) => String(item.id)),
    ...(state.world
      ? [...state.world.users, ...state.world.guilds, ...state.world.roles, ...state.world.channels]
      : [...state.members, ...state.roles, ...(state.channels ?? [])]
    ).map((item) => item.id)
  ])
  let id: string
  do {
    if (!Number.isSafeInteger(state.nextId) || state.nextId >= Number.MAX_SAFE_INTEGER)
      throw new Error('Entity ID sequence exhausted')
    id = String(800000000000000000n + BigInt(state.nextId++))
  } while (ids.has(id))
  return id
}

export function dmChannel(state: PlaygroundState, recipientId: string) {
  const world = state.world!
  if (!world.users.some((user) => user.id === recipientId)) throw new Error('Unknown DM recipient')
  let channel = world.channels.find((item) => item.type === 1 && item.recipientId === recipientId)
  if (!channel) {
    if (world.channels.length >= 100) throw new Error('Channel limit exceeded')
    channel = {
      id: allocateEntityId(state),
      guildId: '',
      recipientId,
      name: 'Direct message',
      type: 1,
      topic: '',
      nsfw: false,
      parentId: null,
      position: 0,
      slowmode: 0,
      overwrites: {}
    }
    world.channels.push(channel)
    if (!state.guildId && !state.channels?.some((item) => item.id === channel!.id))
      state.channels?.push(channel)
  }
  return channel
}

/** Projection only; switching guild never saves stale data over the canonical world. */
export function selectWorldContext(state: PlaygroundState, context: PlaygroundEventContext): void {
  const world = state.world
  if (!world) {
    if (context.guildId !== state.guildId || context.channelId !== state.channelId)
      throw new Error('Explicit event context requires a normalized world')
    return
  }
  const channel = world.channels.find((item) => item.id === context.channelId && !item.deleted)
  if (!channel || channel.guildId !== (context.guildId ?? ''))
    throw new Error('Channel does not belong to the event guild/DM context')
  const guild = world.guilds.find((item) => item.id === context.guildId)
  if (context.guildId !== null && !guild) throw new Error('Unknown event guild')
  state.guildId = guild?.id ?? ''
  state.guildName = guild?.name ?? ''
  state.channelId = channel.id
  state.channelName = channel.name
  state.nsfw = channel.nsfw
  state.channels = world.channels.filter((item) => item.guildId === state.guildId)
  state.roles = world.roles.filter((item) => item.guildId === state.guildId)
  state.members = guild
    ? world.memberships
        .filter((item) => item.guildId === guild.id)
        .map((member) => ({
          ...member,
          ...world.users.find((user) => user.id === member.id)!
        }))
    : world.users
        .filter((user) => user.id === channel.recipientId)
        .map((user) => ({
          ...user,
          roles: [],
          permissions: [],
          kicked: false,
          banned: false,
          muted: false
        }))
}

export function commitWorld(state: PlaygroundState): PlaygroundState {
  const world = state.world
  if (!world) return state
  const merge = <T extends { guildId: string; id: string }>(all: T[], active: T[]): T[] => {
    const remaining = new Map(active.map((item) => [item.id, item]))
    const result = all.flatMap((item) => {
      if (item.guildId !== state.guildId) return [item]
      const updated = remaining.get(item.id)
      remaining.delete(item.id)
      return updated ? [updated] : []
    })
    return [...result, ...remaining.values()]
  }
  if (state.guildId) {
    world.memberships = merge(
      world.memberships,
      state.members.map(({ name: _name, bot: _bot, createdTimestamp: _created, ...member }) => ({
        ...member,
        guildId: state.guildId
      }))
    )
    world.roles = merge(
      world.roles,
      state.roles.map((role) => ({ ...role, guildId: state.guildId }))
    )
  }
  world.channels = merge(world.channels, state.channels ?? [])
  return state
}

export function prepareWorldEvent(
  state: PlaygroundState,
  context: PlaygroundEventContext | undefined,
  kind: string,
  senderId: string
): PlaygroundState {
  const draft = structuredClone(state)
  if (!draft.world) {
    if (context) selectWorldContext(draft, context)
    return draft
  }
  const selected =
    context ??
    (kind === 'dm'
      ? { guildId: null, channelId: dmChannel(draft, senderId).id }
      : { guildId: draft.guildId || null, channelId: draft.channelId })
  if (kind === 'dm' && selected.guildId !== null) throw new Error('DM events cannot have a guild')
  if (selected.guildId === null && !['dm', 'button', 'reaction'].includes(kind))
    throw new Error('This event requires a guild context')
  selectWorldContext(draft, selected)
  if (!draft.members.some((member) => member.id === senderId))
    throw new Error('Sender is not a member of the event guild/DM')
  return draft
}

export function effectivePermissions(
  state: PlaygroundState,
  memberId: string,
  channelId?: string
): Set<string> {
  const world = state.world
  if (!world) throw new Error('Effective permissions require a normalized world')
  const guild = world.guilds.find((item) => item.id === state.guildId)
  const member = state.members.find((item) => item.id === memberId && !item.kicked && !item.banned)
  if (!guild || !member) return new Set()
  const roles = state.roles.filter((role) => role.id === guild.id || member.roles.includes(role.id))
  const permissions = new Set([
    ...roles.flatMap((role) => role.permissions ?? []),
    ...member.permissions.map((permission) => LEGACY_PERMISSIONS[permission])
  ])
  const administrator = guild.ownerId === memberId || permissions.has('Administrator')
  if (!channelId) return administrator ? new Set(WORLD_PERMISSIONS) : permissions
  const channel = state.channels?.find(
    (item) => item.id === channelId && item.guildId === guild.id && !item.deleted
  )
  if (!channel) throw new Error('Channel not found in the current guild')
  if (administrator) return new Set(WORLD_PERMISSIONS)
  const apply = (overwrites: Record<string, boolean>[]) => {
    for (const overwrite of overwrites)
      for (const [name, allow] of Object.entries(overwrite)) if (!allow) permissions.delete(name)
    for (const overwrite of overwrites)
      for (const [name, allow] of Object.entries(overwrite)) if (allow) permissions.add(name)
  }
  apply([channel.overwrites[guild.id] ?? {}])
  apply(
    roles.filter((role) => role.id !== guild.id).map((role) => channel.overwrites[role.id] ?? {})
  )
  apply([channel.overwrites[memberId] ?? {}])
  if (!permissions.has('ViewChannel'))
    for (const name of [
      'SendMessages',
      'ReadMessageHistory',
      'AddReactions',
      'ManageMessages',
      'ManageChannels',
      'ManageRoles',
      'MuteMembers'
    ])
      permissions.delete(name)
  return permissions
}

export function assertManageable(state: PlaygroundState, target: FakeMember): void {
  if (target.manageable === false) throw new Error('Member is not manageable')
  if (!state.world) return
  const owner = state.world.guilds.find((guild) => guild.id === state.guildId)!.ownerId
  if (
    target.id === owner ||
    target.id === PLAYGROUND_BOT_ID ||
    (owner !== PLAYGROUND_BOT_ID &&
      highestRole(state, PLAYGROUND_BOT_ID) <= highestRole(state, target.id))
  )
    throw new Error('Member is not manageable: role hierarchy or guild owner')
}

function highestRole(state: PlaygroundState, memberId: string): number {
  const member = state.members.find((item) => item.id === memberId)
  return Math.max(
    0,
    ...state.roles
      .filter((role) => member?.roles.includes(role.id))
      .map((role) => role.position ?? 0)
  )
}

export function assertEditableRole(state: PlaygroundState, roleId: string): void {
  const role = state.roles.find((item) => item.id === roleId)
  if (!role) throw new Error('Role not found in the current guild')
  if (
    role.managed ||
    role.editable === false ||
    role.id === state.guildId ||
    (state.world &&
      state.world.guilds.find((guild) => guild.id === state.guildId)?.ownerId !==
        PLAYGROUND_BOT_ID &&
      (role.position ?? 0) >= highestRole(state, PLAYGROUND_BOT_ID))
  )
    throw new Error('Role is not editable: managed role or role hierarchy')
}
