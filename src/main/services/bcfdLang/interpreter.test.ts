import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Interpreter } from './interpreter'
import type { BCFDContext, FunctionRegistry } from './types'
import { createQuickJSScriptContext, type ScriptContext } from '../../utils/quickJsScriptContext'
import { ActivityType, Collection } from 'discord.js'

function testInterpreter(registry: FunctionRegistry): Interpreter {
  return new Interpreter(registry)
}

async function render(input: string, registry: FunctionRegistry, ctx: BCFDContext = {}) {
  return testInterpreter(registry).interpret(input, ctx)
}

describe('BCFD interpreter', () => {
  let scriptContext: ScriptContext

  beforeAll(async () => {
    scriptContext = await createQuickJSScriptContext()
  })

  afterAll(() => {
    scriptContext.dispose()
  })

  const registry: FunctionRegistry = new Map([
    ['namePlain', () => 'Ada'],
    ['truthy', () => 'true'],
    ['falsey', () => 'false'],
    ['value', () => '7'],
    ['arg0', () => 1 as unknown as string],
    ['roll', () => '1'],
    ['echo', (args) => args.join('|')],
    ['upper', (args) => args[0]?.toUpperCase() ?? ''],
    ['sum', (args) => args.reduce((total, arg) => total + Number(arg), 0).toString()]
  ])

  it('renders text, variables, function arguments, and escaped dollars', async () => {
    const result = await render('Hi $namePlain $$ $upper(ada)', registry)

    expect(result.output).toBe('Hi Ada $ ADA')
    expect(result.errors).toEqual([])
  })

  it('keeps escaped separators inside function arguments', async () => {
    const result = await render(
      String.raw`$echo(one\,two, three) $echo{left\|right|tail}`,
      registry
    )

    expect(result.output).toBe('one,two|three left|right|tail')
    expect(result.errors).toEqual([])
  })

  it('evaluates nested expressions before calling a function', async () => {
    const result = await render('$sum($value, $sum(2, 3))', registry)

    expect(result.output).toBe('12')
    expect(result.errors).toEqual([])
  })

  it('evaluates if, elseif, else, grouping, and operator precedence', async () => {
    const result = await render(
      '$if($falsey | ($value > 5 & !$truthy))bad$elseif($value >= 7 & $truthy)ok$else\nfallback$endif',
      registry
    )

    expect(result.output).toBe('ok')
    expect(result.errors).toEqual([])
  })

  it('reports a missing endif without dropping the parsed body', async () => {
    const result = await render('$if($truthy)open', registry)

    expect(result.output).toBe('open')
    expect(result.errors).toEqual([
      expect.objectContaining({ message: '$if block missing $endif' })
    ])
  })

  it('pre-resolves expressions in eval blocks without replacing strings or comments', async () => {
    const result = await render(
      '$eval\nconst text = "$namePlain";\n// $namePlain\nreturn `${$namePlain}:${text}`;\n$halt',
      registry,
      { vmContext: scriptContext }
    )

    expect(result.output).toBe('Ada:$namePlain')
    expect(result.errors).toEqual([])
    expect(scriptContext.getVariableNames().filter((key) => key.startsWith('__bcfd_'))).toEqual([])
  })

  it('exposes built-in predicate results as strings inside eval blocks', async () => {
    const result = await new Interpreter().interpret(
      '$eval\nreturn [$contains(hello, ell), $startsWith(hello, x), $endsWith(hello, lo)].map(value => value.toUpperCase()).join("|");\n$halt',
      { vmContext: scriptContext }
    )

    expect(result.output).toBe('TRUE|FALSE|TRUE')
    expect(result.errors).toEqual([])
  })

  it('uses the shared global scope and discards eval output when IIFE wrapping is disabled', async () => {
    const result = await render(
      '$eval\nvar globalEvalValue = $namePlain;\n"ignored output";\n$halt',
      registry,
      { vmContext: scriptContext, wrapEvalInIIFE: false }
    )

    expect(result.output).toBe('')
    expect(result.errors).toEqual([])
    expect(scriptContext.getVariable('globalEvalValue')).toBe('Ada')
    const laterResult = await render(
      '$eval\nvar globalEvalObserved = globalEvalValue;\n$halt',
      registry,
      { vmContext: scriptContext, wrapEvalInIIFE: false }
    )
    expect(laterResult.output).toBe('')
    expect(laterResult.errors).toEqual([])
    expect(scriptContext.getVariable('globalEvalObserved')).toBe('Ada')
    expect(scriptContext.getVariableNames().filter((key) => key.startsWith('__bcfd_'))).toEqual([])
    scriptContext.deleteVariable('globalEvalValue')
    scriptContext.deleteVariable('globalEvalObserved')
  })

  it('rejects top-level return when IIFE wrapping is disabled', async () => {
    const result = await render('$eval\nreturn "nope";\n$halt', registry, {
      vmContext: scriptContext,
      wrapEvalInIIFE: false
    })

    expect(result.output).toContain('[BCFD Error:')
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('JavaScript error:') })
    ])
  })

  it('supports Android-canonical keyword spellings and legacy desktop aliases', async () => {
    const user = { id: 'user-id', defaultAvatarURL: 'default-avatar' } as any
    const result = await new Interpreter().interpret(
      '$ID|$id|$defaultAvatar|$defaultavatar|$hour|$hours|$minute|$minutes|$second|$seconds',
      { user }
    )

    const values = result.output.split('|')
    expect(values.slice(0, 4)).toEqual(['user-id', 'user-id', 'default-avatar', 'default-avatar'])
    expect(values[4]).toBe(values[5])
    expect(values[6]).toBe(values[7])
    expect(values[8]).toBe(values[9])
    expect(result.errors).toEqual([])
  })

  it('supports the BDFD-inspired utility and time functions', async () => {
    const result = await new Interpreter().interpret(
      [
        '$wordCount(  one   two three  )',
        '$calculate(2 + 3 * 4)',
        '$calculate(2 ** 3 ** 2)',
        '$cropText(😀abc, 2, …)',
        '$linesCount(one\r\ntwo\nthree)',
        '$toTitleCase(hELLo wORLD)',
        '$numberSeparator(-1234567, _)',
        '$isBoolean(TRUE)',
        '$isBoolean(yes)',
        '$isInteger(-42)',
        '$isInteger(4.2)',
        '$isValidHex(#E67E22)',
        '$isValidHex(red)'
      ].join('|'),
      {}
    )

    expect(result.output).toBe(
      '3|14|512|😀a…|3|Hello World|-1_234_567|true|false|true|false|true|false'
    )
    expect(result.errors).toEqual([])

    const dynamic = await new Interpreter().interpret(
      '$day|$month|$year|$getTimestamp(s)|$getTimestamp(ms)|$getTimestamp(ns)|$randomString(10)',
      {}
    )
    const [day, month, year, seconds, milliseconds, nanoseconds, random] = dynamic.output.split('|')
    expect(Number(day)).toBeGreaterThanOrEqual(1)
    expect(Number(month)).toBeGreaterThanOrEqual(1)
    expect(year).toMatch(/^\d{4}$/)
    expect(seconds).toMatch(/^\d{10,}$/)
    expect(milliseconds).toMatch(/^\d{13,}$/)
    expect(nanoseconds).toMatch(/^\d{19,}$/)
    expect(random).toMatch(/^[A-Za-z0-9]{10}$/)
  })

  it('handles role and channel lookups and role mutations', async () => {
    const add = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    const deleteRole = vi.fn(async () => undefined)
    const roles = new Collection<string, any>()
    roles.set('10', {
      id: '10',
      name: '@everyone',
      rawPosition: 0,
      color: 0,
      managed: false,
      editable: false
    })
    roles.set('20', {
      id: '20',
      name: 'Member',
      rawPosition: 1,
      color: 0x123456,
      managed: false,
      editable: true,
      delete: deleteRole
    })
    roles.set('30', {
      id: '30',
      name: 'Admin',
      rawPosition: 2,
      color: 0xe67e22,
      managed: false,
      editable: true,
      delete: deleteRole
    })
    const memberRoles = new Collection<string, any>([
      ['10', roles.get('10')],
      ['20', roles.get('20')]
    ])
    const member = { manageable: true, roles: { cache: memberRoles, add, remove } }
    const create = vi.fn(async () => ({ id: 'created-role' }))
    const channels = new Collection<string, any>([
      ['channel-id', { id: 'channel-id', rawPosition: 4, rateLimitPerUser: 12 }]
    ])
    const guild = {
      id: '10',
      roles: { cache: roles, create },
      members: {
        me: { permissions: { has: () => true } },
        fetch: vi.fn(async () => member)
      },
      channels: { cache: channels }
    } as any
    const client = { channels: { cache: channels } } as any

    const lookup = await new Interpreter().interpret(
      [
        '$roleCount',
        '$roleExists(30)',
        '$findRole(admin)',
        '$roleName(20)',
        '$roleNames',
        '$getRoleColor(30)',
        '$rolePosition(30)',
        '$hasRole(user-id, 20)',
        '$userRoles(user-id)',
        '$channelExists(channel-id)',
        '$channelPosition(channel-id)',
        '$getSlowmode(channel-id)'
      ].join('|'),
      { guild, client }
    )
    expect(lookup.output).toBe(
      '3|true|30|Member|Admin, Member, @everyone|E67E22|1|true|Member|true|5|12'
    )

    const mutation = await new Interpreter().interpret(
      '$roleGrant(user-id, +30, -20)|$createRole(Blue, #123456, true, false)|$deleteRole(20)',
      { guild, client }
    )
    expect(mutation.output).toBe('true|created-role|true')
    expect(add).toHaveBeenCalledWith(['30'])
    expect(remove).toHaveBeenCalledWith(['20'])
    expect(create).toHaveBeenCalledWith({
      name: 'Blue',
      color: 0x123456,
      hoist: true,
      mentionable: false
    })
    expect(deleteRole).toHaveBeenCalled()
  })

  it('supports mutual-server counts and setStatus', async () => {
    const setPresence = vi.fn()
    const user = { id: 'user-id' } as any
    const mentionedUser = { id: 'mentioned-id' } as any
    const guilds = [
      { members: { cache: { has: (id: string) => id === 'user-id' } } },
      { members: { cache: { has: (_id: string) => true } } }
    ]
    const client = {
      guilds: {
        cache: {
          filter: (predicate: (guild: (typeof guilds)[number]) => boolean) => ({
            size: guilds.filter(predicate).length
          })
        }
      },
      user: { setPresence }
    } as any

    const result = await new Interpreter().interpret(
      '$serversSharedWithBot|$mentionedServersSharedWithBot|$setStatus{idle|watching|Tests}',
      { user, mentionedUser, client }
    )

    expect(result.output).toBe('2|1|')
    expect(setPresence).toHaveBeenCalledWith({
      status: 'idle',
      activities: [{ name: 'Tests', type: ActivityType.Watching }]
    })
    expect(result.errors).toEqual([])
  })

  it('renders mentioned member context variables', async () => {
    const joinedTimestamp = 1700000000000
    const createdTimestamp = 1600000000000
    const boostedTimestamp = 1800000000000
    const roles = [{ name: 'Admin' }, { name: 'Builder' }]
    const mentionedMember = {
      id: 'member-id',
      displayName: 'Server Ada',
      nickname: 'AdaNick',
      joinedTimestamp,
      premiumSinceTimestamp: boostedTimestamp,
      displayHexColor: '#abcdef',
      guild: { ownerId: 'owner-id' },
      displayAvatarURL: () => 'member-avatar',
      user: {
        id: 'user-id',
        tag: 'ada#0001',
        createdTimestamp,
        defaultAvatarURL: 'default-avatar'
      },
      roles: {
        cache: {
          size: roles.length,
          map: (fn: (role: { name: string }) => string) => roles.map(fn)
        }
      }
    } as any

    const result = await new Interpreter().interpret(
      [
        '$mentionedMemberEffectiveName',
        '$mentionedMemberNickname',
        '$mentionedMemberID',
        '$mentionedMemberHasTimeJoined',
        '$mentionedMemberTimeJoined',
        '$mentionedMemberTimeJoinedDiscord',
        '$mentionedMemberEffectiveAvatar',
        '$mentionedMemberEffectiveTag',
        '$mentionedMemberEffectiveID',
        '$mentionedMemberEffectiveTimeCreated',
        '$mentionedMemberEffectiveTimeCreatedDiscord',
        '$mentionedMemberEffectiveDefaultAvatar',
        '$mentionedMemberTimeBoosted',
        '$mentionedMemberTimeBoostedDiscord',
        '$mentionedMemberHasBoosted',
        '$mentionedMemberColor',
        '$mentionedMemberRoles',
        '$mentionedMemberRoleCount'
      ].join('|'),
      { mentionedMember }
    )

    expect(result.output).toBe(
      [
        'Server Ada',
        'AdaNick',
        'member-id',
        'true',
        new Date(joinedTimestamp).toLocaleString(),
        '<t:1700000000>',
        'member-avatar',
        'ada#0001',
        'user-id',
        new Date(createdTimestamp).toLocaleString(),
        '<t:1600000000>',
        'default-avatar',
        new Date(boostedTimestamp).toLocaleString(),
        '<t:1800000000>',
        'true',
        '#abcdef',
        'Admin, Builder',
        '2'
      ].join('|')
    )
    expect(result.errors).toEqual([])
  })

  it('uses empty and count defaults for missing mentioned member context', async () => {
    const result = await new Interpreter().interpret(
      '$mentionedMemberEffectiveName|$mentionedMemberRoles|$mentionedMemberRoleCount',
      {}
    )

    expect(result.output).toBe('||0')
    expect(result.errors).toEqual([])
  })

  it('does not expose the Node process through constructor escapes', async () => {
    const result = await render(
      "$eval\nreturn String.constructor('return process')();\n$halt",
      registry,
      { vmContext: scriptContext }
    )

    expect(result.output).toContain('[BCFD Error:')
    expect(result.errors).toEqual([
      expect.objectContaining({ message: expect.stringContaining('JavaScript error:') })
    ])
  })

  it('reports JavaScript eval errors with source location details', async () => {
    const result = await render(
      '$eval\nconst choice = "rock";\nreturn choice.toLower();\n$halt',
      registry,
      { vmContext: scriptContext }
    )

    expect(result.output).toContain('[BCFD Error: TypeError: "toLower" is not a function at line 2')
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('TypeError: "toLower" is not a function at line 2'),
        detail: expect.stringContaining('bcfd-eval.js'),
        lineNumber: 2,
        columnNumber: expect.any(Number),
        sourceContext: expect.stringContaining('return choice.toLower();')
      })
    ])
  })

  it('maps JavaScript error snippets to the correct eval source line after trimming', async () => {
    const result = await render(
      '$eval\nlet choice = 1; choice.toLower();\n\n  let computerChoice = ["rock", "paper", "scissors"][0];\n$halt',
      registry,
      { vmContext: scriptContext }
    )

    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('TypeError: "toLower" is not a function at line 1'),
        lineNumber: 1,
        sourceContext: expect.stringContaining('let choice = 1; choice.toLower();')
      })
    ])
    expect(result.errors[0].sourceContext).not.toContain('computerChoice')
  })

  it('maps JavaScript error snippets through pre-resolved eval expressions', async () => {
    const result = await render(
      '$eval\nlet choice = ($arg0 || "").toLower();\n\n  let computerChoice = ["rock", "paper", "scissors"][$roll];\n$halt',
      registry,
      { vmContext: scriptContext }
    )

    expect(result.errors).toEqual([
      expect.objectContaining({
        message: expect.stringContaining('TypeError: "toLower" is not a function at line 1'),
        lineNumber: 1,
        sourceContext: expect.stringContaining('let choice = ($arg0 || "").toLower();')
      })
    ])
    expect(result.errors[0].sourceContext).not.toContain('computerChoice')
  })

  it('returns the original expression and records an error for unknown functions', async () => {
    const result = await render('$missing(1, 2)', registry)

    expect(result.output).toBe('$missing(..., ...)')
    expect(result.errors).toEqual([
      expect.objectContaining({ message: "Unknown function '$missing'" })
    ])
  })
})
