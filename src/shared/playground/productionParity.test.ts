import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { Interpreter } from '../../main/services/bcfdLang/interpreter'
import { createQuickJSScriptContext } from '../../main/utils/quickJsScriptContext'
import { decodeBCFDCommand } from '../commandCodec'
import { runMessage } from './engine'
import { createScriptSandboxFactory } from './script'
import type { ScriptSandboxFactory } from './script'
import { createPlaygroundState } from './types'

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})

function simulate(source: string) {
  const state = createPlaygroundState()
  const command = decodeBCFDCommand({
    id: 'parity',
    command: '!test',
    commandDescription: 'Parity regression',
    type: 0,
    channelMessage: source,
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {}
  }).command
  return runMessage(
    { state, commands: [command], senderId: state.members[0].id, content: '!test' },
    factory
  )
}

describe('offline playground production evaluator parity', () => {
  it.each([
    ['$set(x,old)$if(true | $set(x,new))ok$endif:$get(x)', 'ok:new'],
    ['$set(x,old)$if(false & $set(x,new))bad$else ok$endif:$get(x)', ' ok:new'],
    ['$set(x,old)$if(($set(x,left) | true) & ($set(x,right) | true))ok$endif:$get(x)', 'ok:right']
  ])('evaluates both logical operands left to right: %s', async (source, output) => {
    const vm = await createQuickJSScriptContext()
    try {
      const production = await new Interpreter().interpret(source, { vmContext: vm })
      const playground = simulate(source)
      expect(production.output).toBe(output)
      expect(playground.errors).toEqual([])
      expect(playground.state.messages.at(-1)?.content).toBe(production.output)
      expect(playground.state.variables.x).toBe(vm.getVariable('x'))
    } finally {
      vm.dispose()
    }
  })

  it('does not suppress a logical RHS failure or commit its staged state', () => {
    const state = createPlaygroundState()
    state.ai.error = 'configured failure'
    const source = '$set(x,old)$if(true | $chat(prompt))ok$endif'
    const command = decodeBCFDCommand({
      id: 'failure',
      command: '!test',
      commandDescription: 'RHS failure',
      type: 0,
      channelMessage: source,
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {}
    }).command
    const result = runMessage(
      { state, commands: [command], senderId: state.members[0].id, content: '!test' },
      factory
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('configured failure')
    expect(result.state.variables).toEqual({})
    expect(result.state.messages).toHaveLength(1)
  })

  it.each([
    ['new Date(0)', '1970-01-01T00:00:00.000Z'],
    ['new Date(NaN)', 'null'],
    ['[new Date(0), { x: 1 }, null, undefined]', '1970-01-01T00:00:00.000Z,[object Object],,'],
    ['({ toJSON() { return ["serialized", 2] } })', 'serialized,2'],
    ['({ toString() { return "custom" } })', '[object Object]']
  ])('matches production transient result serialization: %s', async (expression, output) => {
    const source = `$eval return ${expression}; $halt`
    const vm = await createQuickJSScriptContext()
    try {
      const production = await new Interpreter().interpret(source, { vmContext: vm })
      const playground = simulate(source)
      expect(production.output).toBe(output)
      expect(playground.errors).toEqual([])
      expect(playground.state.messages.at(-1)?.content).toBe(production.output)
      expect(playground.state.botState).toEqual({})
      expect(playground.state.variables).toEqual({})
    } finally {
      vm.dispose()
    }
  })
})
