import { beforeAll, describe, expect, it } from 'vitest'
import { getQuickJS } from 'quickjs-emscripten'
import type {
  BCFDCommand,
  BCFDEmbedMessageTemplate,
  BCFDInteractionAction,
  BCFDInteractionButton,
  BCFDInteractionCommand
} from '../../main/types/types'
import { decodeBCFDCommand } from '../commandCodec'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { createScriptSandboxFactory } from './script'
import type { ScriptSandboxFactory } from './script'
import { createPlaygroundState } from './types'
import type { PlaygroundInteractionRequest, PlaygroundMessageRequest } from './types'

const blankEmbed = (): BCFDEmbedMessageTemplate => ({
  title: '',
  description: '',
  hexColor: '',
  imageURL: '',
  thumbnailURL: '',
  footer: ''
})
const messageCommand = (patch: Partial<BCFDCommand> = {}): BCFDCommand =>
  decodeBCFDCommand({
    id: 'message',
    command: '!test',
    commandDescription: 'Test',
    type: 0,
    channelMessage: '',
    privateMessage: '',
    channelEmbed: blankEmbed(),
    privateEmbed: blankEmbed(),
    ...patch
  }).command
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
const slashCommand = (patch: Partial<BCFDInteractionCommand> = {}): BCFDInteractionCommand => ({
  id: 'slash',
  commandName: 'test',
  commandDescription: 'Test',
  options: [],
  rootAction: action(),
  isRegistered: false,
  ...patch
})
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
const messageRequest = (
  saved: BCFDCommand,
  state = createPlaygroundState(),
  senderId = state.members[0].id
): PlaygroundMessageRequest => ({
  state,
  commands: [saved],
  senderId,
  content: saved.command
})
const slashRequest = (
  saved: BCFDInteractionCommand,
  state = createPlaygroundState(),
  senderId = state.members[0].id
): PlaygroundInteractionRequest => ({
  kind: 'slash',
  state,
  interactions: [saved],
  senderId,
  commandId: saved.id,
  options: {}
})

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})

describe('playground command execution state', () => {
  it('persists local botState and cooldown timestamps across successive message and slash requests', () => {
    const saved = messageCommand({
      cooldown: 2,
      cooldownType: 'User',
      channelMessage:
        '$eval botState.visits = (botState.visits || 0) + 1; return botState.visits; $halt'
    })
    const input = messageRequest(saved)
    const original = structuredClone(input)
    const first = runMessage(input, factory)
    expect(first.errors).toEqual([])
    expect(first.state.botState).toEqual({ visits: 1 })
    expect(first.state.cooldowns).toEqual({ [`message:user:${input.senderId}`]: 0 })
    expect(first.state.messages.at(-1)?.content).toBe('1')
    expect(input).toEqual(original)

    const advanced = structuredClone(first.state)
    advanced.clockMs = 2000
    const second = runMessage(messageRequest(saved, advanced), factory)
    expect(second.errors).toEqual([])
    expect(second.state.botState).toEqual({ visits: 2 })
    expect(second.state.cooldowns).toEqual({ [`message:user:${input.senderId}`]: 2000 })
    expect(second.state.messages.at(-1)?.content).toBe('2')
    expect(first.state.botState).toEqual({ visits: 1 })

    const slash = slashCommand({
      rootAction: action({
        sendChannelMessage: true,
        channelMessage: '$eval botState.visits += 1; return botState.visits; $halt'
      })
    })
    const third = runInteraction(slashRequest(slash, second.state), factory)
    expect(third.errors).toEqual([])
    expect(third.state.botState).toEqual({ visits: 3 })
    expect(third.state.cooldowns).toEqual(second.state.cooldowns)
    expect(third.state.messages.at(-1)?.content).toBe('3')
    expect(second.state.botState).toEqual({ visits: 2 })
  })

  it('rolls back script state, replies, deletions, roles and cooldowns when a command later fails', () => {
    const saved = messageCommand({
      cooldown: 5,
      cooldownType: 'Global',
      deleteNum: 100,
      deleteAfter: true,
      roleToAssign: '200000000000000002',
      channelMessage:
        '$set(temporary,staged)$eval botState.profile.count += 1; return "staged"; $halt',
      privateMessage: '$unknown'
    })
    const state = createPlaygroundState()
    state.botState = { profile: { count: 4 } }
    state.variables = { theme: 'keep' }
    state.cooldowns = { 'older:global': 0 }
    state.messages = [{ id: 1, kind: 'user', author: 'Sam', content: 'keep me' }]
    state.nextId = 2
    const original = structuredClone(state)
    const result = runMessage(messageRequest(saved, state), factory)
    expect(result.errors).toHaveLength(1)
    expect(result.state.botState).toEqual(original.botState)
    expect(result.state.variables).toEqual(original.variables)
    expect(result.state.cooldowns).toEqual(original.cooldowns)
    expect(result.state.members).toEqual(original.members)
    expect(result.state.messages).toEqual([
      ...original.messages,
      { id: 2, kind: 'user', author: 'Alex', content: '!test' }
    ])
    expect(result.state.nextId).toBe(3)
    expect(state).toEqual(original)
  })

  it('keeps a prior matching command committed when a later matching command fails', () => {
    const first = messageCommand({
      id: 'first',
      channelMessage: '$eval botState.count = 1; return "first"; $halt'
    })
    const second = messageCommand({
      id: 'second',
      cooldown: 5,
      cooldownType: 'Global',
      channelMessage: '$eval botState.count = 2; return "second"; $halt',
      privateMessage: '$unknown'
    })
    const result = runMessage({ ...messageRequest(first), commands: [first, second] }, factory)
    expect(result.errors).toHaveLength(1)
    expect(result.state.botState).toEqual({ count: 1 })
    expect(result.state.messages.map((message) => message.content)).toEqual(['!test', 'first'])
    expect(result.state.cooldowns).toEqual({})
  })

  it('rolls back an entire failed interaction, including staged botState and transcript changes', () => {
    const saved = slashCommand({
      cooldown: 5,
      cooldownType: 'Global',
      rootAction: action({
        deleteX: true,
        deleteNum: 100,
        sendChannelMessage: true,
        channelMessage:
          '$set(temporary,staged)$eval botState.profile.count += 1; return "staged"; $halt',
        sendPrivateMessage: true,
        privateMessage: '$unknown',
        isRoleAssigner: true,
        roleToAssign: '200000000000000002'
      })
    })
    const state = createPlaygroundState()
    state.botState = { profile: { count: 4 } }
    state.variables = { theme: 'keep' }
    state.cooldowns = { 'older:global': 0 }
    state.messages = [{ id: 1, kind: 'user', author: 'Sam', content: 'keep me' }]
    state.nextId = 2
    const original = structuredClone(state)
    const result = runInteraction(slashRequest(saved, state), factory)
    expect(result.errors).toHaveLength(1)
    expect(result.state).toEqual(original)
    expect(state).toEqual(original)
  })

  it('creates a clean reset with empty botState, cooldowns and transcript at clock zero', () => {
    const populated = createPlaygroundState()
    populated.botState = { score: 42 }
    populated.variables = { color: 'blue' }
    populated.cooldowns = { 'message:global': 0 }
    populated.clockMs = 1000
    populated.ai = { response: 'custom', error: 'simulated failure' }
    populated.messages = [{ id: 1, kind: 'bot', author: 'Bot', content: 'old' }]
    populated.nextId = 2
    const reset = createPlaygroundState()
    expect(reset.botState).toEqual({})
    expect(reset.variables).toEqual({})
    expect(reset.cooldowns).toEqual({})
    expect(reset.messages).toEqual([])
    expect(reset.clockMs).toBe(0)
    expect(reset.nextId).toBe(1)
    expect(reset.ai.error).toBe('')
    reset.botState.score = 1
    expect(populated.botState).toEqual({ score: 42 })
  })

  it('preserves explicit $set/$get variables across templates and sends separately from botState', () => {
    const saved = messageCommand({
      channelMessage: '$set(color,blue)$get(color)',
      privateMessage: '$get(color):$eval return botState.color; $halt',
      channelEmbed: { ...blankEmbed(), title: '$get(color)' }
    })
    const state = createPlaygroundState()
    state.botState = { color: 'persistent' }
    const first = runMessage(messageRequest(saved, state), factory)
    expect(first.errors).toEqual([])
    expect(first.state.messages[1].content).toBe('blue')
    expect(first.state.messages[2].content).toBe('blue:persistent')
    expect(first.state.messages[3].embed?.title).toBe('blue')
    expect(first.state.botState).toEqual({ color: 'persistent' })
    expect(first.state.variables).toEqual({ color: 'blue' })

    const reader = messageCommand({
      id: 'reader',
      channelMessage: '$get(color):$eval return botState.color; $halt'
    })
    const sameRequest = runMessage(
      { ...messageRequest(saved, state), commands: [saved, reader] },
      factory
    )
    expect(sameRequest.errors).toEqual([])
    expect(sameRequest.state.messages.at(-1)?.content).toBe('blue:persistent')
    const later = runMessage(messageRequest(reader, first.state), factory)
    expect(later.errors).toEqual([])
    expect(later.state.messages.at(-1)?.content).toBe('blue:persistent')
    expect(later.state.botState).toEqual({ color: 'persistent' })
    expect(later.state.variables).toEqual({ color: 'blue' })

    const changed = runMessage(
      messageRequest(
        messageCommand({ channelMessage: '$eval color = "green"; return color; $halt' }),
        later.state
      ),
      factory
    )
    expect(changed.errors).toEqual([])
    expect(changed.state.variables).toEqual({ color: 'green' })
    const observed = runMessage(messageRequest(reader, changed.state), factory)
    expect(observed.errors).toEqual([])
    expect(observed.state.messages.at(-1)?.content).toBe('green:persistent')
  })

  it('keeps untracked JavaScript globals within a command only, shared across its templates', () => {
    const writer = messageCommand({
      channelMessage: '$eval globalThis.commandOnly = "temporary"; return commandOnly; $halt',
      privateMessage: '$eval return commandOnly; $halt'
    })
    const reader = messageCommand({
      id: 'reader',
      channelMessage: '$eval return typeof globalThis.commandOnly; $halt'
    })
    const first = runMessage({ ...messageRequest(writer), commands: [writer, reader] }, factory)
    expect(first.errors).toEqual([])
    expect(first.state.messages.map((message) => message.content)).toEqual([
      '!test',
      'temporary',
      'temporary',
      'undefined'
    ])
    expect(first.state.variables).toEqual({})
    const later = runMessage(messageRequest(reader, first.state), factory)
    expect(later.errors).toEqual([])
    expect(later.state.messages.at(-1)?.content).toBe('undefined')
  })

  it('shares tracked interaction variables with embeds, DMs, button labels and later button clicks', () => {
    const saved = slashCommand({
      rootAction: action({
        sendChannelMessage: true,
        channelMessage: '$set(color,blue)$get(color)',
        sendChannelEmbed: true,
        channelEmbed: { ...blankEmbed(), title: '$get(color)' },
        sendPrivateMessage: true,
        privateMessage: '$get(color)',
        buttons: [
          {
            ...button('read', {
              sendChannelMessage: true,
              channelMessage: 'stored:$get(color)'
            }),
            label: '$get(color)'
          }
        ]
      })
    })
    const first = runInteraction(slashRequest(saved), factory)
    expect(first.errors).toEqual([])
    expect(first.state.messages[0]).toMatchObject({
      content: 'blue',
      embed: { title: 'blue' },
      buttons: [{ label: 'blue' }]
    })
    expect(first.state.messages[1].content).toBe('blue')
    expect(first.state.botState).toEqual({})
    expect(first.state.variables).toEqual({ color: 'blue' })
    const clicked = runInteraction(
      {
        kind: 'button',
        state: first.state,
        interactions: [saved],
        senderId: first.state.members[0].id,
        messageId: first.state.messages[0].id,
        customId: 'read'
      },
      factory
    )
    expect(clicked.errors).toEqual([])
    expect(clicked.state.messages.at(-1)?.content).toBe('stored:blue')
    expect(clicked.state.botState).toEqual({})
    expect(clicked.state.variables).toEqual({ color: 'blue' })
  })

  it('rolls back an attempt to replace the required botState object with a scalar', () => {
    const saved = messageCommand({
      cooldown: 5,
      cooldownType: 'Global',
      channelMessage: '$set(temporary,staged)$set(botState,scalar)'
    })
    const state = createPlaygroundState()
    state.botState = { count: 4 }
    state.variables = { theme: 'keep' }
    state.cooldowns = { 'older:global': 0 }
    const original = structuredClone(state)
    const result = runMessage(messageRequest(saved, state), factory)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('JSON')
    expect(result.state.botState).toEqual(original.botState)
    expect(result.state.variables).toEqual(original.variables)
    expect(result.state.cooldowns).toEqual(original.cooldowns)
    expect(result.state.messages).toEqual([
      { id: 1, kind: 'user', author: 'Alex', content: '!test' }
    ])
    expect(state).toEqual(original)
  })

  it('safely converts script results after an explicit variable shadows the String global', () => {
    const saved = messageCommand({
      channelMessage: '$set(String,shadow)$eval return 42; $halt:$get(String)'
    })
    const first = runMessage(messageRequest(saved), factory)
    expect(first.errors).toEqual([])
    expect(first.state.messages.at(-1)?.content).toBe('42:shadow')
    expect(first.state.variables).toEqual({ String: 'shadow' })
    expect(first.state.botState).toEqual({})
    const later = runMessage(
      messageRequest(
        messageCommand({ channelMessage: '$eval return 7; $halt:$get(String)' }),
        first.state
      ),
      factory
    )
    expect(later.errors).toEqual([])
    expect(later.state.messages.at(-1)?.content).toBe('7:shadow')
    expect(later.state.variables).toEqual({ String: 'shadow' })
  })
})

describe('playground eval template resolution', () => {
  it('pre-resolves code expressions while preserving quoted text, comments and static template text', () => {
    const saved = messageCommand({
      channelMessage: [
        '$eval',
        'const doubleQuoted = "$namePlain";',
        "const singleQuoted = '$namePlain';",
        'const staticTemplate = `$namePlain`;',
        '// $namePlain',
        '/* $namePlain */',
        'return [doubleQuoted, singleQuoted, staticTemplate, `${$namePlain}`, $sum(2,3)].join("|");',
        '$halt'
      ].join('\n')
    })
    const result = runMessage(messageRequest(saved), factory)
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('$namePlain|$namePlain|$namePlain|Alex|5')
  })

  it('does not interpret template-looking expressions inside eval literals or comments', () => {
    const saved = messageCommand({
      channelMessage: [
        '$eval',
        '// $unknown',
        '/* $unknown */',
        'return "$unknown" + `:$unknown`;',
        '$halt'
      ].join('\n')
    })
    const result = runMessage(messageRequest(saved), factory)
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('$unknown:$unknown')
  })

  it('inserts resolved slash text as a literal value including quotes, backslashes and newlines', () => {
    const text = 'A "quoted" name, a backslash \\ and a newline\n日本語'
    const saved = slashCommand({
      options: [{ name: 'text', description: 'Text', type: 3, required: true }],
      rootAction: action({
        sendChannelMessage: true,
        channelMessage: '$eval return $option(text); $halt'
      })
    })
    const result = runInteraction({ ...slashRequest(saved), options: { text } }, factory)
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].content).toBe(text)
    expect(result.state.botState).toEqual({})
  })

  it('allows more than 32 sequential shallow JavaScript template literals before an expression', () => {
    const literals = Array.from({ length: 40 }, (_, index) => `\`literal ${index}\``).join(', ')
    const saved = messageCommand({
      channelMessage: `$eval const texts = [${literals}]; return $namePlain + ":" + texts.length; $halt`
    })
    const result = runMessage(messageRequest(saved), factory)
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('Alex:40')
  })

  it('preserves an explicit variable whose name resembles an interpolation binding', () => {
    const saved = messageCommand({
      channelMessage:
        '$set(__playground_bcfd_0,keep)$eval return $namePlain $halt$get(__playground_bcfd_0)'
    })
    const first = runMessage(messageRequest(saved), factory)
    expect(first.errors).toEqual([])
    expect(first.state.messages.at(-1)?.content).toBe('Alexkeep')
    expect(first.state.variables).toEqual({ __playground_bcfd_0: 'keep' })
    const later = runMessage(
      messageRequest(messageCommand({ channelMessage: '$get(__playground_bcfd_0)' }), first.state),
      factory
    )
    expect(later.errors).toEqual([])
    expect(later.state.messages.at(-1)?.content).toBe('keep')
    expect(later.state.variables).toEqual({ __playground_bcfd_0: 'keep' })
  })

  it('keeps runtime conversion and snapshot helpers out of the script global namespace', () => {
    const saved = messageCommand({
      channelMessage:
        '$eval return [typeof botState, typeof text, typeof temp, typeof get, typeof set, typeof remove, typeof snapshot, typeof variables, typeof error].join(","); $halt'
    })
    const result = runMessage(messageRequest(saved), factory)
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe(
      ['object', ...Array(8).fill('undefined')].join(',')
    )
    expect(result.state.variables).toEqual({})
  })

  it('reports the primary interpolated script error and rolls back all staged state', () => {
    const saved = messageCommand({
      cooldown: 5,
      cooldownType: 'Global',
      channelMessage:
        '$set(temporary,staged)$eval botState.staged = true; throw new Error($namePlain); $halt'
    })
    const state = createPlaygroundState()
    state.botState = { count: 4 }
    state.variables = { theme: 'keep' }
    state.cooldowns = { 'older:global': 0 }
    const original = structuredClone(state)
    const result = runMessage(messageRequest(saved, state), factory)
    expect(result.errors).toEqual(['!test: Alex'])
    expect(result.state.botState).toEqual(original.botState)
    expect(result.state.variables).toEqual(original.variables)
    expect(result.state.cooldowns).toEqual(original.cooldowns)
    expect(result.state.messages).toEqual([
      { id: 1, kind: 'user', author: 'Alex', content: '!test' }
    ])
    expect(state).toEqual(original)
  })
})

describe('playground configurable AI mock', () => {
  it.each(['message', 'slash'] as const)(
    'returns configured inert text for %s templates',
    (kind) => {
      const state = createPlaygroundState()
      state.ai.response = 'Mock reply: $unknown, "quoted" and 日本語'
      const result =
        kind === 'message'
          ? runMessage(
              messageRequest(messageCommand({ channelMessage: '$chat(hello)' }), state),
              factory
            )
          : runInteraction(
              slashRequest(
                slashCommand({
                  rootAction: action({ sendChannelMessage: true, channelMessage: '$chat(hello)' })
                }),
                state
              ),
              factory
            )
      expect(result.errors).toEqual([])
      expect(result.state.messages.at(-1)?.content).toBe(state.ai.response)
      expect(result.state.ai).toEqual(state.ai)
      expect(state.messages).toEqual([])
    }
  )

  it.each(['message', 'slash'] as const)(
    'fails atomically on a configured AI error after staged %s script effects',
    (kind) => {
      const state = createPlaygroundState()
      state.botState = { count: 4 }
      state.ai = { response: 'ignored response', error: 'Simulated provider unavailable' }
      const channelMessage =
        '$set(temporary,staged)$eval botState.count += 1; return "staged"; $halt'
      const original = structuredClone(state)
      const result =
        kind === 'message'
          ? runMessage(
              messageRequest(
                messageCommand({
                  cooldown: 5,
                  cooldownType: 'Global',
                  channelMessage,
                  privateMessage: '$chat(hello)'
                }),
                state
              ),
              factory
            )
          : runInteraction(
              slashRequest(
                slashCommand({
                  cooldown: 5,
                  cooldownType: 'Global',
                  rootAction: action({
                    sendChannelMessage: true,
                    channelMessage,
                    sendPrivateMessage: true,
                    privateMessage: '$chat(hello)'
                  })
                }),
                state
              ),
              factory
            )
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain(state.ai.error)
      expect(result.state.botState).toEqual(original.botState)
      expect(result.state.variables).toEqual(original.variables)
      expect(result.state.cooldowns).toEqual({})
      expect(result.state.ai).toEqual(original.ai)
      expect(result.state.messages.filter((message) => message.kind !== 'user')).toEqual([])
      expect(state).toEqual(original)
    }
  )
})

describe('playground simulated cooldowns', () => {
  it.each(['User', 'Server', 'Global'] as const)(
    'uses production-shaped %s keys and independently scopes commands, senders and servers',
    (level) => {
      const saved = messageCommand({ cooldown: 5, cooldownType: level, channelMessage: 'executed' })
      const first = runMessage(messageRequest(saved), factory)
      const state = first.state
      const senderId = state.members[0].id
      const key =
        level === 'Global'
          ? 'message:global'
          : `message:${level.toLowerCase()}:${level === 'User' ? senderId : state.guildId}`
      expect(first.errors).toEqual([])
      expect(state.cooldowns).toEqual({ [key]: 0 })
      const blocked = runMessage(messageRequest(saved, state), factory)
      expect(blocked.errors).toEqual([])
      expect(blocked.state.messages.at(-1)?.content).toBe(
        'This command is on cooldown. Try again in 5s.'
      )
      expect(blocked.state.cooldowns).toEqual(state.cooldowns)

      const otherSender = runMessage(messageRequest(saved, state, state.members[1].id), factory)
      expect(otherSender.errors).toEqual([])
      expect(otherSender.state.messages.at(-1)?.content).toBe(
        level === 'User' ? 'executed' : 'This command is on cooldown. Try again in 5s.'
      )
      if (level === 'User')
        expect(otherSender.state.cooldowns).toEqual({
          [key]: 0,
          [`message:user:${state.members[1].id}`]: 0
        })
      else expect(otherSender.state.cooldowns).toEqual(state.cooldowns)

      const otherServerState = structuredClone(state)
      otherServerState.guildId = '900000000000000004'
      const otherServer = runMessage(messageRequest(saved, otherServerState), factory)
      expect(otherServer.errors).toEqual([])
      expect(otherServer.state.messages.at(-1)?.content).toBe(
        level === 'Server' ? 'executed' : 'This command is on cooldown. Try again in 5s.'
      )
      const otherCommand = runMessage(
        messageRequest(messageCommand({ ...saved, id: 'other' }), state),
        factory
      )
      expect(otherCommand.errors).toEqual([])
      expect(otherCommand.state.messages.at(-1)?.content).toBe('executed')
      expect(state.cooldowns).toEqual({ [key]: 0 })
    }
  )

  it('treats timestamp zero as recorded, rounds remaining seconds up and expires exactly on time', () => {
    const saved = messageCommand({ cooldown: 5, cooldownType: 'User', channelMessage: 'executed' })
    const first = runMessage(messageRequest(saved), factory)
    for (const [clockMs, remaining] of [
      [0, 5],
      [1, 5],
      [2001, 3],
      [4001, 1],
      [4999, 1]
    ]) {
      const state = structuredClone(first.state)
      state.clockMs = clockMs
      const blocked = runMessage(messageRequest(saved, state), factory)
      expect(blocked.errors).toEqual([])
      expect(blocked.state.messages.at(-1)?.content).toBe(
        `This command is on cooldown. Try again in ${remaining}s.`
      )
      expect(blocked.state.cooldowns).toEqual(first.state.cooldowns)
    }
    const state = structuredClone(first.state)
    state.clockMs = 5000
    const expired = runMessage(messageRequest(saved, state), factory)
    expect(expired.errors).toEqual([])
    expect(expired.state.messages.at(-1)?.content).toBe('executed')
    expect(expired.state.cooldowns).toEqual({ [`message:user:${state.members[0].id}`]: 5000 })
  })

  it('renders custom responses with configured and explicit $cooldownRemaining scopes', () => {
    const saved = messageCommand({
      cooldown: 5,
      cooldownType: 'Server',
      ignoreErrorMessage: true,
      channelMessage: 'executed',
      cooldownMessage:
        '$cooldownRemaining|$cooldownRemaining(user)|$cooldownRemaining(server)|$cooldownRemaining(global)'
    })
    const first = runMessage(messageRequest(saved), factory)
    const state = structuredClone(first.state)
    state.clockMs = 2001
    const blocked = runMessage(messageRequest(saved, state), factory)
    expect(blocked.errors).toEqual([])
    expect(blocked.state.messages.at(-1)).toMatchObject({ content: '3|0|3|0', replyTo: 3 })
    expect(blocked.state.cooldowns).toEqual(first.state.cooldowns)
  })

  it.each([false, true])(
    'honors ignoreErrorMessage=%s for the default message cooldown reply',
    (ignore) => {
      const saved = messageCommand({
        cooldown: 5,
        cooldownType: 'Global',
        ignoreErrorMessage: ignore,
        channelMessage: 'executed'
      })
      const first = runMessage(messageRequest(saved), factory)
      const blocked = runMessage(messageRequest(saved, first.state), factory)
      expect(blocked.errors).toEqual([])
      expect(blocked.state.messages).toHaveLength(ignore ? 3 : 4)
      if (!ignore)
        expect(blocked.state.messages.at(-1)).toMatchObject({
          content: 'This command is on cooldown. Try again in 5s.',
          replyTo: 3
        })
      expect(blocked.state.cooldowns).toEqual(first.state.cooldowns)
    }
  )

  it.each(['', 'Wait $cooldownRemaining seconds'])(
    'makes a blocked slash response ephemeral, including custom response %s',
    (cooldownMessage) => {
      const saved = slashCommand({
        cooldown: 5,
        cooldownType: 'Global',
        cooldownMessage,
        rootAction: action({
          sendChannelMessage: true,
          channelMessage: 'executed',
          ephemeral: false,
          deferReply: true
        })
      })
      const first = runInteraction(slashRequest(saved), factory)
      const blocked = runInteraction(slashRequest(saved, first.state), factory)
      expect(blocked.errors).toEqual([])
      expect(blocked.state.messages.at(-1)).toMatchObject({
        content: cooldownMessage
          ? 'Wait 5 seconds'
          : 'This command is on cooldown. Try again in 5s.',
        ephemeral: true,
        recipient: first.state.members[0].id
      })
      expect(blocked.state.messages.at(-1)?.deferred).not.toBe(true)
      expect(blocked.state.cooldowns).toEqual(first.state.cooldowns)
    }
  )

  it('lets buttons execute during their saved slash cooldown without recording another usage', () => {
    const saved = slashCommand({
      cooldown: 10,
      cooldownType: 'Global',
      rootAction: action({
        sendChannelMessage: true,
        channelMessage: '$eval botState.count = 1; return botState.count; $halt',
        buttons: [
          button('increment', {
            sendChannelMessage: true,
            channelMessage: '$eval botState.count += 1; return botState.count; $halt'
          })
        ]
      })
    })
    const first = runInteraction(slashRequest(saved), factory)
    const blocked = runInteraction(slashRequest(saved, first.state), factory)
    expect(blocked.errors).toEqual([])
    expect(blocked.state.botState).toEqual({ count: 1 })
    const state = structuredClone(blocked.state)
    state.clockMs = 1000
    const clicked = runInteraction(
      {
        kind: 'button',
        state,
        interactions: [saved],
        senderId: state.members[0].id,
        messageId: first.state.messages[0].id,
        customId: 'increment'
      },
      factory
    )
    expect(clicked.errors).toEqual([])
    expect(clicked.state.messages.at(-1)?.content).toBe('2')
    expect(clicked.state.botState).toEqual({ count: 2 })
    expect(clicked.state.cooldowns).toEqual({ 'slash:global': 0 })
    expect(state.botState).toEqual({ count: 1 })
  })

  it('rolls back a failing custom cooldown response without replacing the existing timestamp', () => {
    const saved = messageCommand({
      cooldown: 5,
      cooldownType: 'Global',
      channelMessage: 'executed',
      cooldownMessage: '$eval botState.staged = true; return "staged"; $halt $chat(hello)'
    })
    const first = runMessage(messageRequest(saved), factory)
    const state = structuredClone(first.state)
    state.ai.error = 'Simulated provider unavailable'
    const blocked = runMessage(messageRequest(saved, state), factory)
    expect(blocked.errors).toHaveLength(1)
    expect(blocked.errors[0]).toContain(state.ai.error)
    expect(blocked.state.botState).toEqual({})
    expect(blocked.state.cooldowns).toEqual(first.state.cooldowns)
    expect(blocked.state.messages).toHaveLength(first.state.messages.length + 1)
  })
})
