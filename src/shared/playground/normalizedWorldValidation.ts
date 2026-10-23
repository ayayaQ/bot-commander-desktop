import type { PlaygroundState } from './types'
import { WORLD_PERMISSIONS, PLAYGROUND_BOT_ID } from './world'
import { validateWorldExtensions } from './worldValidation'
import { validateSessionState } from './sessionState'

/** Canonical entities are checked independently of the disposable active projection. */
export function validateNormalizedWorld(state: PlaygroundState): void {
  const assert = (condition: unknown, field: string) => {
    if (!condition) throw new Error(`Invalid normalized world: ${field}`)
  }
  const id = (value: unknown) =>
    typeof value === 'string' &&
    /^[1-9]\d{0,19}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  const text = (value: unknown, max = 100) =>
    typeof value === 'string' && value.length > 0 && value.length <= max
  const array = (value: unknown, max: number) => Array.isArray(value) && value.length <= max
  const fields = (value: object, names: string[], label: string) => {
    assert(value && typeof value === 'object' && !Array.isArray(value), label)
    assert(
      Object.keys(value).every((key) => names.includes(key)),
      `${label} unsupported field`
    )
  }
  const world = state.world!
  fields(world, ['users', 'guilds', 'memberships', 'roles', 'channels'], 'world')
  for (const [name, max] of [
    ['users', 100],
    ['guilds', 10],
    ['memberships', 500],
    ['roles', 500],
    ['channels', 100]
  ] as const)
    assert(array(world[name], max), name)
  const unique = (values: string[], label: string) =>
    assert(new Set(values).size === values.length, `duplicate ${label}`)
  for (const name of ['users', 'guilds', 'roles', 'channels'] as const)
    unique(
      world[name].map((item) => item.id),
      name
    )
  unique(
    world.memberships.map((member) => `${member.guildId}:${member.id}`),
    'membership'
  )
  unique(
    [
      ...world.users,
      ...world.guilds,
      ...world.channels,
      ...world.roles.filter((role) => role.id !== role.guildId)
    ].map((item) => item.id),
    'entity ID'
  )
  assert(
    world.users.some((user) => user.id === PLAYGROUND_BOT_ID && user.bot === true),
    'bot user'
  )
  for (const user of world.users) {
    fields(user, ['id', 'name', 'bot', 'createdTimestamp'], 'user')
    assert(id(user.id) && text(user.name), 'user identity')
    if (user.bot !== undefined) assert(typeof user.bot === 'boolean', 'user.bot')
    if (user.createdTimestamp !== undefined)
      assert(
        Number.isSafeInteger(user.createdTimestamp) && user.createdTimestamp >= 0,
        'user.createdTimestamp'
      )
  }
  assert(state.botPermissions === undefined, 'use guild roles for bot permissions')
  for (const guild of world.guilds) {
    assert(
      world.memberships.filter((member) => member.guildId === guild.id).length <= 50 &&
        world.roles.filter((role) => role.guildId === guild.id).length <= 50,
      'guild member/role limits'
    )
    fields(guild, ['id', 'name', 'ownerId'], 'guild')
    assert(id(guild.id) && text(guild.name), 'guild identity')
    assert(
      world.memberships.some(
        (member) =>
          member.guildId === guild.id &&
          member.id === guild.ownerId &&
          !member.kicked &&
          !member.banned
      ),
      'guild owner membership'
    )
    assert(
      world.roles.some(
        (role) => role.id === guild.id && role.guildId === guild.id && (role.position ?? 0) === 0
      ),
      '@everyone role'
    )
  }
  for (const role of world.roles) {
    fields(
      role,
      ['id', 'guildId', 'name', 'color', 'position', 'managed', 'editable', 'permissions'],
      'role'
    )
    assert(
      id(role.id) && text(role.name) && world.guilds.some((guild) => guild.id === role.guildId),
      'role guild/identity'
    )
    if (role.permissions !== undefined) {
      assert(
        array(role.permissions, WORLD_PERMISSIONS.length) &&
          role.permissions.every((permission) =>
            WORLD_PERMISSIONS.includes(permission as (typeof WORLD_PERMISSIONS)[number])
          ),
        'role permissions'
      )
      unique(role.permissions, 'role permission')
    }
  }
  for (const member of world.memberships) {
    fields(
      member,
      [
        'id',
        'guildId',
        'roles',
        'permissions',
        'kicked',
        'banned',
        'muted',
        'nickname',
        'joinedTimestamp',
        'voiceChannelId',
        'manageable'
      ],
      'membership'
    )
    assert(
      world.users.some((user) => user.id === member.id) &&
        world.guilds.some((guild) => guild.id === member.guildId),
      'membership references'
    )
    assert(
      array(member.roles, 50) &&
        member.roles.every((id) =>
          world.roles.some((role) => role.guildId === member.guildId && role.id === id)
        ),
      'membership roles'
    )
    unique(member.roles, 'member role')
    assert(
      array(member.permissions, 5) &&
        member.permissions.every((permission) =>
          ['admin', 'manageMessages', 'kick', 'ban', 'mute'].includes(permission)
        ),
      'member permissions'
    )
    for (const flag of ['kicked', 'banned', 'muted'])
      assert(typeof member[flag] === 'boolean', `member.${flag}`)
    if (member.voiceChannelId)
      assert(
        world.channels.some(
          (channel) =>
            channel.id === member.voiceChannelId &&
            channel.guildId === member.guildId &&
            [2, 13].includes(channel.type)
        ),
        'voice channel reference'
      )
  }
  unique(
    world.channels.filter((channel) => channel.type === 1).map((channel) => channel.recipientId!),
    'DM recipient'
  )
  for (const channel of world.channels) {
    assert(id(channel.id), 'channel ID')
    fields(
      channel,
      [
        'id',
        'guildId',
        'name',
        'type',
        'topic',
        'nsfw',
        'parentId',
        'position',
        'slowmode',
        'overwrites',
        'deleted',
        'recipientId'
      ],
      'channel'
    )
    if (channel.type === 1) {
      assert(
        channel.guildId === '' && world.users.some((user) => user.id === channel.recipientId),
        'DM recipient/guild'
      )
      assert(
        channel.parentId === null && Object.keys(channel.overwrites).length === 0,
        'DM overwrites/parent'
      )
    } else {
      assert(
        world.guilds.some((guild) => guild.id === channel.guildId) &&
          channel.recipientId === undefined,
        'channel guild'
      )
      if (channel.parentId !== null)
        assert(
          world.channels.some(
            (parent) =>
              parent.id === channel.parentId &&
              parent.guildId === channel.guildId &&
              parent.type === 4 &&
              parent.id !== channel.id
          ),
          'channel parent reference'
        )
    }
    for (const target of Object.keys(channel.overwrites))
      assert(
        world.roles.some((role) => role.id === target && role.guildId === channel.guildId) ||
          world.memberships.some(
            (member) => member.id === target && member.guildId === channel.guildId
          ),
        'overwrite target reference'
      )
  }
  validateWorldExtensions({
    ...state,
    members: world.memberships.map((member) => ({ ...member, name: '' })),
    roles: world.roles,
    channels: world.channels
  })
  assert(array(state.messages, 300), 'messages')
  unique(
    state.messages.map((message) => String(message.id)),
    'message'
  )
  const entityIds = new Set(
    [...world.users, ...world.guilds, ...world.roles, ...world.channels].map((item) => item.id)
  )
  for (const message of state.messages) {
    fields(
      message,
      [
        'id',
        'author',
        'authorId',
        'guildId',
        'channelId',
        'content',
        'kind',
        'recipient',
        'replyTo',
        'embed',
        'deleted',
        'ephemeral',
        'deferred',
        'buttons',
        'reactions'
      ],
      'message'
    )
    assert(id(message.id) && !entityIds.has(String(message.id)), 'message string ID')
    assert(
      ['user', 'bot', 'dm'].includes(message.kind) &&
        typeof message.content === 'string' &&
        message.content.length <= 32768 &&
        text(message.author),
      'message content'
    )
    const channel = world.channels.find((item) => item.id === message.channelId)
    assert(
      channel && (channel.guildId || null) === message.guildId,
      'message channel/guild reference'
    )
    assert(
      world.users.some((user) => user.id === message.authorId),
      'message author reference'
    )
    if (message.kind === 'user') {
      assert(
        !message.buttons && !message.ephemeral && !message.deferred && !message.recipient,
        'user message cannot spoof interaction responses'
      )
      if (channel?.type === 1) assert(message.authorId === channel.recipientId, 'DM author')
    }
    if (message.kind !== 'user')
      assert(message.authorId === PLAYGROUND_BOT_ID, 'bot message author')
    if (message.guildId && message.kind === 'user')
      assert(
        world.memberships.some(
          (member) => member.id === message.authorId && member.guildId === message.guildId
        ),
        'message membership'
      )
    if (message.kind === 'dm')
      assert(
        channel?.type === 1 && message.recipient === channel.recipientId,
        'DM message recipient'
      )
    if (message.ephemeral || message.recipient)
      assert(
        message.guildId
          ? world.memberships.some(
              (member) => member.id === message.recipient && member.guildId === message.guildId
            )
          : message.recipient === channel?.recipientId,
        'message recipient'
      )
    if (message.replyTo !== undefined)
      assert(
        typeof message.replyTo === 'string' &&
          state.messages.some(
            (target) =>
              target.id === message.replyTo &&
              target.id !== message.id &&
              target.channelId === message.channelId
          ),
        'message reply reference'
      )
    for (const flag of ['deleted', 'ephemeral', 'deferred'])
      if (message[flag] !== undefined) assert(typeof message[flag] === 'boolean', `message.${flag}`)
  }
  assert(
    Number.isSafeInteger(state.nextId) &&
      state.nextId > 0 &&
      state.nextId < Number.MAX_SAFE_INTEGER,
    'nextId sequence'
  )
  assert(
    world.channels.some(
      (channel) => channel.id === state.channelId && channel.guildId === state.guildId
    ),
    'active context'
  )
  validateSessionState(state)
}
