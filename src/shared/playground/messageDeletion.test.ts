import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DELETE_MESSAGE_ERRORS } from '../deleteMessage'
import { decodeBCFDCommand } from '../commandCodec'
import { runMessage } from './engine'
import { runInteraction } from './interactions'
import { evaluateTemplate } from './template'
import { createPlaygroundState } from './types'
import type { PlaygroundState } from './types'
import type { BCFDInteractionAction, BCFDInteractionCommand } from '../../main/types/types'

function command(source: string) {
  return decodeBCFDCommand({
    id: 'delete',
    command: '!delete',
    commandDescription: 'Delete one local message',
    type: 0,
    startsWith: true,
    channelMessage: source,
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {}
  }).command
}

function fakeState(): PlaygroundState {
  const state = createPlaygroundState()
  state.messages = [
    { id: 1, kind: 'bot', author: 'Playground Bot', content: 'first' },
    { id: 2, kind: 'user', author: 'Alex', content: 'second' },
    { id: 3, kind: 'dm', author: 'Playground Bot', content: 'DM' },
    { id: 4, kind: 'bot', author: 'Playground Bot', content: 'ephemeral', ephemeral: true },
    { id: 5, kind: 'bot', author: 'Playground Bot', content: 'deleted', deleted: true }
  ]
  state.nextId = 6
  return state
}

function interaction(source: string): BCFDInteractionCommand {
  const embed = {
    title: '',
    description: '',
    hexColor: '',
    imageURL: '',
    thumbnailURL: '',
    footer: ''
  }
  const action: BCFDInteractionAction = {
    sendChannelMessage: true,
    channelMessage: source,
    sendPrivateMessage: false,
    privateMessage: '',
    sendChannelEmbed: false,
    channelEmbed: embed,
    sendPrivateEmbed: false,
    privateEmbed: embed,
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
    buttons: []
  }
  return {
    id: 'slash',
    commandName: 'delete',
    commandDescription: 'Delete',
    isRegistered: false,
    options: [{ name: 'messageid', description: 'ID', type: 3, required: true }],
    rootAction: action
  }
}

describe('strictly local Playground deleteMessage', () => {
  it.each(['1', '2'])('deletes just fake message %s without sender permission gates', (id) => {
    const state = fakeState()
    const before = structuredClone(state)
    const result = runMessage({
      state,
      commands: [command('before$deleteMessage($args(0))after')],
      senderId: state.members[1].id,
      content: `!delete ${id}`
    })
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('beforeafter')
    expect(result.state.messages.slice(0, 5).map((item) => !!item.deleted)).toEqual([
      id === '1',
      id === '2',
      false,
      false,
      true
    ])
    expect(result.trace).toContain(`Simulated deleteMessage: deleted fake channel message ${id}`)
    expect(state).toEqual(before)
  })

  it.each(['3', '4', '5', '999', '18446744073709551615'])(
    'excludes missing/DM/ephemeral/deleted target %s',
    (id) => {
      const state = fakeState()
      const result = runMessage({
        state,
        commands: [command(`$deleteMessage(${id})`)],
        senderId: state.members[1].id,
        content: '!delete'
      })
      expect(result.errors).toEqual([])
      expect(result.state.messages.at(-1)?.content).toBe(DELETE_MESSAGE_ERRORS.missingMessage)
      expect(result.state.messages.slice(0, 5)).toEqual(state.messages)
      expect(result.trace.some((entry) => entry.startsWith('Simulated deleteMessage'))).toBe(false)
    }
  )

  it('returns NOT_FOUND when repeating deletion and keeps the first successful local effect', () => {
    const state = fakeState()
    const result = runMessage({
      state,
      commands: [command('$deleteMessage(1)$deleteMessage(1)')],
      senderId: state.members[1].id,
      content: '!delete'
    })
    expect(result.errors).toEqual([])
    expect(result.state.messages[0].deleted).toBe(true)
    expect(result.state.messages.at(-1)?.content).toBe(DELETE_MESSAGE_ERRORS.missingMessage)
    expect(
      result.trace.filter((entry) => entry.startsWith('Simulated deleteMessage'))
    ).toHaveLength(1)
  })

  it.each([
    ['$deleteMessage()', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage(1,)', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage{1|}', DELETE_MESSAGE_ERRORS.arity],
    ['$deleteMessage($option(missing))', DELETE_MESSAGE_ERRORS.invalidId],
    ['$deleteMessage(01)', DELETE_MESSAGE_ERRORS.invalidId],
    ['$deleteMessage(18446744073709551616)', DELETE_MESSAGE_ERRORS.invalidId]
  ])('matches production inline validation for %s with no mutation', (source, expected) => {
    const state = fakeState()
    const before = structuredClone(state)
    expect(
      evaluateTemplate(source, {
        state,
        sender: state.members[1],
        trigger: '',
        content: ''
      })
    ).toBe(expected)
    expect(state).toEqual(before)
  })

  it('supports evaluated slash string options and button literals in the same fake channel', () => {
    const state = fakeState()
    const saved = interaction('$deleteMessage($option(messageid))slash done')
    saved.rootAction.buttons = [
      {
        label: 'Delete second',
        customId: 'delete-second',
        style: 1,
        disabled: false,
        action: { ...saved.rootAction, channelMessage: '$deleteMessage(2)button done', buttons: [] }
      }
    ]
    const slash = runInteraction({
      kind: 'slash',
      state,
      interactions: [saved],
      senderId: state.members[1].id,
      commandId: saved.id,
      options: { messageid: ' 1 ' }
    })
    expect(slash.errors).toEqual([])
    expect(slash.state.messages[0].deleted).toBe(true)
    expect(slash.state.messages.at(-1)?.content).toBe('slash done')
    const clicked = runInteraction({
      kind: 'button',
      state: slash.state,
      interactions: [saved],
      senderId: state.members[1].id,
      messageId: slash.state.messages.at(-1)!.id,
      customId: 'delete-second'
    })
    expect(clicked.errors).toEqual([])
    expect(clicked.state.messages[1].deleted).toBe(true)
    expect(clicked.state.messages.at(-1)?.content).toBe('button done')
    expect(state.messages[0].deleted).toBeUndefined()
    expect(slash.state.messages[1].deleted).toBeUndefined()
  })

  it('keeps successful fake deletion atomic when a later execution failure occurs', () => {
    const state = fakeState()
    const result = runMessage({
      state,
      commands: [command('$deleteMessage(1)$sum(not-a-number)')],
      senderId: state.members[1].id,
      content: '!delete'
    })
    expect(result.errors).toHaveLength(1)
    expect(result.state.messages.slice(0, 5)).toEqual(state.messages)
    expect(result.trace).not.toContain('Simulated deleteMessage: deleted fake channel message 1')
  })

  it('displays the local target ID in each transcript entry', () => {
    const renderer = readFileSync('src/renderer/src/components/Playground.svelte', 'utf8')
    expect(renderer).toContain('Fake message ID: {message.id}')
  })
})
