import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createQuickJSScriptContext, type ScriptContext } from './quickJsScriptContext'
import { evaluate, get } from './virtual'

describe('legacy virtual helpers', () => {
  let context: ScriptContext

  beforeEach(async () => {
    context = await createQuickJSScriptContext()
  })

  afterEach(() => {
    context.dispose()
  })

  it('runs eval blocks in the global context', () => {
    expect(evaluate('$eval\nvar foo = 1; function bar() { return 2 }\n$halt', context)).toBe('')

    evaluate('$eval\nvar baz = bar()\n$halt', context)

    expect(get('foo', context)).toBe(1)
    expect(get('baz', context)).toBe(2)
  })
})
