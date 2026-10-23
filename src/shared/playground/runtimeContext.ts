import {
  allocateEntityId,
  effectivePermissions,
  assertManageable,
  assertEditableRole,
  PLAYGROUND_BOT_ID
} from './world'
import { IncompleteSimulationError, markIncomplete, recordFailure } from './failures'
import { parsePresence } from '../runtime/presence'
import type { BCFDContext } from '../runtime/types'
import type { RuntimeServices } from '../runtime/services'
import { createFunctionRegistry } from '../runtime/keywords'
import type { TemplateContext } from './template'
import {
  PLAYGROUND_LIMITS,
  type FakeChannel,
  type FakeMember,
  type FakeRole,
  type PlaygroundState
} from './types'
import { DELETE_MESSAGE_ERRORS, validateDeleteMessageArguments } from '../deleteMessage'
import { remainingCooldown } from './sessionState'

/** The collection facade is local data, never a Discord client or SDK object. */
class EntityMap<T extends { id: string }> extends Map<string, T> {
  constructor(items: T[]) {
    super(items.map((item) => [item.id, item]))
  }
  find(predicate: (item: T) => boolean): T | undefined {
    return [...this.values()].find(predicate)
  }
  filter(predicate: (item: T) => boolean): EntityMap<T> {
    return new EntityMap([...this.values()].filter(predicate))
  }
  map<R>(fn: (item: T) => R): R[] {
    return [...this.values()].map(fn)
  }
}

export function fakeChannels(state: PlaygroundState): FakeChannel[] {
  if (state.world) return state.channels ?? []
  state.channels ??= []
  let channel = state.channels.find((item) => item.id === state.channelId)
  if (!channel) {
    channel = {
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
    state.channels.push(channel)
  }
  if (!channel.deleted) {
    channel.name = state.channelName
    channel.nsfw = state.nsfw
    channel.guildId = state.guildId
  }
  return state.channels
}

export function operation<T>(
  state: PlaygroundState,
  name: string,
  args: unknown[],
  run: () => T
): T {
  state.operations ??= []
  if (state.operations.length >= 1000) throw incompleteLimit(state, 'Operation limit exceeded')
  const entry = {
    ...(state.world
      ? { context: { guildId: state.guildId || null, channelId: state.channelId } }
      : {}),
    index: state.operations.length,
    name,
    args: JSON.parse(JSON.stringify(args))
  } as NonNullable<PlaygroundState['operations']>[number]
  if (JSON.stringify(entry.args).length > 4096) {
    entry.args = ['[Operation arguments omitted: log size limit]']
    entry.truncated = true
  }
  if (
    JSON.stringify(state).length + JSON.stringify(entry).length >
    PLAYGROUND_LIMITS.requestBytes - 32_768
  )
    throw incompleteLimit(state, 'Operation log size limit reached; reset the playground')
  state.operations.push(entry)
  try {
    if (state.failures?.[name]) throw new Error(state.failures[name])
    const value = run()
    entry.result = value === undefined ? null : JSON.parse(JSON.stringify(value))
    if (name === 'message.send' || name === 'message.dm')
      entry.result = { id: (value as { id: string | number }).id }
    if (JSON.stringify(entry.result).length > 4096) {
      entry.result = '[Operation result omitted: log size limit]'
      entry.truncated = true
    }
    return value
  } catch (error) {
    recordFailure(state, error)
    entry.error = error instanceof Error ? error.message : String(error)
    throw error
  }
}

export function seededRandom(state: PlaygroundState): number {
  let value = (state.randomSeed ?? 1) >>> 0
  value = (Math.imul(value, 1664525) + 1013904223) >>> 0
  state.randomSeed = value
  return value / 4294967296
}

export function requireBotPermission(
  state: PlaygroundState,
  name: string,
  channelId?: string
): void {
  if (state.world) {
    if (!state.guildId) {
      if (['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions'].includes(name))
        return
      throw new Error(`Missing bot ${name} permission in DM context`)
    }
    if (!effectivePermissions(state, PLAYGROUND_BOT_ID, channelId).has(name))
      throw new Error(`Missing bot ${name} permission`)
    return
  }
  if (
    state.botPermissions &&
    !state.botPermissions.includes('Administrator') &&
    !state.botPermissions.includes(name)
  )
    throw new Error(`Missing bot ${name} permission`)
}

export function createFakeRuntime(ctx: TemplateContext) {
  const state = ctx.state
  const channels = fakeChannels(state)
  const permission = (name: string, channelId?: string) =>
    requireBotPermission(state, name, channelId)
  const allocateId = () => allocateEntityId(state)
  const requireChannelCapacity = () => {
    const otherChannels =
      state.world?.channels.filter((item) => item.guildId !== state.guildId).length ?? 0
    if (otherChannels + channels.length >= 100)
      throw new IncompleteSimulationError('Channel limit exceeded')
  }
  const user = (member: FakeMember) => ({
    id: member.id,
    displayName: member.name,
    username: member.name,
    globalName: member.name,
    tag: member.name,
    discriminator: '0',
    bot: member.bot ?? false,
    createdTimestamp: member.createdTimestamp ?? 0,
    defaultAvatarURL: '',
    avatarURL: () => ''
  })
  const channelView = (channel: FakeChannel) => {
    const update = async (name: string, value: unknown, patch: Partial<FakeChannel>) => {
      operation(state, name, [channel.id, value], () => {
        permission('ManageChannels', channel.id)
        Object.assign(channel, patch)
        if (channel.id === state.channelId) {
          state.channelName = channel.name
          state.nsfw = channel.nsfw
        }
        return true
      })
    }
    const view = {
      get id() {
        return channel.id
      },
      get name() {
        return channel.name
      },
      get type() {
        return channel.type
      },
      get parentId() {
        return channel.parentId
      },
      get position() {
        return channel.position
      },
      get rawPosition() {
        return channel.position
      },
      createdTimestamp: 0,
      get topic() {
        return channel.topic
      },
      get nsfw() {
        return channel.nsfw
      },
      get rateLimitPerUser() {
        return channel.slowmode
      },
      setName: (value: string) => update('channel.rename', value, { name: value }),
      setTopic: (value: string) => update('channel.topic', value, { topic: value }),
      setNSFW: (value: boolean) => update('channel.nsfw', value, { nsfw: value }),
      setRateLimitPerUser: (value: number) =>
        update('channel.slowmode', value, { slowmode: value }),
      setPosition: (value: number) => update('channel.position', value, { position: value }),
      setParent: async (value: string | null) => {
        if (
          value &&
          !channels.some(
            (item) =>
              item.id === value &&
              item.type === 4 &&
              !item.deleted &&
              item.guildId === state.guildId
          )
        )
          throw new Error('Category not found')
        await update('channel.parent', value, { parentId: value })
      },
      clone: async () => {
        const clone = operation(state, 'channel.clone', [channel.id], () => {
          permission('ManageChannels', channel.id)
          requireChannelCapacity()
          const clone = { ...structuredClone(channel), id: allocateId() }
          channels.push(clone)
          return clone
        })
        return channelView(clone)
      },
      permissionOverwrites: {
        edit: async (id: string, overwrite: FakeChannel['overwrites'][string]) => {
          operation(state, 'channel.permissions', [channel.id, id, overwrite], () => {
            permission('ManageRoles', channel.id)
            if (
              state.world &&
              !state.roles.some((role) => role.id === id) &&
              !state.members.some((member) => member.id === id)
            )
              throw new Error('Overwrite target not found in the current guild')
            channel.overwrites[id] = { ...channel.overwrites[id] }
            for (const [key, value] of Object.entries(overwrite)) {
              if (value === null) delete channel.overwrites[id][key]
              else channel.overwrites[id][key] = value
            }
          })
        }
      },
      messages: {
        delete: async (id: string) => {
          operation(state, 'message.delete', [channel.id, id], () => {
            const message = state.messages.find(
              (item) =>
                String(item.id) === id &&
                (item.channelId ?? state.channelId) === channel.id &&
                !item.deleted &&
                !item.ephemeral &&
                (state.world || item.kind !== 'dm')
            )
            if (!message) throw new Error(DELETE_MESSAGE_ERRORS.missingMessage)
            if (state.world) {
              permission('ViewChannel', channel.id)
              if (message.authorId !== PLAYGROUND_BOT_ID) permission('ManageMessages', channel.id)
            }
            message.deleted = true
          })
        }
      }
    }
    return view
  }
  const roleView = (role: FakeRole) => ({
    id: role.id,
    name: role.name,
    color: role.color ?? 0,
    rawPosition: role.position ?? 0,
    managed: role.managed ?? false,
    editable: (() => {
      try {
        assertEditableRole(state, role.id)
        return true
      } catch {
        return false
      }
    })(),
    delete: async () =>
      operation(state, 'role.delete', [role.id], () => {
        permission('ManageRoles')
        assertEditableRole(state, role.id)
        state.roles = state.roles.filter((item) => item.id !== role.id)
        for (const member of state.members)
          member.roles = member.roles.filter((id) => id !== role.id)
        for (const channel of channels) delete channel.overwrites[role.id]
      })
  })
  const roles = () =>
    new EntityMap(
      [
        { id: state.guildId, name: '@everyone' },
        ...state.roles.filter((item) => item.id !== state.guildId)
      ].map(roleView)
    )
  const memberView = (member: FakeMember) => ({
    ...user(member),
    user: user(member),
    displayName: member.nickname || member.name,
    displayAvatarURL: () => '',
    nickname: member.nickname ?? null,
    joinedTimestamp: member.joinedTimestamp ?? 0,
    premiumSinceTimestamp: null,
    displayHexColor: '#000000',
    manageable: (() => {
      try {
        assertManageable(state, member)
        return true
      } catch {
        return false
      }
    })(),
    guild: {
      ownerId:
        state.world?.guilds.find((item) => item.id === state.guildId)?.ownerId ??
        state.members[0]?.id
    },
    roles: {
      get cache() {
        return roles().filter((role) => role.id === state.guildId || member.roles.includes(role.id))
      },
      add: async (ids: string[]) =>
        operation(state, 'member.roles.add', [member.id, ids], () => {
          permission('ManageRoles')
          if (state.world) assertManageable(state, member)
          for (const id of ids) assertEditableRole(state, id)
          member.roles = [...new Set([...member.roles, ...ids])]
        }),
      remove: async (ids: string[]) =>
        operation(state, 'member.roles.remove', [member.id, ids], () => {
          permission('ManageRoles')
          if (state.world) assertManageable(state, member)
          for (const id of ids) assertEditableRole(state, id)
          member.roles = member.roles.filter((id) => !ids.includes(id))
        })
    }
  })
  const bot = {
    ...user({
      id: '900000000000000003',
      name: 'Playground Bot',
      roles: [],
      permissions: [],
      kicked: false,
      banned: false,
      muted: false,
      bot: true
    })
  }
  const guild = {
    id: state.guildId,
    name: state.guildName,
    ownerId:
      state.world?.guilds.find((item) => item.id === state.guildId)?.ownerId ??
      state.members[0]?.id,
    get memberCount() {
      return state.members.filter((item) => !item.kicked && !item.banned).length
    },
    createdTimestamp: 0,
    description: '',
    premiumTier: 0,
    premiumSubscriptionCount: 0,
    vanityURLCode: '',
    iconURL: () => '',
    bannerURL: () => '',
    splashURL: () => '',
    fetchOwner: async () =>
      memberView(state.members.find((member) => member.id === guild.ownerId)!),
    channels: {
      get cache() {
        return new EntityMap(
          channels
            .filter((item) => !item.deleted && item.guildId === state.guildId)
            .map(channelView)
        )
      },
      fetch: async (id: string) => {
        const channel = channels.find(
          (item) => !item.deleted && item.id === id && item.guildId === state.guildId
        )
        return channel ? channelView(channel) : null
      },
      create: async (data: {
        name: string
        type: number
        parent?: string
        permissionOverwrites?: { id: string; allow?: bigint[]; deny?: bigint[] }[]
      }) => {
        const created = operation(
          state,
          'channel.create',
          [
            {
              ...data,
              permissionOverwrites:
                data.permissionOverwrites?.map((item) => ({ id: item.id, private: !!item.deny })) ??
                []
            }
          ],
          () => {
            permission('ManageChannels')
            requireChannelCapacity()
            if (
              data.parent &&
              !channels.some(
                (item) =>
                  item.id === data.parent &&
                  item.type === 4 &&
                  !item.deleted &&
                  item.guildId === state.guildId
              )
            )
              throw new Error('Category not found')
            const channel: FakeChannel = {
              id: allocateId(),
              guildId: state.guildId,
              name: data.name,
              type: data.type,
              parentId: data.parent ?? null,
              topic: '',
              nsfw: false,
              position: channels.length,
              slowmode: 0,
              overwrites: {}
            }
            for (const overwrite of data.permissionOverwrites ?? [])
              channel.overwrites[overwrite.id] = { ViewChannel: !!overwrite.allow }
            channels.push(channel)
            return channel
          }
        )
        return channelView(created)
      },
      delete: async (id: string) =>
        operation(state, 'channel.delete', [id], () => {
          permission('ManageChannels', id)
          const index = channels.findIndex(
            (item) => item.id === id && item.guildId === state.guildId
          )
          if (index < 0) throw new Error('Channel not found')
          if (state.world) {
            for (const child of channels) if (child.parentId === id) child.parentId = null
            for (const member of state.members)
              if (member.voiceChannelId === id) delete member.voiceChannelId
          }
          if (state.world || id === state.channelId) channels[index].deleted = true
          else channels.splice(index, 1)
        })
    },
    roles: {
      get cache() {
        return roles()
      },
      everyone: { id: state.guildId },
      create: async (data: { name: string; color: number }) => {
        const role = operation(state, 'role.create', [data], () => {
          permission('ManageRoles')
          if (state.roles.length >= 50) throw new IncompleteSimulationError('Role limit exceeded')
          const role = { id: allocateId(), ...(state.world ? { position: 1 } : {}), ...data }
          state.roles.push(role)
          return role
        })
        return roleView(role)
      }
    },
    members: {
      get cache() {
        return new EntityMap(
          state.members.filter((item) => !item.kicked && !item.banned).map(memberView)
        )
      },
      me: {
        permissions: {
          has: () =>
            state.world
              ? effectivePermissions(state, PLAYGROUND_BOT_ID).has('ManageRoles')
              : !state.botPermissions ||
                state.botPermissions.includes('Administrator') ||
                state.botPermissions.includes('ManageRoles')
        }
      },
      fetch: async (id: string) => {
        const member = state.members.find((item) => item.id === id && !item.kicked && !item.banned)
        if (!member) throw new Error('Member not found')
        return memberView(member)
      }
    }
  }
  const client = {
    user: bot,
    ws: { ping: 0 },
    guilds: {
      cache: new EntityMap(
        state.world
          ? state.world.guilds.filter((item) =>
              state.world!.memberships.some(
                (member) =>
                  member.guildId === item.id &&
                  member.id === PLAYGROUND_BOT_ID &&
                  !member.kicked &&
                  !member.banned
              )
            )
          : [guild]
      )
    },
    users: {
      cache: new EntityMap(
        (state.world?.users ?? state.members).map((item) => user(item as FakeMember))
      )
    },
    channels: {
      get cache() {
        return guild.channels.cache
      }
    },
    generateInvite: () =>
      `https://discord.com/oauth2/authorize?client_id=${bot.id}&scope=bot&permissions=8`
  }
  const vm = {
    setVariable: (name: string, value: unknown) => {
      if (ctx.setVariable && typeof value === 'string' && !name.startsWith('__bcfd_'))
        ctx.setVariable(name, value)
      else ctx.script!.set(name, value)
    },
    getVariable: (name: string) => ctx.script!.get(name),
    deleteVariable: (name: string) => ctx.script!.delete(name),
    evaluate: (code: string, options: { wrapReturn?: boolean }) => {
      ctx.script!.configureEnvironment?.(state.clockMs, state.randomSeed ?? 1)
      const result = ctx.script!.evaluate(code, options)
      if (ctx.script!.randomState) state.randomSeed = ctx.script!.randomState()
      return result
    }
  }
  // The SDK-shaped views are constructed only here; neither data nor workers contain SDK objects.
  const context = {
    user: user(ctx.sender),
    member:
      ctx.event === 'dm' || !state.guildId || ctx.event === 'memberBan'
        ? undefined
        : memberView(ctx.sender),
    client,
    guild: ctx.event === 'dm' || !state.guildId ? undefined : guild,
    textChannel: channels.find((item) => item.id === state.channelId && !item.deleted)
      ? channelView(channels.find((item) => item.id === state.channelId)!)
      : undefined,
    mentionedUser: ctx.mentioned ? user(ctx.mentioned) : undefined,
    mentionedMember: ctx.mentioned ? memberView(ctx.mentioned) : undefined,
    messageEvent: { content: ctx.content },
    command: { command: ctx.trigger },
    commandId: ctx.command?.id,
    cooldown: ctx.command?.cooldown,
    cooldownType: ctx.command?.cooldownType,
    userId: ctx.sender.id,
    guildId: state.guildId,
    interactionOptions: {
      get: (name: string) =>
        ctx.options && Object.hasOwn(ctx.options, name) ? { value: ctx.options[name] } : null
    },
    get vmContext() {
      if (!ctx.script) {
        const reason = 'Script sandbox is unavailable'
        markIncomplete(state, reason)
        throw new IncompleteSimulationError(reason)
      }
      return vm
    },
    wrapEvalInIIFE: ctx.wrapEvalInIIFE
  } as unknown as BCFDContext
  const services: RuntimeServices = {
    maxOutput: 32768,
    now: () => state.clockMs,
    random: () => seededRandom(state),
    commandCount: () => state.commandCount ?? 0,
    mutualGuildCount: (_ctx, target) =>
      state.world
        ? String(
            state.world.guilds.filter((guild) =>
              [target?.id, PLAYGROUND_BOT_ID].every((id) =>
                state.world!.memberships.some(
                  (member) =>
                    member.guildId === guild.id &&
                    member.id === id &&
                    !member.kicked &&
                    !member.banned
                )
              )
            ).length
          )
        : target && state.members.some((item) => item.id === target.id)
          ? '1'
          : '0',
    cooldownRemaining: (_id, level) =>
      ctx.command ? remainingCooldown(state, ctx.command, ctx.sender.id, level) : 0,
    setStatus: (_ctx, args) => {
      const presence = parsePresence(args)
      if (!presence) return '```MISSING ARGUMENTS IN $setStatus!```'
      operation(state, 'bot.presence', args, () => {
        const activity = presence.activities[0]
        state.presence = {
          status: presence.status,
          activity: activity
            ? ({ 0: 'playing', 2: 'listening', 3: 'watching', 5: 'competing' }[activity.type] ??
              'playing')
            : 'reset',
          text: activity?.name ?? ''
        }
      })
      return ''
    },
    chat: async (prompt) => {
      ctx.trace?.push('Simulated AI: configured local response/failure; no provider call')
      const mock = state.aiMocks?.find((item) => item.prompt === prompt)
      if (state.strictMocks && !mock) {
        const reason = `Missing explicit AI mock for prompt: ${prompt}`
        markIncomplete(state, reason)
        throw new IncompleteSimulationError(reason)
      }
      return operation(state, 'ai.chat', [prompt], () =>
        mock ? (mock.error ?? mock.response ?? '') : state.ai.error || state.ai.response
      )
    },
    deleteMessage: (args) => {
      const validated = validateDeleteMessageArguments(args)
      if ('error' in validated) return validated.error
      if (!context.textChannel?.messages) return DELETE_MESSAGE_ERRORS.context
      return (async () => {
        try {
          await context.textChannel!.messages!.delete(validated.id)
          ctx.trace?.push(`Simulated deleteMessage: deleted fake channel message ${validated.id}`)
          return ''
        } catch (error) {
          return error instanceof Error ? error.message : DELETE_MESSAGE_ERRORS.missingMessage
        }
      })()
    }
  }
  return { context, registry: createFunctionRegistry(services) }
}

function incompleteLimit(state: PlaygroundState, reason: string): Error {
  markIncomplete(state, reason)
  return new IncompleteSimulationError(reason)
}
