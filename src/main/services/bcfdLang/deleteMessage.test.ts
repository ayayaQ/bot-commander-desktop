import { describe, expect, it, vi } from 'vitest'
import { Client, MessageManager } from 'discord.js'
import { deleteMessage } from './deleteMessage'
import { DELETE_MESSAGE_ERRORS } from '../../../shared/deleteMessage'
import { Interpreter } from './interpreter'
import type { BCFDContext } from './types'
import { parse } from './parser'
import { NodeType } from './types'
import {
  contextForInteractionEvent,
  contextForMessageEvent,
  contextForReactionEvent
} from '../stringInfo'
import type { BCFDCommand, BCFDInteractionCommand } from '../../types/types'

describe('live deleteMessage keyword with headless mocks', () => {
  it('validates before requiring a channel and never deletes invalid input', async () => {
    const remove = vi.fn()
    const channel = { messages: { delete: remove } }
    expect(deleteMessage([], undefined)).toBe(DELETE_MESSAGE_ERRORS.arity)
    expect(deleteMessage(['0'], undefined)).toBe(DELETE_MESSAGE_ERRORS.invalidId)
    expect(deleteMessage(['1'], undefined)).toBe(DELETE_MESSAGE_ERRORS.context)
    expect(deleteMessage(['1'], {})).toBe(DELETE_MESSAGE_ERRORS.context)
    expect(deleteMessage(['1'], { messages: {} } as never)).toBe(DELETE_MESSAGE_ERRORS.context)
    for (const args of [[], [''], ['0'], ['01'], ['1', '2']])
      expect(await deleteMessage(args, channel)).toMatch(/^\[BCFD Error:/)
    expect(remove).not.toHaveBeenCalled()
  })

  it('awaits one deletion of the lossless trimmed ID without a fetch or permission gate', async () => {
    let finish: () => void
    const pending = new Promise<void>((resolve) => (finish = resolve))
    const remove = vi.fn(() => pending)
    const fetch = vi.fn(() => {
      throw new Error('must not fetch')
    })
    const channel = { messages: { delete: remove, fetch } }
    let settled = false
    const result = Promise.resolve(deleteMessage([' 9007199254740993 '], channel)).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(remove).toHaveBeenCalledExactlyOnceWith('9007199254740993')
    finish!()
    expect(await result).toBe('')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [10008, DELETE_MESSAGE_ERRORS.missingMessage],
    [10003, DELETE_MESSAGE_ERRORS.missingChannel],
    [50001, DELETE_MESSAGE_ERRORS.access],
    [50013, DELETE_MESSAGE_ERRORS.permission],
    [50003, DELETE_MESSAGE_ERRORS.permission],
    [99999, DELETE_MESSAGE_ERRORS.failed]
  ])('awaits and classifies rejected deletion code %s', async (code, expected) => {
    const remove = vi.fn().mockRejectedValue({ code, message: 'private details' })
    expect(await deleteMessage(['123'], { messages: { delete: remove } })).toBe(expected)
    expect(remove).toHaveBeenCalledExactlyOnceWith('123')
  })

  it('classifies a synchronous adapter failure without leaking details', async () => {
    const remove = vi.fn(() => {
      throw new Error('private token and network detail')
    })
    expect(await deleteMessage(['123'], { messages: { delete: remove } })).toBe(
      DELETE_MESSAGE_ERRORS.failed
    )
  })

  it('uses discord.js single-message REST DELETE and propagates unknown-message errors', async () => {
    const client = new Client({ intents: [] })
    const restDelete = vi.spyOn(client.rest, 'delete').mockRejectedValue({ code: 10008 })
    const restGet = vi.spyOn(client.rest, 'get').mockImplementation(() => {
      throw new Error('must not prefetch')
    })
    try {
      const channel = { id: '456', client } as never
      // The public typing protects construction; this headless fixture exercises the real method.
      const messages = Reflect.construct(MessageManager, [channel]) as MessageManager
      expect(await deleteMessage(['18446744073709551615'], { messages })).toBe(
        DELETE_MESSAGE_ERRORS.missingMessage
      )
      expect(restDelete).toHaveBeenCalledExactlyOnceWith(
        '/channels/456/messages/18446744073709551615'
      )
      expect(restGet).not.toHaveBeenCalled()
    } finally {
      restDelete.mockRestore()
      restGet.mockRestore()
      await client.destroy()
    }
  })

  it.each([false, true])(
    'supports evaluated message/option IDs with legacy wrapping %s',
    async (legacy) => {
      const remove = vi.fn().mockResolvedValue(undefined)
      const ctx = {
        textChannel: { messages: { delete: remove } },
        messageEvent: { content: '!delete 9007199254740993' },
        command: { command: '!delete' },
        interactionOptions: { get: () => ({ value: '18446744073709551615' }) },
        wrapEvalInIIFE: !legacy
      } as unknown as BCFDContext
      const result = await new Interpreter().interpret(
        'before$deleteMessage($args(0)):$deleteMessage($option(messageid))after',
        ctx
      )
      expect(result).toEqual({ output: 'before:after', errors: [] })
      expect(remove.mock.calls).toEqual([['9007199254740993'], ['18446744073709551615']])
    }
  )

  it.each([
    ['$deleteMessage', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage()', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage(1,)', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage(1, )', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage(,1)', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage{1|}', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage($option(missing))', DELETE_MESSAGE_ERRORS.invalidId],
    ['$deleteMessage(01)', DELETE_MESSAGE_ERRORS.invalidId],
    ['$deleteMessage(1)', DELETE_MESSAGE_ERRORS.missingMessage]
  ])('returns deterministic inline errors for %s', async (source, output) => {
    const remove = vi.fn().mockRejectedValue({ code: 10008 })
    const result = await new Interpreter().interpret(source, {
      textChannel: { messages: { delete: remove } } as unknown as BCFDContext['textChannel']
    })
    expect(result).toEqual({ output, errors: [] })
    expect(remove).toHaveBeenCalledTimes(output === DELETE_MESSAGE_ERRORS.missingMessage ? 1 : 0)
  })

  it('preserves existing keyword trailing-empty parsing behavior', () => {
    for (const source of ['$sum(1,)', '$random{one|}']) {
      const node = parse(source).ast.children[0]
      expect(node.type).toBe(NodeType.FUNCTION_CALL)
      if (node.type === NodeType.FUNCTION_CALL) expect(node.arguments).toHaveLength(1)
    }
  })

  it('uses the invoking channel for traditional, reaction, slash and button contexts', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    const channel = { messages: { delete: remove } }
    const event = {
      channel,
      author: {},
      client: {},
      guild: null,
      member: null,
      mentions: { users: { first: () => undefined } }
    }
    const command = {} as BCFDCommand
    const contexts = [
      contextForMessageEvent('', command, event as never),
      contextForReactionEvent('', { message: event, client: {} } as never, command),
      ...[true, false].map((slash) =>
        contextForInteractionEvent(
          '',
          {
            channel,
            user: {},
            client: {},
            guild: null,
            member: null,
            isChatInputCommand: () => slash,
            options: {}
          } as never,
          {} as BCFDInteractionCommand
        )
      )
    ]
    for (const ctx of contexts) {
      expect(ctx.textChannel).toBe(channel)
      expect(await new Interpreter().interpret('$deleteMessage(123)', ctx)).toEqual({
        output: '',
        errors: []
      })
    }
    expect(remove).toHaveBeenCalledTimes(4)
  })
})
