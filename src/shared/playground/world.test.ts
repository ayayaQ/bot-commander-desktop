import { describe, expect, it } from 'vitest'
import { decodeBCFDCommand } from '../commandCodec'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { snapshotInteractions } from './snapshots'
import { createPlaygroundState } from './types'
import {
  normalizeWorld,
  selectWorldContext,
  effectivePermissions,
  dmChannel,
  PLAYGROUND_BOT_ID,
  assertEditableRole,
  assertManageable
} from './world'
import {
  validateAgentValidationState,
  validateAgentValidationSuite
} from './agentValidationFixtures'
import { runAgentValidation } from './agentValidation'
import type { AgentValidationSuite } from '../agentValidationTypes'

const A = '900000000000000001',
  B = '900000000000000010'
const CA = '900000000000000002',
  CB = '900000000000000011'
const USER = '100000000000000002',
  OWNER = '100000000000000001'
const ROLE = '200000000000000001',
  ROLE_B = '200000000000000010'
const command = (patch = {}) =>
  decodeBCFDCommand({
    id: 'candidate',
    command: '!test',
    commandDescription: 'test',
    type: 0,
    channelMessage: 'ok',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command

function twoGuilds() {
  const state = normalizeWorld()
  const world = state.world!
  world.guilds.push({ id: B, name: 'Second guild', ownerId: OWNER })
  world.channels.push({ ...structuredClone(world.channels[0]), id: CB, guildId: B })
  world.roles.push(
    {
      id: B,
      guildId: B,
      name: '@everyone',
      position: 0,
      permissions: ['ViewChannel', 'SendMessages', 'AddReactions', 'ReadMessageHistory']
    },
    {
      id: ROLE_B,
      guildId: B,
      name: 'Second moderator',
      position: 10,
      permissions: ['Administrator']
    }
  )
  world.memberships.push(
    ...world.memberships
      .filter((member) => [OWNER, USER, PLAYGROUND_BOT_ID].includes(member.id))
      .map((member) => ({
        ...structuredClone(member),
        guildId: B,
        roles: member.id === PLAYGROUND_BOT_ID ? [ROLE_B] : [],
        permissions: []
      }))
  )
  selectWorldContext(state, { guildId: A, channelId: CA })
  return state
}

describe('normalized multi-guild world', () => {
  it('runs one suite with the same user and different memberships without leaking role changes', async () => {
    const state = twoGuilds()
    const suite: AgentValidationSuite = {
      version: 3,
      cases: [
        {
          name: 'isolation',
          state,
          steps: [
            {
              kind: 'message',
              senderId: USER,
              context: { guildId: A, channelId: CA },
              content: '!test',
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/state/members/1/roles', equals: [ROLE] },
                { path: '/effects/messages/0/content', equals: 'ok' }
              ]
            },
            {
              kind: 'message',
              senderId: USER,
              context: { guildId: B, channelId: CB },
              content: '!test',
              assertions: [
                { path: '/outcome', equals: 'error' },
                { path: '/errors/0', equals: `!test: Unknown fake role: ${ROLE}` },
                { path: '/effects/messages/0/channelId', equals: CB },
                { path: '/state/members/1/roles', equals: [] },
                { path: '/effects/messages/0/content', equals: 'ok' }
              ]
            },
            {
              kind: 'message',
              senderId: USER,
              context: { guildId: A, channelId: CA },
              content: '!test',
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/state/members/1/roles', equals: [] },
                { path: '/effects/messages/0/content', equals: 'ok' }
              ]
            }
          ]
        }
      ]
    }
    const report = await runAgentValidation({
      candidateKind: 'command',
      candidate: command({ roleToAssign: ROLE }),
      candidateHash: 'candidate',
      fixtureHash: 'world',
      baseRevision: null,
      wrapEvalInIIFE: true,
      suite
    })
    expect(report.outcome).toBe('passed')
    expect(
      state.world!.memberships.find((member) => member.id === USER && member.guildId === A)!.roles
    ).toEqual([])
  })

  it('isolates channel lookups, message deletion, and purge across guilds', async () => {
    let state = twoGuilds()
    const first = await runMessage({
      state,
      commands: [command()],
      senderId: OWNER,
      content: '!test'
    })
    state = first.state
    const messageId = state.messages.at(-1)!.id
    const other = await runMessage({
      state,
      commands: [command({ channelMessage: `$deleteMessage(${messageId})` })],
      senderId: OWNER,
      content: '!test',
      context: { guildId: B, channelId: CB }
    })
    expect(other.state.messages.at(-1)!.content).toContain('not found in the current channel')
    expect(other.state.messages.find((message) => message.id === messageId)!.deleted).not.toBe(true)
    const purge = await runMessage({
      state: other.state,
      commands: [command({ deleteNum: 100 })],
      senderId: OWNER,
      content: '!test',
      context: { guildId: B, channelId: CB }
    })
    expect(
      purge.state.messages
        .filter((message) => message.channelId === CA)
        .every((message) => !message.deleted)
    ).toBe(true)
    const destination = await runMessage({
      state,
      commands: [command({ specificChannel: CB })],
      senderId: OWNER,
      content: '!test'
    })
    expect(destination.errors[0]).toContain('Destination channel not found in the current guild')
    const channel = await runMessage({
      state,
      commands: [command({ channelMessage: `$setChannelName(${CB},bad)` })],
      senderId: OWNER,
      content: '!test'
    })
    expect(channel.state.world!.channels.find((item) => item.id === CB)!.name).toBe('playground')
    expect(channel.state.messages.at(-1)!.content).toContain('not found')
  })

  it('rejects mismatched guild/channel contexts and nonmembers, and gives DMs no guild membership', async () => {
    const state = twoGuilds()
    await expect(
      runMessage({
        state,
        commands: [],
        senderId: USER,
        content: '',
        context: { guildId: B, channelId: CA }
      })
    ).rejects.toThrow('does not belong')
    await expect(
      runMessage({
        state,
        commands: [],
        senderId: state.members[2].id,
        content: '',
        context: { guildId: B, channelId: CB }
      })
    ).rejects.toThrow('not a member')
    const dm = dmChannel(state, USER)
    const result = await runMessage({
      state,
      commands: [command({ type: 1, channelMessage: '$serverID:$userID' })],
      senderId: USER,
      kind: 'dm',
      content: '!test',
      context: { guildId: null, channelId: dm.id }
    })
    expect(result.errors).toEqual([])
    expect(result.state.guildId).toBe('')
    expect(result.state.members[0].roles).toEqual([])
    expect(result.state.messages.at(-1)!.guildId).toBeNull()
    expect(result.state.messages.at(-1)!.channelId).toBe(dm.id)
    expect(() =>
      validateAgentValidationState(JSON.parse(JSON.stringify(result.state)))
    ).not.toThrow()
  })

  it('applies everyone, aggregate role allow/deny, then member overwrites; owner/admin bypass', () => {
    const state = twoGuilds()
    const world = state.world!
    const member = world.memberships.find((member) => member.id === USER && member.guildId === A)!
    member.roles = state.roles
      .filter((role) => role.id !== A && role.name !== 'Playground Bot')
      .map((role) => role.id)
    const channel = world.channels[0]
    channel.overwrites = {
      [A]: { SendMessages: false },
      [member.roles[0]]: { SendMessages: false },
      [member.roles[1]]: { SendMessages: true }
    }
    selectWorldContext(state, { guildId: A, channelId: CA })
    expect(effectivePermissions(state, USER, CA).has('SendMessages')).toBe(true)
    channel.overwrites[USER] = { SendMessages: false }
    expect(effectivePermissions(state, USER, CA).has('SendMessages')).toBe(false)
    channel.overwrites[USER] = { SendMessages: true, ViewChannel: false }
    expect(effectivePermissions(state, USER, CA).has('SendMessages')).toBe(false)
    expect(effectivePermissions(state, OWNER, CA).has('SendMessages')).toBe(true)
    expect(effectivePermissions(state, PLAYGROUND_BOT_ID, CA).has('SendMessages')).toBe(true)
  })

  it('enforces bot overwrites on send and own/other message deletion', async () => {
    const state = twoGuilds()
    const botRole = state.world!.roles.find((role) => role.name === 'Playground Bot')!
    botRole.permissions = ['ViewChannel', 'SendMessages']
    state.world!.channels[0].overwrites[PLAYGROUND_BOT_ID] = { SendMessages: false }
    const denied = await runMessage({
      state,
      commands: [command()],
      senderId: USER,
      content: '!test'
    })
    expect(denied.errors).toEqual(['!test: Missing bot SendMessages permission'])
    delete state.world!.channels[0].overwrites[PLAYGROUND_BOT_ID]
    const sent = await runMessage({
      state,
      commands: [command()],
      senderId: USER,
      content: '!test'
    })
    const own = sent.state.messages.at(-1)!.id,
      incoming = sent.state.messages[0].id
    const deletion = await runMessage({
      state: sent.state,
      commands: [command({ channelMessage: `$deleteMessage(${own})$deleteMessage(${incoming})` })],
      senderId: USER,
      content: '!test'
    })
    expect(deletion.state.messages.find((message) => message.id === own)!.deleted).toBe(true)
    expect(deletion.state.messages.find((message) => message.id === incoming)!.deleted).not.toBe(
      true
    )
    expect(deletion.state.messages.at(-1)!.content).toContain('ManageMessages')
  })

  it('enforces hierarchy even for an administrator and respects managed/editable restrictions', async () => {
    const state = twoGuilds()
    const role = state.roles.find((role) => role.id === ROLE)!
    role.position = 100
    expect(() => assertEditableRole(state, ROLE)).toThrow('hierarchy')
    role.position = 1
    role.managed = true
    expect(() => assertEditableRole(state, ROLE)).toThrow('managed')
    role.managed = false
    role.editable = false
    expect(() => assertEditableRole(state, ROLE)).toThrow('editable')
    expect(() => assertManageable(state, state.members[0])).toThrow('guild owner')
    const target = state.world!.memberships.find(
      (member) => member.id === USER && member.guildId === A
    )!
    target.roles = [ROLE]
    role.position = 101
    const result = await runMessage({
      state,
      commands: [command({ isKick: true })],
      senderId: OWNER,
      content: `!test <@${USER}>`
    })
    expect(result.errors[0]).toContain('role hierarchy')
    expect(result.state.members.find((member) => member.id === USER)!.kicked).toBe(false)
  })

  it('round trips large string IDs through fixtures, buttons, reactions and replay reports', async () => {
    const state = twoGuilds()
    const interactions = snapshotInteractions([
      {
        id: 'candidate',
        commandName: 'test',
        options: [],
        rootAction: {
          sendChannelMessage: true,
          channelMessage: 'button',
          buttons: [
            {
              customId: 'go',
              label: 'go',
              style: 1,
              action: { sendChannelMessage: true, channelMessage: 'clicked' }
            }
          ]
        }
      }
    ])
    const slash = await runInteraction({
      state,
      interactions,
      kind: 'slash',
      senderId: USER,
      commandId: 'candidate'
    })
    expect(slash.errors).toEqual([])
    const id = slash.state.messages.at(-1)!.id
    expect(typeof id).toBe('string')
    expect(BigInt(id)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    const serialized = JSON.parse(JSON.stringify(slash.state))
    expect(validateAgentValidationState(serialized).messages.at(-1)!.id).toBe(id)
    const button = await runInteraction({
      state: serialized,
      interactions,
      kind: 'button',
      senderId: USER,
      messageId: id,
      customId: 'go'
    })
    expect(button.state.messages.at(-1)!.content).toBe('clicked')
    const denied = await runInteraction({
      state: serialized,
      interactions,
      kind: 'button',
      senderId: USER,
      messageId: id,
      customId: 'go',
      context: { guildId: B, channelId: CB }
    })
    expect(denied.errors[0]).toContain('unavailable')
    const suite: AgentValidationSuite = {
      version: 3,
      cases: [
        {
          name: 'reaction',
          state: serialized,
          steps: [
            {
              kind: 'reaction',
              senderId: USER,
              context: { guildId: A, channelId: CA },
              messageId: id,
              content: 'yes',
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/effects/messages/0/content', equals: 'ok' },
                { path: '/state/messages/0/id', equals: id }
              ]
            }
          ]
        }
      ]
    }
    const request = {
      candidateKind: 'command' as const,
      candidate: command({ type: 5, command: 'yes', specificMessage: String(id) }),
      candidateHash: 'candidate',
      fixtureHash: 'world',
      baseRevision: null,
      wrapEvalInIIFE: true,
      suite
    }
    const report = await runAgentValidation(request)
    expect(report.outcome).toBe('passed')
    expect(await runAgentValidation(JSON.parse(JSON.stringify(request)))).toEqual(report)
  })

  it('retains v2 numeric IDs and offers an explicit string migration without rounding', async () => {
    const legacy = await runMessage({
      state: createPlaygroundState(),
      commands: [command()],
      senderId: USER,
      content: '!test'
    })
    expect(legacy.state.messages[0].id).toBe(1)
    const normalized = normalizeWorld(legacy.state)
    expect(normalized.messages.map((message) => message.id)).toEqual(['1', '2'])
    expect(() => validateAgentValidationState(JSON.parse(JSON.stringify(normalized)))).not.toThrow()
    normalized.messages[0].id = 9007199254740992
    expect(() => validateAgentValidationState(JSON.parse(JSON.stringify(normalized)))).toThrow(
      'string ID'
    )
  })

  it.each(['membership', 'parent', 'overwrite', 'message', 'role'])(
    'rejects invalid %s references',
    (kind) => {
      const state = twoGuilds()
      if (kind === 'membership') state.world!.memberships[0].roles = [ROLE_B]
      if (kind === 'parent') state.world!.channels[0].parentId = CB
      if (kind === 'overwrite')
        state.world!.channels[0].overwrites[ROLE_B] = { SendMessages: false }
      if (kind === 'role') state.world!.roles[0].guildId = '99'
      if (kind === 'message')
        state.messages.push({
          id: '18446744073709551615',
          kind: 'bot',
          author: 'Playground Bot',
          authorId: PLAYGROUND_BOT_ID,
          content: '',
          channelId: CB,
          guildId: A
        })
      expect(() => validateAgentValidationState(state)).toThrow()
    }
  )

  it('preserves maximum snowflakes and rejects cross-channel replies before emitting a message', async () => {
    const state = twoGuilds()
    const id = '18446744073709551615'
    state.messages.push({
      id,
      kind: 'bot',
      author: 'Playground Bot',
      authorId: PLAYGROUND_BOT_ID,
      content: 'old',
      channelId: CA,
      guildId: A
    })
    expect(validateAgentValidationState(JSON.parse(JSON.stringify(state))).messages[0].id).toBe(id)
    const second = { ...structuredClone(state.world!.channels[0]), id: '900000000000000012' }
    state.world!.channels.push(second)
    const result = await runMessage({
      state,
      commands: [command({ specificChannel: second.id, channelMessageAsReply: true })],
      senderId: USER,
      content: '!test'
    })
    expect(result.errors[0]).toContain('Reply target not found in the destination channel')
    expect(result.state.messages.filter((message) => message.kind === 'bot')).toHaveLength(1)
  })

  it('deletes an owned DM message without allowing deletion of the recipient message', async () => {
    const state = twoGuilds()
    const dm = dmChannel(state, USER)
    state.messages.push({
      id: '9223372036854775808',
      kind: 'dm',
      author: 'Playground Bot',
      authorId: PLAYGROUND_BOT_ID,
      content: 'old',
      channelId: dm.id,
      guildId: null,
      recipient: USER
    })
    const result = await runMessage({
      state,
      commands: [command({ type: 1, channelMessage: '$deleteMessage(9223372036854775808)' })],
      senderId: USER,
      kind: 'dm',
      content: '!test',
      context: { guildId: null, channelId: dm.id }
    })
    expect(result.state.messages[0].deleted).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('requires explicit contexts in v3 suites', () => {
    expect(() =>
      validateAgentValidationSuite({
        version: 3,
        cases: [
          {
            name: 'case',
            state: twoGuilds(),
            steps: [{ kind: 'message', senderId: USER, content: '!test', assertions: [] }]
          }
        ]
      })
    ).toThrow('step.context')
  })
})

describe('normalized role creation', () => {
  it.each([
    { template: '$createRole(NewRole,#112233)', hoist: false, mentionable: false },
    { template: '$createRole(NewRole,#112233,true,true)', hoist: true, mentionable: true }
  ])(
    'preserves role flags and accepts the next event: $template',
    async ({ template, hoist, mentionable }) => {
      const state = normalizeWorld()
      const first = await runMessage({
        state,
        commands: [command({ channelMessage: template })],
        senderId: USER,
        content: '!test'
      })
      expect(first.errors).toEqual([])
      const role = first.state.world!.roles.find((item) => item.name === 'NewRole')!
      expect(role).toMatchObject({ hoist, mentionable, color: 0x112233 })
      const serialized = JSON.parse(JSON.stringify(first.state))
      expect(() => validateAgentValidationState(serialized)).not.toThrow()
      const next = await runMessage({
        state: serialized,
        commands: [command()],
        senderId: USER,
        content: '!test'
      })
      expect(next.errors).toEqual([])
      expect(next.state.messages.at(-1)!.content).toBe('ok')
      expect(next.state.world!.roles.find((item) => item.id === role.id)).toEqual(role)
    }
  )

  it.each(['hoist', 'mentionable'])('rejects a non-boolean role %s flag', (flag) => {
    const state = normalizeWorld()
    Object.assign(state.world!.roles[0], { [flag]: 'true' })
    expect(() => validateAgentValidationState(state)).toThrow(`role.${flag}`)
  })
})
