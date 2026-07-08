import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Interpreter } from './interpreter'
import type { BCFDContext, FunctionRegistry } from './types'
import { createQuickJSScriptContext, type ScriptContext } from '../../utils/quickJsScriptContext'

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
