import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import { Interpreter } from '../../main/services/bcfdLang/interpreter'
import { createQuickJSScriptContext } from '../../main/utils/quickJsScriptContext'
import type { BCFDInteractionAction, BCFDInteractionCommand } from '../../main/types/types'
import { decodeBCFDCommand } from '../commandCodec'
import { commandEvents, type CommandEvent } from '../runtime/dispatch'
import { runInteractionActions, runTraditionalActions } from '../runtime/actions'
import { commitsTemplate, deliverInteractionDM } from '../runtime/errors'
import { createScriptSandboxFactory, type ScriptSandboxFactory } from './script'
import { createScriptSession } from './scriptSession'
import { createPlaygroundState } from './types'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { evaluateTemplate } from './template'
import { executionContext } from './executionContext'
import { runAgentValidation } from './agentValidation'

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})
const command = (source: string, patch = {}) =>
  decodeBCFDCommand({
    id: 'candidate',
    command: '!test',
    commandDescription: 'Parity',
    type: 0,
    channelMessage: source,
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command
const action = (source: string, dm: string): BCFDInteractionAction => ({
  sendChannelMessage: true,
  channelMessage: source,
  sendPrivateMessage: true,
  privateMessage: dm,
  sendChannelEmbed: false,
  channelEmbed: command('').channelEmbed,
  sendPrivateEmbed: false,
  privateEmbed: command('').privateEmbed,
  isRoleAssigner: true,
  roleToAssign: '200000000000000002',
  isKick: false,
  isBan: false,
  isVoiceMute: false,
  targetUserOptionName: '',
  deleteX: false,
  deleteNum: 0,
  ephemeral: false,
  deferReply: false,
  buttons: []
})

// Production interpreter, production QuickJS context and shared dispatch. Delivery ports are
// inert recording adapters; production's template transaction policy is applied per render.
async function liveHarness(
  event: CommandEvent | 'slash' | 'button',
  source: string,
  dm: string,
  failDM: boolean
) {
  const vm = await createQuickJSScriptContext({ initialContext: { botState: { count: 0 } } })
  const output: string[] = [],
    operations: string[] = [],
    errors: string[] = [],
    diagnostics: string[] = [],
    warnings: string[] = []
  let queue: Promise<unknown> = Promise.resolve()
  const render = (source: string) => {
    const result = queue.then(async () => {
      const checkpoint = vm.checkpointVariable('botState')
      try {
        const result = await new Interpreter().interpret(source, { vmContext: vm })
        diagnostics.push(...result.errors.map((error) => error.message))
        if (!commitsTemplate(result)) checkpoint.restore()
        return result.output
      } catch (error) {
        checkpoint.restore()
        throw error
      } finally {
        checkpoint.dispose()
      }
    })
    queue = result.catch(() => {})
    return result
  }
  const send = (name: string, content: string) => {
    operations.push(name)
    if (name === 'message.dm' && failDM) throw new Error('DMs disabled')
    output.push(content)
  }
  const response = async () => send('message.send', await render(source))
  const privateMessage = async () => {
    const content = await render(dm)
    if (event === 'slash' || event === 'button')
      await deliverInteractionDM(
        () => send('message.dm', content),
        () => warnings.push('DMs disabled')
      )
    else send('message.dm', content)
  }
  let role = false
  const assign = () => {
    operations.push('member.roles.toggle')
    role = true
  }
  try {
    if (event === 'slash' || event === 'button')
      await runInteractionActions({ response, dm: privateMessage, role: assign })
    else {
      const pending: Promise<unknown>[] = []
      await runTraditionalActions(
        { message: response, dm: privateMessage },
        (task) => {
          pending.push(task.catch((error) => errors.push(error.message)))
        },
        event
      )
      await Promise.all(pending)
    }
    return {
      output,
      operations,
      errors,
      diagnostics,
      warnings,
      role,
      state: JSON.parse(vm.serializeVariable('botState'))
    }
  } finally {
    vm.dispose()
  }
}

describe('live/synthetic failure parity matrix', () => {
  for (const event of [...commandEvents, 'slash', 'button'] as const) {
    it.each(['diagnostic', 'DM rejection'] as const)(
      `${event}: %s preserves output, order and template commits`,
      async (scenario) => {
        const source = '$eval botState.count++; $haltfirst'
        const dm =
          scenario === 'diagnostic'
            ? '$eval botState.count = 99; throw new Error("bad eval"); $halt'
            : '$eval botState.count++; $haltprivate'
        const expected = await liveHarness(event, source, dm, scenario === 'DM rejection')
        const state = createPlaygroundState()
        state.botState = { count: 0 }
        if (scenario === 'DM rejection') state.failures = { 'message.dm': 'DMs disabled' }
        const senderId = state.members[0].id
        let result
        if (event === 'slash' || event === 'button') {
          const saved: BCFDInteractionCommand = {
            id: 'candidate',
            commandName: 'test',
            commandDescription: 'Parity',
            options: [],
            isRegistered: false,
            rootAction: action(source, dm)
          }
          if (event === 'button') {
            const button = {
              customId: 'go',
              label: 'Go',
              style: 1 as const,
              disabled: false,
              action: action(source, dm)
            }
            saved.rootAction.buttons = [button]
            state.messages = [
              { id: 1, kind: 'bot', author: 'Bot', content: 'Button', buttons: [button] }
            ]
            state.nextId = 2
          }
          result = await runInteraction(
            {
              kind: event,
              state,
              senderId,
              interactions: [saved],
              commandId: saved.id,
              messageId: 1,
              customId: 'go'
            },
            factory
          )
        } else {
          if (event === 'reaction') {
            state.messages = [{ id: 1, kind: 'user', author: 'Alex', content: 'original' }]
            state.nextId = 2
          }
          result = await runMessage(
            {
              kind: event,
              state,
              senderId,
              content: '!test',
              messageId: 1,
              commands: [
                command(source, { type: commandEvents.indexOf(event), privateMessage: dm })
              ]
            },
            factory
          )
        }
        const output = result.state.messages
          .filter((message) => message.kind !== 'user' && message.id >= state.nextId)
          .map((message) => message.content)
        expect(output).toEqual(expected.output)
        expect(result.state.operations?.map((item) => item.name)).toEqual(expected.operations)
        expect(result.state.botState).toEqual(expected.state)
        expect(result.diagnostics).toEqual(expected.diagnostics)
        expect(result.errors.map((error) => error.replace('!test: ', ''))).toEqual(expected.errors)
        expect(result.warnings?.length ?? 0).toBe(expected.warnings.length)
        expect(result.incomplete).toEqual([])
        expect(result.state.members[0].roles.includes('200000000000000002')).toBe(expected.role)
      }
    )
  }

  it.each([true, false])(
    'restores nested aliases and retains globals across subsequent steps (wrapped=%s)',
    async (wrapped) => {
      const session = createScriptSession(factory)
      const state = createPlaygroundState()
      state.botState = { nested: { count: 1 }, list: [1, 2] }
      const vm = await createQuickJSScriptContext({ initialContext: { botState: state.botState } })
      const snippets = [
        'globalThis.alias = botState.nested; globalThis.listAlias = botState.list; var scoped = 7; botState.nested.count = 2;',
        'alias.count = 99; listAlias.push(3); botState = { replacement: true }; globalThis.survived = 8; throw new Error("rollback");',
        'botState.after = [alias === botState.nested, listAlias === botState.list, alias.count, listAlias.length, survived, typeof scoped]; alias.count++;'
      ]
      try {
        for (const code of snippets) {
          const checkpoint = vm.checkpointVariable('botState')
          const source = `$eval ${code} $halt`
          const live = await new Interpreter().interpret(source, {
            vmContext: vm,
            wrapEvalInIIFE: wrapped
          })
          if (live.errors.length) checkpoint.restore()
          checkpoint.dispose()
          session.beginStep(state)
          const scope = executionContext(
            { state, sender: state.members[0], content: '', trigger: '', wrapEvalInIIFE: wrapped },
            session.factory
          )
          try {
            expect(await evaluateTemplate(source, scope.context)).toBe(live.output)
          } finally {
            scope.dispose()
          }
          expect(state.botState).toEqual(JSON.parse(vm.serializeVariable('botState')))
        }
        expect(state.botState).toEqual({
          nested: { count: 3 },
          list: [1, 2],
          after: [true, true, 2, 2, 8, wrapped ? 'undefined' : 'number']
        })
      } finally {
        session.dispose()
        vm.dispose()
      }
    }
  )

  it.each(['slash', 'button'] as const)(
    '%s stops on DM rendering failure, preserving the earlier reply',
    async (kind) => {
      const state = createPlaygroundState()
      state.botState = { count: 0 }
      const rootAction = action('$eval botState.count++; $haltfirst', '$set(botState,invalid)')
      const saved: BCFDInteractionCommand = {
        id: 'candidate',
        commandName: 'test',
        commandDescription: 'Parity',
        options: [],
        isRegistered: false,
        rootAction
      }
      if (kind === 'button') {
        const button = {
          customId: 'go',
          label: 'Go',
          style: 1 as const,
          disabled: false,
          action: structuredClone(rootAction)
        }
        saved.rootAction.buttons = [button]
        state.messages = [
          { id: 1, kind: 'bot', author: 'Bot', content: 'Button', buttons: [button] }
        ]
        state.nextId = 2
      }
      const result = await runInteraction(
        {
          kind,
          state,
          senderId: state.members[0].id,
          interactions: [saved],
          commandId: saved.id,
          messageId: 1,
          customId: 'go'
        },
        factory
      )
      expect(result.state.messages.at(-1)?.content).toBe('first')
      expect(result.state.operations?.map((operation) => operation.name)).toEqual(['message.send'])
      expect(result.state.botState).toEqual({ count: 1 })
      expect(result.warnings).toEqual([])
      expect(result.errors).toHaveLength(1)
      expect(result.resources?.[0].outcome).toBe('error')
    }
  )

  it('updates global var bindings with $set and restores a deleted botState binding', async () => {
    const state = createPlaygroundState()
    state.botState = { count: 1 }
    const source =
      '$eval var shared = "old"; $halt$set(shared,new)$eval delete globalThis.botState; throw new Error("restore"); $halt'
    const session = createScriptSession(factory)
    const vm = await createQuickJSScriptContext({ initialContext: { botState: state.botState } })
    try {
      const checkpoint = vm.checkpointVariable('botState')
      const live = await new Interpreter().interpret(source, {
        vmContext: vm,
        wrapEvalInIIFE: false
      })
      checkpoint.restore()
      checkpoint.dispose()
      session.beginStep(state)
      const result = await runMessage(
        {
          state,
          senderId: state.members[0].id,
          content: '!test',
          wrapEvalInIIFE: false,
          commands: [command(source)]
        },
        session.factory
      )
      expect(result.state.messages.at(-1)?.content).toBe(live.output)
      expect(result.diagnostics).toEqual(live.errors.map((error) => error.message))
      expect(result.state.botState).toEqual(JSON.parse(vm.serializeVariable('botState')))
      session.beginStep(result.state)
      const next = await runMessage(
        {
          state: result.state,
          senderId: state.members[0].id,
          content: '!test',
          commands: [command('$get(shared)')]
        },
        session.factory
      )
      expect(next.state.messages.at(-1)?.content).toBe(vm.getVariable('shared'))
      expect(next.state.messages.at(-1)?.content).toBe('new')
    } finally {
      session.dispose()
      vm.dispose()
    }
  })

  it('allows explicitly asserted inline diagnostics while unexpected diagnostics fail', async () => {
    const state = createPlaygroundState()
    const request = {
      candidateKind: 'command' as const,
      candidate: command('$unknown'),
      candidateHash: 'hash',
      baseRevision: null,
      fixtureHash: 'fixture',
      wrapEvalInIIFE: true,
      suite: {
        cases: [
          {
            name: 'diagnostic',
            state,
            steps: [
              {
                kind: 'message' as const,
                senderId: state.members[0].id,
                content: '!test',
                assertions: [
                  { path: '/outcome', equals: 'executed' },
                  { path: '/effects/messages/0/content', equals: '$unknown' },
                  { path: '/diagnostics/0', equals: "Unknown variable '$unknown'" }
                ]
              }
            ]
          }
        ]
      }
    }
    expect((await runAgentValidation(request, factory)).outcome).toBe('passed')
    request.suite.cases[0].steps[0].assertions.pop()
    expect((await runAgentValidation(request, factory)).outcome).toBe('failed')
  })

  it('treats an ordinary guest error mentioning a limit as a modeled diagnostic', async () => {
    const state = createPlaygroundState()
    const result = await runMessage(
      {
        state,
        senderId: state.members[0].id,
        content: '!test',
        commands: [command('$eval throw new Error("credit limit reached"); $halt')]
      },
      factory
    )
    expect(result.incomplete).toEqual([])
    expect(result.diagnostics?.[0]).toContain('credit limit reached')
    expect(result.resources?.[0].outcome).toBe('executed')
  })

  it('reports an irreversible alias rollback as incomplete and refuses later VM use', async () => {
    const state = createPlaygroundState()
    state.botState = { count: 1 }
    const session = createScriptSession(factory)
    try {
      session.beginStep(state)
      const result = await runMessage(
        {
          state,
          senderId: state.members[0].id,
          content: '!test',
          commands: [
            command(
              '$eval botState.count = 99; Object.freeze(botState); throw new Error("rollback"); $halt'
            )
          ]
        },
        session.factory
      )
      expect(result.incomplete?.join(' ')).toContain('rollback failed')
      expect(result.resources?.[0].outcome).toBe('not_run')
      expect(result.state.botState).toEqual({ count: 1 })
      expect(() => session.beginStep(result.state)).toThrow('unavailable')
    } finally {
      session.dispose()
    }
  })

  it.each([
    '$chat(unmocked)',
    '$replace(' + 'a'.repeat(100) + ',a,' + 'b'.repeat(1000) + ')',
    '$eval while(true) {} $halt',
    '$eval botState.values = Array(11000).fill(0); $halt'
  ])('never authorizes expected errors caused by incomplete simulation: %s', async (source) => {
    const state = createPlaygroundState()
    const report = await runAgentValidation(
      {
        candidateKind: 'command',
        candidate: command(source),
        candidateHash: 'hash',
        baseRevision: null,
        fixtureHash: 'fixture',
        wrapEvalInIIFE: true,
        suite: {
          cases: [
            {
              name: 'incomplete',
              state,
              steps: [
                {
                  kind: 'message',
                  senderId: state.members[0].id,
                  content: '!test',
                  assertions: [
                    { path: '/outcome', equals: 'error' },
                    { path: '/reason', equals: 'expected failure' },
                    { path: '/effects/messages/length', equals: 0 }
                  ]
                }
              ]
            }
          ]
        }
      },
      factory
    )
    expect(report.outcome).toBe('not_run')
    expect(report.cases[0].steps[0].expectedNegative).toBe(false)
  })
})
