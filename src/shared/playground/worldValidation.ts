import type { PlaygroundState } from './types'

/** Validate optional v2 fixture fields after the ordinary bounded JSON copy. */
export function validateWorldExtensions(state: PlaygroundState): void {
  const text = (value: unknown, limit = 16384) => typeof value === 'string' && value.length <= limit
  const id = (value: unknown) => typeof value === 'string' && /^\d{1,20}$/.test(value)
  const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0
  const assert = (condition: unknown, field: string) => {
    if (!condition) throw new Error(`Invalid fixture ${field}`)
  }
  if (state.randomSeed !== undefined)
    assert(integer(state.randomSeed) && state.randomSeed <= 0xffffffff, 'randomSeed')
  if (state.startupSource !== undefined) assert(text(state.startupSource), 'startupSource')
  if (state.strictMocks !== undefined) assert(typeof state.strictMocks === 'boolean', 'strictMocks')
  if (state.commandCount !== undefined) assert(integer(state.commandCount), 'commandCount')
  if (state.botPermissions !== undefined)
    assert(
      Array.isArray(state.botPermissions) &&
        state.botPermissions.length <= 64 &&
        state.botPermissions.every((item) => text(item, 64)),
      'botPermissions'
    )
  if (state.failures !== undefined)
    assert(
      state.failures &&
        !Array.isArray(state.failures) &&
        typeof state.failures === 'object' &&
        Object.entries(state.failures).length <= 100 &&
        Object.entries(state.failures).every(([key, value]) => text(key, 100) && text(value)),
      'failures'
    )
  if (state.aiMocks !== undefined) {
    assert(Array.isArray(state.aiMocks) && state.aiMocks.length <= 100, 'aiMocks')
    for (const mock of state.aiMocks) {
      assert(
        mock &&
          typeof mock === 'object' &&
          Object.keys(mock).every((key) => ['prompt', 'response', 'error'].includes(key)),
        'aiMocks'
      )
      assert(
        text(mock.prompt) && (typeof mock.response === 'string' || typeof mock.error === 'string'),
        'aiMocks response'
      )
      if (mock.response !== undefined) assert(text(mock.response, 32768), 'aiMocks response')
      if (mock.error !== undefined) assert(text(mock.error), 'aiMocks error')
    }
    assert(
      new Set(state.aiMocks.map((mock) => mock.prompt)).size === state.aiMocks.length,
      'duplicate AI prompt'
    )
  }
  if (state.channels !== undefined) {
    assert(Array.isArray(state.channels) && state.channels.length <= 100, 'channels')
    assert(
      new Set(state.channels.map((channel) => channel.id)).size === state.channels.length,
      'duplicate channel'
    )
    for (const channel of state.channels) {
      if (channel.deleted !== undefined)
        assert(typeof channel.deleted === 'boolean', 'channel.deleted')
      assert(id(channel.id) && id(channel.guildId) && text(channel.name, 100), 'channel identity')
      assert(
        [0, 1, 2, 4, 5, 10, 11, 12, 13, 15, 16].includes(channel.type) &&
          text(channel.topic) &&
          typeof channel.nsfw === 'boolean',
        'channel fields'
      )
      assert(channel.parentId === null || id(channel.parentId), 'channel parent')
      assert(
        integer(channel.position) && integer(channel.slowmode) && channel.slowmode <= 21600,
        'channel position/slowmode'
      )
      assert(
        channel.overwrites &&
          typeof channel.overwrites === 'object' &&
          !Array.isArray(channel.overwrites),
        'channel overwrites'
      )
      for (const [target, values] of Object.entries(channel.overwrites))
        assert(
          id(target) &&
            values &&
            Object.entries(values).every(
              ([key, value]) =>
                ['ViewChannel', 'SendMessages'].includes(key) && typeof value === 'boolean'
            ),
          'channel overwrite'
        )
    }
  }
  for (const member of state.members) {
    for (const key of ['bot', 'manageable'])
      if (member[key] !== undefined) assert(typeof member[key] === 'boolean', `member.${key}`)
    for (const key of ['createdTimestamp', 'joinedTimestamp'])
      if (member[key] !== undefined) assert(integer(member[key]), `member.${key}`)
    if (member.nickname !== undefined) assert(text(member.nickname, 100), 'member.nickname')
    if (member.voiceChannelId !== undefined)
      assert(id(member.voiceChannelId), 'member.voiceChannelId')
  }
  for (const role of state.roles) {
    for (const key of ['managed', 'editable'])
      if (role[key] !== undefined) assert(typeof role[key] === 'boolean', `role.${key}`)
    if (role.color !== undefined)
      assert(integer(role.color) && role.color <= 0xffffff, 'role.color')
    if (role.position !== undefined) assert(integer(role.position), 'role.position')
  }
  for (const message of state.messages) {
    if (message.channelId !== undefined) assert(id(message.channelId), 'message.channelId')
    if (message.reactions !== undefined)
      assert(
        Array.isArray(message.reactions) &&
          message.reactions.length <= 100 &&
          message.reactions.every((item) => text(item, 100)),
        'message.reactions'
      )
  }
  if (state.presence !== undefined)
    assert(
      state.presence &&
        typeof state.presence === 'object' &&
        text(state.presence.status, 32) &&
        text(state.presence.activity, 32) &&
        text(state.presence.text, 128),
      'presence'
    )
  if (state.operations !== undefined)
    assert(Array.isArray(state.operations) && state.operations.length <= 1000, 'operations')
}
