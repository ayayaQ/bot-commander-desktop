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

  it('checks BCFD expressions inside eval blocks without warning for JavaScript names', () => {
    const diagnostics = lintBCFD('$eval const value = message + $notReal $halt')

    expect(diagnostics).toEqual([
      {
        severity: 'warning',
        message: 'Unknown BCFD variable "$notReal"',
        position: 30,
        length: 8,
        name: 'notReal'
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
})
