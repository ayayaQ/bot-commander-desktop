import { describe, expect, it } from 'vitest'
import {
  addPlaygroundMember,
  commandEventDraft,
  playgroundFeedback,
  setPlaygroundResourceEnabled
} from './playgroundControls'
import { normalizeWorld, selectWorldContext } from '../../../shared/playground/world'
import { validateAgentValidationState } from '../../../shared/playground/agentValidationFixtures'
import { PLAYGROUND_LIMITS, type PlaygroundResult } from '../../../shared/playground/types'

describe('simplified playground controls', () => {
  it.each(['command', 'interaction'])(
    'preserves hidden enabled and disabled %s selections across filtered toggles',
    (kind) => {
      const visible = `${kind}-visible`
      const hiddenEnabled = `${kind}-hidden-enabled`
      const hiddenDisabled = `${kind}-hidden-disabled`
      const original = Object.freeze([visible, hiddenEnabled])

      const disabled = setPlaygroundResourceEnabled(original, visible, false)
      expect(disabled).toEqual([hiddenEnabled])
      const enabled = setPlaygroundResourceEnabled(disabled, visible, true)
      expect(enabled).toHaveLength(2)
      expect(enabled).toEqual(expect.arrayContaining([visible, hiddenEnabled]))
      expect(enabled).not.toContain(hiddenDisabled)
      expect(original).toEqual([visible, hiddenEnabled])
    }
  )

  it('updates command and interaction sets independently even when IDs match', () => {
    const commands = ['shared-id', 'hidden-command']
    const interactions = ['shared-id', 'hidden-interaction']
    const nextCommands = setPlaygroundResourceEnabled(commands, 'shared-id', false)
    expect(nextCommands).toEqual(['hidden-command'])
    expect(interactions).toEqual(['shared-id', 'hidden-interaction'])

    const nextInteractions = setPlaygroundResourceEnabled(interactions, 'shared-id', false)
    expect(setPlaygroundResourceEnabled(nextCommands, 'shared-id', true)).toEqual([
      'hidden-command',
      'shared-id'
    ])
    expect(nextInteractions).toEqual(['hidden-interaction'])
    expect(commands).toEqual(['shared-id', 'hidden-command'])
  })

  it('repeated enable and disable do not duplicate IDs or mutate earlier selections', () => {
    const original = Object.freeze(['hidden-enabled'])
    const enabled = setPlaygroundResourceEnabled(original, 'visible', true)
    expect(setPlaygroundResourceEnabled(enabled, 'visible', true)).toEqual(enabled)
    const disabled = setPlaygroundResourceEnabled(enabled, 'visible', false)
    expect(disabled).toEqual(['hidden-enabled'])
    expect(setPlaygroundResourceEnabled(disabled, 'visible', false)).toEqual(disabled)
    expect(enabled).toEqual(['hidden-enabled', 'visible'])
    expect(original).toEqual(['hidden-enabled'])
  })

  it('prepares each saved command event without sending a message for member events', () => {
    expect(commandEventDraft({ command: '!ping', type: 0 })).toEqual({
      mode: 'message',
      content: '!ping'
    })
    expect(commandEventDraft({ command: '!private', type: 1 })).toEqual({
      mode: 'dm',
      content: '!private'
    })
    for (const type of [2, 3, 4] as const)
      expect(commandEventDraft({ command: 'welcome', type }).content).toBe('')
    expect(commandEventDraft({ command: '👍', type: 5 })).toEqual({
      mode: 'reaction',
      content: '👍'
    })
  })

  it('adds a valid canonical member that survives context changes without extra permissions', () => {
    const world = normalizeWorld()
    const id = addPlaygroundMember(world, '  Taylor  ')
    const secondId = addPlaygroundMember(world, 'Casey')
    expect(secondId).not.toBe(id)
    selectWorldContext(world, { guildId: world.guildId, channelId: world.channelId })
    expect(world.members.find((member) => member.id === id)).toMatchObject({
      name: 'Taylor',
      roles: [],
      permissions: [],
      kicked: false,
      banned: false
    })
    expect(world.members.find((member) => member.id === id)?.bot).not.toBe(true)
    expect(world.world?.memberships.find((member) => member.id === id)?.guildId).toBe(world.guildId)
    expect(() => validateAgentValidationState(world)).not.toThrow()
  })

  it('rejects blank names, a DM context and member limits without adding entities', () => {
    const world = normalizeWorld()
    const before = structuredClone(world)
    expect(() => addPlaygroundMember(world, '   ')).toThrow('member name')
    expect(world).toEqual(before)
    world.guildId = ''
    expect(() => addPlaygroundMember(world, 'Taylor')).toThrow('server channel')
    world.guildId = before.guildId
    while (world.world!.users.length < PLAYGROUND_LIMITS.members)
      addPlaygroundMember(world, 'Another member')
    const atLimit = structuredClone(world)
    expect(() => addPlaygroundMember(world, 'Overflow')).toThrow('member limit')
    expect(world).toEqual(atLimit)
  })

  it('surfaces unmatched triggers, permission blocks and incomplete runs outside diagnostics', () => {
    const result: PlaygroundResult = {
      state: normalizeWorld(),
      trace: [],
      errors: [],
      resources: []
    }
    expect(playgroundFeedback(result)[0]).toContain('No saved command matched')
    result.resources = [
      {
        resourceId: 'ping',
        kind: 'command',
        matched: true,
        executed: false,
        outcome: 'blocked',
        reason: 'Administrator required'
      }
    ]
    expect(playgroundFeedback(result)).toEqual(['Administrator required'])
    result.warnings = ['Delivery failed']
    result.incomplete = ['Operation budget reached']
    expect(playgroundFeedback(result)).toContain('Simulation incomplete: Operation budget reached')
    expect(playgroundFeedback(result)).toContain('Delivery failed')
    result.resources[0].outcome = 'executed'
    result.resources[0].executed = true
    delete result.warnings
    delete result.incomplete
    expect(playgroundFeedback(result)).toEqual([])
  })
})
