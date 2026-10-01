import { describe, expect, it } from 'vitest'
import { decodeBCFDCommand } from '../commandCodec'
import { createPlaygroundState, PLAYGROUND_LIMITS } from './types'
import { runMessage } from './engine'
import { evaluateTemplate } from './template'

const command = (patch: Record<string, unknown> = {}) =>
  decodeBCFDCommand({
    id: 'c1',
    command: '!test',
    commandDescription: 'Test',
    type: 0,
    channelMessage: '',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command
const request = (patch: Record<string, unknown> = {}) => {
  const state = createPlaygroundState()
  return { state, commands: [command(patch)], senderId: state.members[0].id, content: '!test' }
}

describe('isolated playground message simulation', () => {
  it('supports local fake context changes and added role IDs without touching saved data', () => {
    const input = request({
      channelWhitelist: '123',
      serverWhitelist: '456',
      isNSFW: true,
      requiredRole: '789',
      channelMessage: '$channelIsNSFW'
    })
    input.state.channelId = '123'
    input.state.guildId = '456'
    input.state.nsfw = true
    input.state.roles.push({ id: '789', name: 'Saved role fixture' })
    input.state.members[0].roles.push('789')
    const result = runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[1].content).toBe('true')
    input.state.channelId = 'invalid'
    expect(() => runMessage(input)).toThrow('context')
  })

  it('resolves fake roles by raw ID, mention and case-insensitive name', () => {
    const state = createPlaygroundState(),
      ctx = { state, sender: state.members[0], content: '', trigger: '' }
    expect(evaluateTemplate('$hasRole($ID,moderator)', ctx)).toBe('true')
    expect(evaluateTemplate('$hasRole($ID,<@&200000000000000001>)', ctx)).toBe('true')
    expect(evaluateTemplate('$hasRole($ID,900000000000000001)', ctx)).toBe('true')
    expect(evaluateTemplate('$hasRole($ID,unknown)', ctx)).toBe('false')
  })

  it('includes the current guild-ID @everyone role in every member gate and role query', () => {
    for (const guildId of ['900000000000000001', '456']) {
      for (const index of [0, 1, 2]) {
        const input = request({ requiredRole: guildId, channelMessage: 'allowed' })
        input.state.guildId = guildId
        input.senderId = input.state.members[index].id
        const result = runMessage(input)
        expect(result.errors).toEqual([])
        expect(result.state.messages[1].content).toBe('allowed')
        const ctx = {
          state: input.state,
          sender: input.state.members[index],
          content: '',
          trigger: ''
        }
        expect(evaluateTemplate(`$hasRole($ID,${guildId})`, ctx)).toBe('true')
        expect(evaluateTemplate(`$hasRole($ID,<@&${guildId}>)`, ctx)).toBe('true')
        expect(evaluateTemplate('$hasRole($ID,@everyone)', ctx)).toBe('true')
        expect(evaluateTemplate('$memberRoles', ctx).split(', ')[0]).toBe('@everyone')
        expect(evaluateTemplate('$memberRoleCount', ctx)).toBe(
          String(input.state.members[index].roles.length + 1)
        )
      }
    }
  })

  it('does not duplicate an explicit @everyone fixture or retain a previous guild-ID role', () => {
    const state = createPlaygroundState()
    const sender = state.members[1]
    state.roles.push({ id: state.guildId, name: '@everyone' })
    sender.roles.push(state.guildId)
    const ctx = { state, sender, content: '', trigger: '' }
    expect(evaluateTemplate('$memberRoles|$memberRoleCount', ctx)).toBe('@everyone|1')
    state.roles.pop()
    sender.roles = []
    state.guildId = '456'
    expect(evaluateTemplate('$hasRole($ID,900000000000000001)', ctx)).toBe('false')
    expect(evaluateTemplate('$memberRoles|$memberRoleCount', ctx)).toBe('@everyone|1')
    const input = request({ requiredRole: '900000000000000001', channelMessage: 'blocked' })
    input.state.guildId = '456'
    expect(runMessage(input).state.messages).toHaveLength(1)
  })

  it('interpolates identity, nested functions, arguments and conditions using fake fixtures', () => {
    const input = request({
      startsWith: true,
      channelMessage:
        '$namePlain $sum(2,$sum(1,3)) $args(0) $if($ID == 100000000000000001)yes$else no$endif'
    })
    input.content = '!test words'
    const result = runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[1].content).toBe('Alex 6 words yes')
    expect(input.state.messages).toEqual([])
  })

  it('matches production exact, case-insensitive phrase, prefix and wildcard rules', () => {
    const input = request()
    input.commands = [
      command({ command: '!exact', channelMessage: 'exact' }),
      command({ id: '2', command: 'Word', phrase: true, channelMessage: 'phrase' }),
      command({ id: '3', command: '!pre', startsWith: true, channelMessage: 'prefix' }),
      command({ id: '4', command: '*', channelMessage: 'wild' })
    ]
    input.content = '!prefix WORD'
    expect(
      runMessage(input)
        .state.messages.slice(1)
        .map((message) => message.content)
    ).toEqual(['phrase', 'prefix', 'wild'])
  })

  it('requires fake roles/admin and respects whitelist and NSFW gates', () => {
    for (const patch of [
      { requiredRole: 'unknown' },
      { channelWhitelist: 'other' },
      { serverWhitelist: 'other' },
      { isNSFW: true }
    ]) {
      const result = runMessage(request({ channelMessage: 'blocked', ...patch }))
      expect(result.state.messages).toHaveLength(1)
      expect(result.trace.some((line) => /Skipped|Blocked/.test(line))).toBe(true)
    }
    const input = request({ isAdmin: true, channelMessage: 'blocked' })
    input.senderId = input.state.members[1].id
    expect(runMessage(input).state.messages).toHaveLength(1)
  })

  it('toggles roles on the invoker, not the mentioned moderation target', () => {
    const input = request({ isKick: true, roleToAssign: '200000000000000002' })
    input.content += ` <@${input.state.members[1].id}>`
    const result = runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.state.members[0].roles).toContain('200000000000000002')
    expect(result.state.members[1].roles).toEqual([])
    expect(result.state.members[1].kicked).toBe(true)
  })

  it.each(['isKick', 'isBan', 'isVoiceMute'])(
    'simulates %s only with permission and exact moderation syntax',
    (flag) => {
      const input = request({ [flag]: true })
      input.content += ` <@${input.state.members[1].id}>`
      const key = flag === 'isKick' ? 'kicked' : flag === 'isBan' ? 'banned' : 'muted'
      expect(runMessage(input).state.members[1][key]).toBe(true)
      input.state.members[0].permissions = []
      const result = runMessage(input)
      expect(result.errors[0]).toContain('permission')
      expect(result.state.members[1][key]).toBe(false)
    }
  )

  it('emits fake replies, DMs and inert embed URLs, with no input mutation', () => {
    const input = request({
      channelMessage: 'reply',
      channelMessageAsReply: true,
      privateMessage: 'DM $namePlain',
      channelEmbed: { title: '$namePlain', imageURL: 'https://example.invalid/image.png' }
    })
    const result = runMessage(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[1].replyTo).toBe(1)
    expect(result.state.messages[2]).toMatchObject({
      kind: 'dm',
      recipient: input.senderId,
      content: 'DM Alex'
    })
    expect(result.state.messages[3].embed?.imageURL).toBe('https://example.invalid/image.png')
    expect(input.state.nextId).toBe(1)
  })

  it('deletes only fake channel messages and preserves fake DMs', () => {
    const input = request({ deleteNum: 2 })
    input.state.messages = [
      { id: 1, author: 'Bot', kind: 'dm', content: 'private' },
      { id: 2, author: 'Sam', kind: 'user', content: 'old' }
    ]
    input.state.nextId = 3
    const result = runMessage(input)
    expect(result.state.messages.map((message) => !!message.deleted)).toEqual([false, true, true])
  })

  it.each([
    '$eval while(true){} $halt',
    '$set(x,1)',
    '$get(x)',
    '$ai(hello)',
    '$roleGrant(1,2)',
    '$createChannel(foo)',
    '$unknown',
    '$if(false)$eval return 1 $halt$else safe$endif'
  ])('fails closed on held or unsupported effects: %s', (template) => {
    const input = request({
      channelMessage: 'would send',
      privateMessage: template,
      roleToAssign: '200000000000000002',
      deleteAfter: true
    })
    const result = runMessage(input)
    expect(result.errors).toHaveLength(1)
    expect(result.state.messages).toHaveLength(1)
    expect(result.state.messages[0].deleted).toBeUndefined()
    expect(result.state.members[0].roles).toEqual(input.state.members[0].roles)
  })

  it('does not run scripts, held cooldowns, reactions or unknown destinations', () => {
    for (const patch of [{ cooldown: 5 }, { reaction: 'emoji' }, { specificChannel: 'outside' }]) {
      const result = runMessage(request({ channelMessage: 'not sent', ...patch }))
      expect(result.errors).toHaveLength(1)
      expect(result.state.messages).toHaveLength(1)
    }
  })

  it('bounds inputs, command count, transcript size, templates and amplified outputs', () => {
    const input = request()
    expect(() =>
      runMessage({ ...input, content: 'a'.repeat(PLAYGROUND_LIMITS.input + 1) })
    ).toThrow('limit')
    expect(() =>
      runMessage({
        ...input,
        commands: Array.from({ length: PLAYGROUND_LIMITS.commands + 1 }, () => command())
      })
    ).toThrow('limit')
    input.state.messages = Array.from({ length: PLAYGROUND_LIMITS.messages }, (_, index) => ({
      id: index + 1,
      author: 'Sam',
      kind: 'user' as const,
      content: ''
    }))
    expect(() => runMessage(input)).toThrow('limit')
    const state = createPlaygroundState()
    const ctx = { state, sender: state.members[0], content: '', trigger: '' }
    expect(() => evaluateTemplate('x'.repeat(PLAYGROUND_LIMITS.template + 1), ctx)).toThrow('limit')
    expect(() =>
      evaluateTemplate(`$replace(${'a'.repeat(100)},a,${'b'.repeat(1000)})`, ctx)
    ).toThrow('limit')
    expect(() => evaluateTemplate('$upper('.repeat(100) + 'x' + ')'.repeat(100), ctx)).toThrow(
      'nesting'
    )
    expect(() =>
      evaluateTemplate(`$replace($replace(aaa,a,${'b'.repeat(6000)}),b,${'c'.repeat(6000)})`, ctx)
    ).toThrow('limit')
  })
})
