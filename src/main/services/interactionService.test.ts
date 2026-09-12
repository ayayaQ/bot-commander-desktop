import { beforeEach, expect, it } from 'vitest'
import { findInteractionByCommandName, setInteractions } from './interactionService'
import type { BCFDInteractionCommand } from '../types/types'

const command = (id: string, guildId?: string): BCFDInteractionCommand => ({
  id,
  guildId,
  commandName: 'hello',
  commandDescription: id,
  options: [],
  rootAction: {} as BCFDInteractionCommand['rootAction'],
  isRegistered: true
})

beforeEach(() => {
  setInteractions([command('server-a', 'a'), command('global'), command('server-b', 'b')])
})

it('resolves identical names using the registered command scope', () => {
  expect(findInteractionByCommandName('hello', 'a')?.id).toBe('server-a')
  expect(findInteractionByCommandName('hello', 'b')?.id).toBe('server-b')
})

it('resolves global commands in both DMs and servers using a null command scope', () => {
  expect(findInteractionByCommandName('hello', null)?.id).toBe('global')
})

it('does not execute another scope when the invoked definition has been deleted or moved', () => {
  expect(findInteractionByCommandName('hello', 'unknown')).toBeUndefined()
  setInteractions([command('server-a', 'a')])
  expect(findInteractionByCommandName('hello', null)).toBeUndefined()
})
