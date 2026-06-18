import { describe, expect, it } from 'vitest'
import { lintBCFD } from './bcfdLint'

describe('lintBCFD', () => {
  it('warns for unknown variables and functions', () => {
    const diagnostics = lintBCFD('$notReal and $alsoNotReal(values)')

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$notReal"',
        position: 0,
        length: 8,
        name: 'notReal'
      },
      {
        severity: 'warning',
        message: 'Unknown BCFD function "$alsoNotReal"',
        position: 13,
        length: 12,
        name: 'alsoNotReal'
      }
    ])
  })

  it('does not warn for known variables, functions, and keywords', () => {
    const diagnostics = lintBCFD('$name $if($contains($message, hi))Hello$endif')

    expect(diagnostics).toEqual([])
  })

  it('does not warn for interpreter-supported names missing from autocomplete', () => {
    const diagnostics = lintBCFD(
      '$upper($namePlain) $serverID $memberColor $cooldownRemaining(user)'
    )

    expect(diagnostics).toEqual([])
  })

  it('finds unknown names nested inside function arguments', () => {
    const diagnostics = lintBCFD('$contains($notReal, value)')

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$notReal"',
        position: 10,
        length: 8,
        name: 'notReal'
      }
    ])
  })

  it('ignores escaped dollar signs', () => {
    const diagnostics = lintBCFD('Price $$notReal and $name')

    expect(diagnostics).toEqual([])
  })

  it('checks BCFD expressions and JavaScript variables inside eval blocks', () => {
    const diagnostics = lintBCFD('$eval const value = message + $notReal $halt')

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$notReal"',
        position: 30,
        length: 8,
        name: 'notReal'
      },
      {
        severity: 'warning',
        message: 'Undeclared JavaScript variable "message"',
        position: 20,
        length: 7,
        name: 'message'
      }
    ])
  })

  it('does not warn for BCFD-looking names inside JavaScript string literals', () => {
    const diagnostics = lintBCFD(
      '$eval const value = "$notReal"; const other = \'$alsoFake\' $halt'
    )

    expect(diagnostics).toEqual([])
  })

  it('warns for BCFD-looking identifiers in JavaScript mode', () => {
    const input = 'let x = $fakeBCFDVariable;'
    const diagnostics = lintBCFD(input, { mode: 'js' })

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$fakeBCFDVariable"',
        position: input.indexOf('$fakeBCFDVariable'),
        length: '$fakeBCFDVariable'.length,
        name: 'fakeBCFDVariable'
      }
    ])
  })

  it('does not warn for BCFD-looking text in JavaScript comments or raw template text', () => {
    const diagnostics = lintBCFD('const x = `$fake text`; // $alsoFake', { mode: 'js' })

    expect(diagnostics).toEqual([])
  })

  it('warns for BCFD-looking identifiers in JavaScript template interpolation', () => {
    const input = 'const x = `${$fakeBCFDVariable}`'
    const diagnostics = lintBCFD(input, { mode: 'js' })

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$fakeBCFDVariable"',
        position: input.indexOf('$fakeBCFDVariable'),
        length: '$fakeBCFDVariable'.length,
        name: 'fakeBCFDVariable'
      }
    ])
  })

  it('continues scanning after nested braces in JavaScript template interpolation', () => {
    const input = 'const x = `${{ value: "$ignored" }} ${$fakeBCFDVariable}`'
    const diagnostics = lintBCFD(input, { mode: 'js' })

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$fakeBCFDVariable"',
        position: input.indexOf('$fakeBCFDVariable'),
        length: '$fakeBCFDVariable'.length,
        name: 'fakeBCFDVariable'
      }
    ])
  })

  it('reports JavaScript syntax errors', () => {
    const input = '$eval const value = "unterminated\n$halt'
    const diagnostics = lintBCFD(input)

    expect(diagnostics).toEqual([
      {
        severity: 'error',
        message: expect.stringContaining('JavaScript syntax error:'),
        position: input.indexOf('"'),
        length: 1,
        name: 'javascript'
      }
    ])
  })

  it('warns for undeclared JavaScript variables in eval blocks', () => {
    const input = '$eval const local = 1; return local + missing + botState.count; $halt'
    const diagnostics = lintBCFD(input)

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Undeclared JavaScript variable "missing"',
        position: input.indexOf('missing'),
        length: 'missing'.length,
        name: 'missing'
      }
    ])
  })

  it('allows JavaScript variables declared in for loop headers', () => {
    const diagnostics = lintBCFD(
      '$eval for (let i = 0; i < 3; i++) { debug(i) } for (const item of [1, 2]) { debug(item) } $halt'
    )

    expect(diagnostics).toEqual([])
  })

  it('keeps JavaScript var declarations visible after inner blocks', () => {
    const diagnostics = lintBCFD('$eval if (true) { var token = 1 } token $halt')

    expect(diagnostics).toEqual([])
  })

  it('allows globals declared by startup JavaScript', () => {
    const diagnostics = lintBCFD('$eval return formatName(savedPrefix); $halt', {
      startupJs: 'const savedPrefix = "!"; function formatName(value) { return value }'
    })

    expect(diagnostics).toEqual([])
  })

  it('does not use invalid startup JavaScript as an allow list', () => {
    const input = '$eval return savedPrefix; $halt'
    const diagnostics = lintBCFD(input, {
      startupJs: 'const savedPrefix = '
    })

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Undeclared JavaScript variable "savedPrefix"',
        position: input.indexOf('savedPrefix'),
        length: 'savedPrefix'.length,
        name: 'savedPrefix'
      }
    ])
  })

  it('allows app and standard JavaScript globals', () => {
    const diagnostics = lintBCFD(
      '$eval debug(JSON.stringify({ now: Date.now(), count: botState.count || 0 })); $halt'
    )

    expect(diagnostics).toEqual([])
  })

  it('does not report BCFD placeholders as undeclared JavaScript variables', () => {
    const diagnostics = lintBCFD(
      '$eval const user = $namePlain; return `${user}:${$args(0)}`; $halt'
    )

    expect(diagnostics).toEqual([])
  })

  it('checks undeclared variables inside class methods', () => {
    const input = '$eval class Example { value() { return missingValue } } $halt'
    const diagnostics = lintBCFD(input)

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Undeclared JavaScript variable "missingValue"',
        position: input.indexOf('missingValue'),
        length: 'missingValue'.length,
        name: 'missingValue'
      }
    ])
  })

  it('does not recurse forever on unsupported expression nodes', () => {
    const diagnostics = lintBCFD('$eval function f() { return new.target } $halt')

    expect(diagnostics).toEqual([])
  })
})
