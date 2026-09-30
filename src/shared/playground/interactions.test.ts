import { describe, expect, it } from 'vitest'
import type {
  BCFDInteractionAction,
  BCFDInteractionButton,
  BCFDInteractionCommand,
  BCFDSlashCommandOption
} from '../../main/types/types'
import { createPlaygroundState } from './types'
import type { PlaygroundInteractionRequest } from './types'
import { runMessage } from './engine'
import { decodeBCFDCommand } from '../commandCodec'
import { runInteraction, validateOptions } from './interactions'

const blankEmbed = () => ({
  title: '',
  description: '',
  hexColor: '',
  imageURL: '',
  thumbnailURL: '',
  footer: ''
})
const action = (patch: Partial<BCFDInteractionAction> = {}): BCFDInteractionAction => ({
  sendChannelMessage: false,
  channelMessage: '',
  sendPrivateMessage: false,
  privateMessage: '',
  sendChannelEmbed: false,
  channelEmbed: blankEmbed(),
  sendPrivateEmbed: false,
  privateEmbed: blankEmbed(),
  isRoleAssigner: false,
  roleToAssign: '',
  isKick: false,
  isBan: false,
  isVoiceMute: false,
  targetUserOptionName: '',
  deleteX: false,
  deleteNum: 0,
  ephemeral: false,
  deferReply: false,
  buttons: [],
  ...patch
})
const command = (patch: Partial<BCFDInteractionCommand> = {}): BCFDInteractionCommand => ({
  id: 'slash',
  commandName: 'test',
  commandDescription: 'Test',
  options: [],
  rootAction: action(),
  isRegistered: false,
  ...patch
})
const option = (
  name: string,
  type: BCFDSlashCommandOption['type'],
  required = true
): BCFDSlashCommandOption => ({ name, type, required, description: name })
const button = (
  customId: string,
  patch: Partial<BCFDInteractionAction> = {}
): BCFDInteractionButton => ({
  customId,
  label: customId,
  style: 1,
  disabled: false,
  action: action(patch)
})
const request = (saved = command(), options = {}): PlaygroundInteractionRequest => ({
  kind: 'slash',
  state: createPlaygroundState(),
  interactions: [saved],
  senderId: '100000000000000001',
  commandId: saved.id,
  options
})

describe('saved interaction playground', () => {
  it('accepts editor-supported Unicode and apostrophe option names', () => {
    const input = request(
      command({
        options: [option('名前', 3), option("it's", 3), option('Foo', 3), option('Όνομα', 3)],
        rootAction: action({
          sendChannelMessage: true,
          channelMessage: "$option(名前):$option(it's):$option(Foo):$option(Όνομα)"
        })
      }),
      { 名前: '日本語', "it's": 'accepted', Foo: 'upper', Όνομα: 'Greek' }
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].content).toBe('日本語:accepted:upper:Greek')
  })

  it('handles legitimate prototype-like option names as inert own values', () => {
    const values = Object.create(null)
    values.constructor = 'safe'
    values.__proto__ = 'data'
    const input = request(
      command({
        options: [option('constructor', 3), option('__proto__', 3)],
        rootAction: action({
          sendChannelMessage: true,
          channelMessage: '$option(constructor):$option(__proto__)'
        })
      }),
      values
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].content).toBe('safe:data')
  })

  it('resolves duplicate custom IDs by the first saved match as production does', () => {
    const first = command({
      id: 'first',
      rootAction: action({
        buttons: [button('same', { sendChannelMessage: true, channelMessage: 'first saved' })]
      })
    })
    const second = command({
      id: 'second',
      rootAction: action({
        buttons: [button('same', { sendChannelMessage: true, channelMessage: 'second saved' })]
      })
    })
    const original = runInteraction(request(second))
    const clicked = runInteraction({
      kind: 'button',
      state: original.state,
      interactions: [first, second],
      senderId: '100000000000000001',
      messageId: 1,
      customId: 'same'
    })
    expect(clicked.errors).toEqual([])
    expect(clicked.state.messages[1].content).toBe('first saved')
  })

  it('traditional deletion excludes ephemeral replies created by slash simulation', () => {
    const slash = runInteraction(request(command({ rootAction: action({ ephemeral: true }) })))
    const clear = decodeBCFDCommand({
      id: 'clear',
      command: '!clear',
      commandDescription: 'Clear',
      type: 0,
      channelMessage: '',
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {},
      deleteNum: 100
    }).command
    const result = runMessage({
      state: slash.state,
      commands: [clear],
      senderId: '100000000000000001',
      content: '!clear'
    })
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].deleted).toBeUndefined()
    expect(result.state.messages[1].deleted).toBe(true)
  })

  it('works with only saved interactions and no traditional commands or publication', () => {
    const input = request(
      command({
        rootAction: action({ sendChannelMessage: true, channelMessage: 'Hello $namePlain' })
      })
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].content).toBe('Hello Alex')
    expect(input.state.messages).toEqual([])
    expect(input.interactions[0].isRegistered).toBe(false)
  })

  it('returns raw user/channel/role IDs and preserves false and zero option values', () => {
    const state = createPlaygroundState()
    const input = request(
      command({
        options: [
          option('person', 6),
          option('room', 7),
          option('role', 8),
          option('enabled', 5),
          option('count', 4)
        ],
        rootAction: action({
          sendChannelMessage: true,
          channelMessage:
            '$option(person)|$option(room)|$option(role)|$option(enabled)|$option(count)|$option(missing)'
        })
      }),
      {
        person: state.members[1].id,
        room: state.channelId,
        role: state.roles[0].id,
        enabled: false,
        count: 0
      }
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].content).toBe(
      `${state.members[1].id}|${state.channelId}|${state.roles[0].id}|false|0|`
    )
  })

  it('validates required/unknown options, strict primitive types, finite numbers and fixture IDs', () => {
    const state = createPlaygroundState()
    expect(() => validateOptions([option('required', 3)], {}, state)).toThrow('Required')
    expect(() => validateOptions([], { unknown: 1 }, state)).toThrow('Unknown')
    for (const [definition, value] of [
      [option('v', 3), 0],
      [option('v', 3), ''],
      [option('v', 4), '1'],
      [option('v', 4), 1.5],
      [option('v', 5), 'false'],
      [option('v', 10), Infinity],
      [option('v', 6), 'outside'],
      [option('v', 7), 'outside'],
      [option('v', 8), 'outside']
    ] as const)
      expect(() => validateOptions([definition], { v: value }, state)).toThrow('Invalid')
    expect(validateOptions([option('optional', 3, false)], {}, state)).toEqual({})
    expect(
      validateOptions([{ ...option('text', 3), choices: [] }], { text: 'unrestricted' }, state).text
    ).toBe('unrestricted')
  })

  it('validates typed choice membership, duplicate definitions and choice types', () => {
    const state = createPlaygroundState()
    const definition = { ...option('count', 4), choices: [{ name: 'Zero', value: 0 }] }
    expect(validateOptions([definition], { count: 0 }, state).count).toBe(0)
    expect(() => validateOptions([definition], { count: 2 }, state)).toThrow('Invalid')
    expect(() => validateOptions([definition], { count: '0' }, state)).toThrow('Invalid')
    expect(() => validateOptions([definition, definition], { count: 0 }, state)).toThrow(
      'duplicate'
    )
    expect(() =>
      validateOptions(
        [{ ...option('enabled', 5), choices: [{ name: 'Bad', value: 'false' }] }],
        { enabled: false },
        state
      )
    ).toThrow('Invalid')
  })

  it('honors action flags and does not evaluate inactive stale payloads', () => {
    const input = request(
      command({
        rootAction: action({
          channelMessage: '$eval while(true){} $halt',
          privateMessage: '$ai(hi)',
          channelEmbed: { ...blankEmbed(), title: '$set(x,1)' },
          roleToAssign: 'outside'
        })
      })
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages).toHaveLength(1)
    expect(result.state.messages[0].content).toBe('\u200B')
    expect(result.state.members).toEqual(input.state.members)
  })

  it('models ephemeral/deferred responses and fake DMs/embeds for the invoker', () => {
    const input = request(
      command({
        rootAction: action({
          ephemeral: true,
          deferReply: true,
          sendPrivateMessage: true,
          privateMessage: 'DM $namePlain',
          sendChannelEmbed: true,
          channelEmbed: {
            ...blankEmbed(),
            title: 'Title $namePlain',
            imageURL: 'https://example.invalid/image'
          },
          sendPrivateEmbed: true,
          privateEmbed: { ...blankEmbed(), title: 'Private' }
        })
      })
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0]).toMatchObject({
      ephemeral: true,
      deferred: true,
      recipient: input.senderId,
      content: '',
      embed: { title: 'Title Alex', imageURL: 'https://example.invalid/image' }
    })
    expect(
      result.state.messages
        .slice(1)
        .every((message) => message.kind === 'dm' && message.recipient === input.senderId)
    ).toBe(true)
    expect(result.trace).toContain('Deferred reply then edit (timing not modeled)')
  })

  it.each(['isKick', 'isBan', 'isVoiceMute'] as const)(
    'targets the configured user option for %s, while roles target invoker',
    (flag) => {
      const input = request(
        command({
          options: [option('target', 6)],
          rootAction: action({
            [flag]: true,
            targetUserOptionName: 'target',
            isRoleAssigner: true,
            roleToAssign: '200000000000000002'
          })
        }),
        { target: '100000000000000002' }
      )
      const result = runInteraction(input)
      expect(result.errors).toEqual([])
      const key = flag === 'isKick' ? 'kicked' : flag === 'isBan' ? 'banned' : 'muted'
      expect(result.state.members[1][key]).toBe(true)
      expect(result.state.members[0].roles).toContain('200000000000000002')
      expect(result.state.members[1].roles).toEqual([])
      input.state.members[0].permissions = []
      const failure = runInteraction(input)
      expect(failure.errors[0]).toContain('permission')
      expect(failure.state).toEqual(input.state)
    }
  )

  it('requires a typed configured target and fails closed after earlier staged deletion', () => {
    const input = request(
      command({
        options: [option('target', 3)],
        rootAction: action({
          isKick: true,
          targetUserOptionName: 'target',
          deleteX: true,
          deleteNum: 1
        })
      }),
      { target: '100000000000000002' }
    )
    input.state.messages = [{ id: 1, author: 'Sam', content: 'old', kind: 'user' }]
    input.state.nextId = 2
    const result = runInteraction(input)
    expect(result.errors[0]).toContain('configured user option')
    expect(result.state.messages[0].deleted).toBeUndefined()
  })

  it('applies only fake channel deletion and preserves ephemeral/DM entries', () => {
    const input = request(command({ rootAction: action({ deleteX: true, deleteNum: 100 }) }))
    input.state.messages = [
      { id: 1, kind: 'user', author: 'Sam', content: 'old' },
      { id: 2, kind: 'dm', author: 'Bot', content: 'dm' },
      { id: 3, kind: 'bot', author: 'Bot', content: 'private', ephemeral: true }
    ]
    input.state.nextId = 4
    const result = runInteraction(input)
    expect(result.state.messages.slice(0, 3).map((message) => !!message.deleted)).toEqual([
      true,
      false,
      false
    ])
  })

  it('keeps option text inert rather than reparsing it as template code', () => {
    const input = request(
      command({
        options: [option('text', 3)],
        rootAction: action({ sendChannelMessage: true, channelMessage: '$option(text)' })
      }),
      { text: '$eval while(true){} $halt' }
    )
    const result = runInteraction(input)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].content).toBe('$eval while(true){} $halt')
  })

  it('runs nested button actions with click invoker and no inherited slash options', () => {
    const nested = button('nested', {
      sendChannelMessage: true,
      channelMessage: '$option(text):$namePlain'
    })
    const first = button('first', {
      sendChannelMessage: true,
      channelMessage: '$option(text):$namePlain',
      sendPrivateMessage: true,
      privateMessage: 'DM $namePlain',
      isRoleAssigner: true,
      roleToAssign: '200000000000000002',
      buttons: [nested]
    })
    const saved = command({
      options: [option('text', 3)],
      rootAction: action({
        sendChannelMessage: true,
        channelMessage: '$option(text)',
        buttons: [{ ...first, label: '$option(text)' }]
      })
    })
    const original = runInteraction(request(saved, { text: 'snapshot' }))
    expect(original.state.messages[0].buttons?.[0].label).toBe('snapshot')
    const clicked = runInteraction({
      kind: 'button',
      state: original.state,
      interactions: [saved],
      senderId: '100000000000000002',
      messageId: 1,
      customId: 'first'
    })
    expect(clicked.errors).toEqual([])
    expect(clicked.state.messages[1].content).toBe(':Sam')
    expect(clicked.state.messages[2]).toMatchObject({
      kind: 'dm',
      recipient: '100000000000000002',
      content: 'DM Sam'
    })
    expect(clicked.state.members[1].roles).toContain('200000000000000002')
    const next = runInteraction({
      kind: 'button',
      state: clicked.state,
      interactions: [saved],
      senderId: '100000000000000003',
      messageId: 2,
      customId: 'nested'
    })
    expect(next.errors).toEqual([])
    expect(next.state.messages.at(-1)?.content).toBe(':Morgan')
  })

  it('does not perform moderation/delete flags in button actions, matching production', () => {
    const saved = command({
      rootAction: action({
        buttons: [
          button('first', {
            isKick: true,
            isBan: true,
            isVoiceMute: true,
            deleteX: true,
            deleteNum: 100,
            targetUserOptionName: 'target'
          })
        ]
      })
    })
    const original = runInteraction(request(saved))
    const clicked = runInteraction({
      kind: 'button',
      state: original.state,
      interactions: [saved],
      senderId: '100000000000000001',
      messageId: 1,
      customId: 'first'
    })
    expect(clicked.errors).toEqual([])
    expect(clicked.state.members).toEqual(original.state.members)
    expect(clicked.state.messages[0].deleted).toBeUndefined()
    expect(clicked.trace).toContain(
      'Button moderation/deletion flags are ignored by the production button handler'
    )
  })

  it('rejects disabled/link/deleted/foreign ephemeral buttons and safely handles obsolete saved buttons', () => {
    for (const patch of [
      { disabled: true },
      { style: 5 as const, url: 'https://example.invalid' }
    ]) {
      const saved = command({ rootAction: action({ buttons: [{ ...button('first'), ...patch }] }) })
      const original = runInteraction(request(saved))
      const result = runInteraction({
        kind: 'button',
        state: original.state,
        interactions: [saved],
        senderId: '100000000000000001',
        messageId: 1,
        customId: 'first'
      })
      expect(result.errors[0]).toContain('disabled, inert')
      expect(result.state).toEqual(original.state)
    }
    const saved = command({ rootAction: action({ ephemeral: true, buttons: [button('first')] }) })
    const original = runInteraction(request(saved))
    const input: PlaygroundInteractionRequest = {
      kind: 'button',
      state: original.state,
      interactions: [saved],
      senderId: '100000000000000002',
      messageId: 1,
      customId: 'first'
    }
    expect(runInteraction(input).errors[0]).toContain('unavailable')
    input.senderId = '100000000000000001'
    input.interactions = []
    expect(runInteraction(input).errors[0]).toContain('no longer active')
    input.state.messages[0].deleted = true
    expect(runInteraction(input).errors[0]).toContain('unavailable')
  })

  it('fails closed for active unsupported effects and held cooldown simulation', () => {
    for (const saved of [
      command({
        rootAction: action({
          sendChannelMessage: true,
          channelMessage: 'first',
          sendPrivateMessage: true,
          privateMessage: '$eval return 1 $halt'
        })
      }),
      command({ cooldown: 5 })
    ]) {
      const input = request(saved),
        result = runInteraction(input)
      expect(result.errors).toHaveLength(1)
      expect(result.state).toEqual(input.state)
    }
  })
})
