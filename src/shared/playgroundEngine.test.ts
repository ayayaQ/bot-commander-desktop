import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { decodeBCFDCommand, decodeBCFDCommandArray } from './commandCodec'
import { createPlaygroundFixture, type PlaygroundRequest } from './playground'
import { playgroundMatches, runPlaygroundSimulation } from './playgroundEngine'
import { Interpreter } from '../main/services/bcfdLang/interpreter'

// Parity tests use production pure template evaluation, with all privileged
// dependencies replaced before module initialization. The shipped worker never
// imports this interpreter.
vi.mock('../main/services/botService', () => ({
  getCommands: vi.fn(() => {
    throw new Error('Live bot access')
  })
}))
vi.mock('../main/services/settingsService', () => ({
  getSettings: vi.fn(() => {
    throw new Error('Settings access')
  })
}))
vi.mock('../main/services/aiProviderService', () => ({
  createAiChatCompletion: vi.fn(() => {
    throw new Error('AI access')
  }),
  moderateTextWithOpenAI: vi.fn(() => {
    throw new Error('AI access')
  })
}))
vi.mock('../main/services/bcfdLang/keywordHelpers', () => ({
  mutualGuildCount: vi.fn(),
  setBotStatus: vi.fn()
}))

const command = (changes: Record<string, unknown> = {}) =>
  decodeBCFDCommand(
    {
      command: '!hello',
      commandDescription: 'Test',
      type: 0,
      channelMessage: 'Hello $namePlain',
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {},
      ...changes
    },
    () => 'test'
  ).command
const request = (changes: Partial<PlaygroundRequest> = {}): PlaygroundRequest => {
  const fixture = createPlaygroundFixture()
  return {
    commands: [command()],
    fixture,
    senderId: fixture.members[0].id,
    message: '!hello',
    ...changes
  }
}

describe('offline playground simulation', () => {
  it.each([
    ['!hello', {}, true],
    ['!HELLO', {}, false],
    ['!hello there', {}, false],
    ['!hellothere', { startsWith: true }, true],
    ['x !HELLO y', { phrase: true }, true],
    ['anything', { command: '*' }, true],
    ['!hello <@1>', { isKick: true }, true],
    ['!hello  <@1>', { isKick: true }, false],
    ['!hello', { type: 1 }, false]
  ])('matches production trigger semantics for %s', (message, changes, expected) => {
    expect(playgroundMatches(command(changes), message)).toBe(expected)
  })

  it.each([
    'Hi $namePlain $$ $upper(ada)',
    '$message | $messageAfterCommand | $args(0) | $argsCount',
    '$if(2x > 1 & !false)yes$else no$endif',
    '$if(false)no$elseif(00)yes$else no$endif',
    '$if(A == a)no$else yes$endif',
    '$if(0 | False)yes$endif',
    '$contains($lower(HELLO), ell) $wordCount(a b) $length(abc)',
    '$name $ID $channel $channelID $channelAsMention $channelIsNSFW $serverID'
  ])('matches production template semantics: %s', async (template) => {
    const input = request({
      commands: [command({ channelMessage: template, startsWith: true })],
      message: '!hello one  two'
    })
    const actual = runPlaygroundSimulation(input)
    const expected = await new Interpreter().interpret(template, {
      user: { id: input.senderId, displayName: 'Alex' } as never,
      messageEvent: { content: input.message } as never,
      command: input.commands[0],
      textChannel: {
        id: input.fixture.channelId,
        name: input.fixture.channelName,
        nsfw: false
      } as never,
      guild: { id: input.fixture.guildId } as never
    })
    expect(expected.errors).toEqual([])
    expect(actual.traces[0].issues).toEqual([])
    expect(actual.outputs[0].text).toBe(expected.output)
  })

  it('reports all filters and does not produce effects when one fails', () => {
    const input = request({
      commands: [
        command({
          requiredRole: 'missing',
          channelWhitelist: 'wrong',
          serverWhitelist: 'wrong',
          isAdmin: true,
          isNSFW: true
        })
      ]
    })
    input.senderId = input.fixture.members[1].id
    const result = runPlaygroundSimulation(input)
    expect(result.traces[0].checks.slice(1).map((check) => check.passed)).toEqual([
      false,
      false,
      false,
      false,
      false
    ])
    expect(result.outputs).toEqual([])
  })

  it('checks role IDs exactly, and toggles roles on sender instead of mention', () => {
    const input = request({
      commands: [command({ startsWith: true, requiredRole: 'moderator', roleToAssign: 'member' })]
    })
    input.message += ` <@${input.fixture.members[1].id}>`
    const first = runPlaygroundSimulation(input)
    expect(first.fixture.members[0].roles).toEqual(['moderator', 'member'])
    expect(first.fixture.members[1].roles).toEqual(['member'])
    const second = runPlaygroundSimulation({ ...input, fixture: first.fixture })
    expect(second.fixture.members[0].roles).toEqual(['moderator'])
    expect(input.fixture.members[0].roles).toEqual(['moderator'])
  })

  it.each(['isKick', 'isBan', 'isVoiceMute'])('simulates %s only against fake members', (flag) => {
    const input = request({ commands: [command({ [flag]: true })] })
    input.message += ` <@${input.fixture.members[1].id}>`
    const result = runPlaygroundSimulation(input)
    expect(result.fixture.members[1]).toMatchObject(
      flag === 'isVoiceMute' ? { muted: true } : { status: flag === 'isKick' ? 'kicked' : 'banned' }
    )
    expect(input.fixture.members[1].status).toBe('active')
    expect(input.fixture.members[1].muted).toBe(false)
    expect(createPlaygroundFixture()).toEqual(input.fixture)
  })

  it('requires fake moderation permission and prevents inactive senders', () => {
    const input = request({ commands: [command({ isBan: true, roleToAssign: 'extra' })] })
    input.senderId = input.fixture.members[1].id
    input.message += ` <@${input.fixture.members[2].id}>`
    const result = runPlaygroundSimulation(input)
    expect(result.fixture).toEqual(input.fixture)
    expect(result.traces[0].actions.join()).toContain('lacks moderation permission')
    input.fixture.members[1].status = 'banned'
    expect(() => runPlaygroundSimulation(input)).toThrow('active fake sender')
  })

  it('renders messages, replies, embeds and DM destinations without loading URLs', () => {
    const input = request({
      commands: [
        command({
          channelMessageAsReply: true,
          privateMessage: 'Private $namePlain',
          channelEmbed: {
            title: '$upper(hello)',
            description: '$message',
            imageURL: 'https://example.com/image.png'
          },
          reaction: '🎉'
        })
      ]
    })
    const result = runPlaygroundSimulation(input)
    expect(result.outputs).toHaveLength(3)
    expect(result.outputs[0]).toMatchObject({ reply: true, text: 'Hello Alex' })
    expect(result.outputs[1]).toMatchObject({ destination: 'DM to Alex', text: 'Private Alex' })
    expect(result.outputs[2].embed).toMatchObject({
      title: 'HELLO',
      imageURL: 'https://example.com/image.png'
    })
    expect(result.traces[0].actions).toContain('Simulated reaction: 🎉')
  })

  it.each([
    { channelMessage: '$eval botState.x = 1; fetch("https://example.com") $halt' },
    { channelMessage: '$if(false)$chat(secret)$else safe$endif' },
    { channelMessage: '$upper($deleteChannel(123))' },
    { privateEmbed: { footer: '$set(secret,value)' } },
    { roleToAssign: '$eval botState.x=1 $halt' },
    { cooldown: 10, cooldownType: 'User' },
    { deleteNum: 1 },
    { deleteAfter: true },
    { specificChannel: '123' }
  ])('fails closed before all effects for %j', (changes) => {
    const input = request({ commands: [command({ roleToAssign: 'changed', ...changes })] })
    const snapshot = JSON.stringify(input)
    const result = runPlaygroundSimulation(input)
    expect(result.traces[0].status).toBe('unsupported')
    expect(result.outputs).toEqual([])
    expect(result.traces[0].actions).toEqual([])
    expect(result.fixture).toEqual(input.fixture)
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('preserves fixture-only botState and returns independently cloned before/after state', () => {
    const input = request()
    input.fixture.botState = { nested: { value: 2 } }
    const first = runPlaygroundSimulation(input)
    const second = runPlaygroundSimulation(input)
    expect(first).toEqual(second)
    expect(first.stateBefore).toEqual(first.stateAfter)
    first.stateBefore.nested = 'changed'
    first.fixture.botState.nested = 'changed'
    expect(input.fixture.botState).toEqual({ nested: { value: 2 } })
    expect(first.stateAfter).toEqual({ nested: { value: 2 } })
  })

  it('validates the isolated desktop QA seed and rejects its hidden script', () => {
    const seed = JSON.parse(readFileSync('docs/playground-qa-commands.json', 'utf8'))
    const commands = decodeBCFDCommandArray(seed.bcfdCommands).map((entry) => entry.command)
    expect(commands).toHaveLength(8)
    const result = runPlaygroundSimulation(request({ commands, message: '!blocked' }))
    expect(result.outputs).toEqual([])
    expect(result.traces.find((trace) => trace.command === '!blocked')?.status).toBe('unsupported')
    expect(result.fixture).toEqual(createPlaygroundFixture())
  })

  it('bounds workloads', () => {
    expect(() => runPlaygroundSimulation(request({ message: 'x'.repeat(4001) }))).toThrow('4,000')
    expect(() =>
      runPlaygroundSimulation(request({ commands: Array(101).fill(command()) }))
    ).toThrow('100 commands')
    expect(
      runPlaygroundSimulation(
        request({ commands: [command({ channelMessage: 'x'.repeat(16001) })] })
      ).traces[0].status
    ).toBe('unsupported')
  })
})
