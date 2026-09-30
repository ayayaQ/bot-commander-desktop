import { describe, expect, it } from 'vitest'
import type {
  BCFDInteractionAction,
  BCFDInteractionCommand,
  BCFDSlashCommandOption
} from '../main/types/types'
import { createPlaygroundFixture, type PlaygroundRequest } from './playground'
import { runPlaygroundSimulation } from './playgroundEngine'

const action = (changes: Partial<BCFDInteractionAction> = {}): BCFDInteractionAction => ({
  sendChannelMessage: true,
  channelMessage: 'Hello $namePlain: $option(text)',
  sendPrivateMessage: false,
  privateMessage: '',
  sendChannelEmbed: false,
  channelEmbed: {
    title: '',
    description: '',
    hexColor: '',
    imageURL: '',
    thumbnailURL: '',
    footer: ''
  },
  sendPrivateEmbed: false,
  privateEmbed: {
    title: '',
    description: '',
    hexColor: '',
    imageURL: '',
    thumbnailURL: '',
    footer: ''
  },
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
  ...changes
})

const options: BCFDSlashCommandOption[] = [
  { name: 'text', description: 'Text', type: 3, required: true },
  { name: 'count', description: 'Count', type: 4, required: false },
  { name: 'enabled', description: 'Enabled', type: 5, required: false },
  { name: 'target', description: 'Target', type: 6, required: false },
  {
    name: 'choice',
    description: 'Choice',
    type: 3,
    required: false,
    choices: [{ name: 'A', value: 'a' }]
  }
]

const command = (changes: Partial<BCFDInteractionCommand> = {}): BCFDInteractionCommand => ({
  id: 'slash-1',
  commandName: 'hello',
  commandDescription: 'Test command',
  options,
  rootAction: action(),
  isRegistered: false,
  ...changes
})

const request = (
  interaction = command(),
  values: Record<string, string | number | boolean> = { text: 'world' },
  buttonPath?: string[]
): PlaygroundRequest => {
  const fixture = createPlaygroundFixture()
  return {
    commands: [],
    interactions: [interaction],
    fixture,
    senderId: fixture.members[0].id,
    message: `/${interaction.commandName}`,
    interaction: { commandId: interaction.id, options: values, buttonPath }
  }
}

describe('offline slash-command playground', () => {
  it('renders $option values with production string conversion and raw user IDs', () => {
    const interaction = command({
      rootAction: action({
        channelMessage: '$option(text)|$option(count)|$option(target)|$option(missing)'
      })
    })
    const input = request(interaction, {
      text: 'hello',
      count: 4,
      target: '300000000000000002'
    })
    const result = runPlaygroundSimulation(input)
    expect(result.outputs[0]).toMatchObject({
      text: 'hello|4|300000000000000002|',
      destination: '#playground'
    })
    expect(result.traces[0].status).toBe('ran')
  })

  it.each([
    [{}, 'text is required'],
    [{ text: 'ok', count: 1.5 }, 'count must be an integer'],
    [{ text: 'ok', enabled: 'yes' }, 'enabled must be true or false'],
    [{ text: 'ok', target: 'Alex' }, 'target must be a fake Discord ID'],
    [{ text: 'ok', choice: 'b' }, 'choice must use one of its configured choices'],
    [{ text: 'ok', surprise: 'value' }, 'Unknown option: surprise']
  ])('rejects invalid option payload %j', (values, issue) => {
    const result = runPlaygroundSimulation(request(command(), values as Record<string, string>))
    expect(result.outputs).toEqual([])
    expect(result.traces[0].status).toBe('filtered')
    expect(result.traces[0].issues).toContain(issue)
  })

  it('honors action flags, zero-width fallback, ephemeral/deferred replies and DM ordering', () => {
    const interaction = command({
      rootAction: action({
        sendChannelMessage: false,
        channelMessage: '$notSupported(hidden)',
        ephemeral: true,
        deferReply: true,
        sendPrivateMessage: true,
        privateMessage: 'Private $namePlain'
      })
    })
    const result = runPlaygroundSimulation(request(interaction))
    expect(result.outputs[0]).toMatchObject({
      text: '\u200B',
      ephemeral: true,
      destination: 'Only Alex'
    })
    expect(result.outputs[1]).toMatchObject({ text: 'Private Alex', destination: 'DM to Alex' })
    expect(result.traces[0].actions[0]).toContain('deferred ephemeral interaction reply')
  })

  it('returns clickable nested fake buttons and bypasses slash validation on button clicks', () => {
    const interaction = command({
      rootAction: action({
        buttons: [
          {
            customId: 'next',
            label: 'Next $namePlain',
            style: 1,
            disabled: false,
            action: action({ channelMessage: 'Nested', buttons: [] })
          }
        ]
      })
    })
    const first = runPlaygroundSimulation(request(interaction))
    expect(first.outputs[0]).toMatchObject({
      interactionOptions: { text: 'world' },
      buttons: [{ label: 'Next Alex', path: ['next'] }]
    })
    const second = runPlaygroundSimulation(
      request(interaction, first.outputs[0].interactionOptions, ['next'])
    )
    expect(second.outputs[0].text).toBe('Nested')
    expect(second.traces[0].command).toContain('→ Next $namePlain')
  })

  it('runs moderation before replies and keeps all changes inside the cloned fixture', () => {
    const interaction = command({
      rootAction: action({ isBan: true, targetUserOptionName: 'target' })
    })
    const input = request(interaction, {
      text: 'ok',
      target: inputTarget()
    })
    const result = runPlaygroundSimulation(input)
    expect(result.fixture.members[1].status).toBe('banned')
    expect(input.fixture.members[1].status).toBe('active')
    expect(result.traces[0].actions[0]).toContain('Simulated moderation')
  })

  it('fails closed before effects for unsupported templates and deletion', () => {
    for (const rootAction of [
      action({ roleToAssign: 'changed', isRoleAssigner: true, channelMessage: '$chat(secret)' }),
      action({ deleteX: true, deleteNum: 10, roleToAssign: 'changed', isRoleAssigner: true })
    ]) {
      const input = request(command({ rootAction }))
      const result = runPlaygroundSimulation(input)
      expect(result.traces[0].status).toBe('unsupported')
      expect(result.outputs).toEqual([])
      expect(result.fixture).toEqual(input.fixture)
    }
  })
})

function inputTarget() {
  return createPlaygroundFixture().members[1].id
}
