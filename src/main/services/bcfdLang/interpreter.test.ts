import vm from 'vm'
import { describe, expect, it } from 'vitest'
import { Interpreter } from './interpreter'
import type { BCFDContext, FunctionRegistry } from './types'

function testInterpreter(registry: FunctionRegistry): Interpreter {
  return new Interpreter(registry)
}

async function render(input: string, registry: FunctionRegistry, ctx: BCFDContext = {}) {
  return testInterpreter(registry).interpret(input, ctx)
}

describe('BCFD interpreter', () => {
  const registry: FunctionRegistry = new Map([
    ['namePlain', () => 'Ada'],
    ['truthy', () => 'true'],
    ['falsey', () => 'false'],
    ['value', () => '7'],
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
    const result = await render(String.raw`$echo(one\,two, three) $echo{left\|right|tail}`, registry)

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
    const context = vm.createContext({})
    const result = await render(
      '$eval\nconst text = "$namePlain";\n// $namePlain\nreturn `${$namePlain}:${text}`;\n$halt',
      registry,
      { vmContext: context }
    )

    expect(result.output).toBe('Ada:$namePlain')
    expect(result.errors).toEqual([])
    expect(Object.keys(context).filter((key) => key.startsWith('__bcfd_'))).toEqual([])
  })

  it('returns the original expression and records an error for unknown functions', async () => {
    const result = await render('$missing(1, 2)', registry)

    expect(result.output).toBe('$missing(..., ...)')
    expect(result.errors).toEqual([
      expect.objectContaining({ message: "Unknown function '$missing'" })
    ])
  })
})
