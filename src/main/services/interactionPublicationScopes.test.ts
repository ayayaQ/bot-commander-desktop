import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InteractionPublicationScopes } from './interactionPublicationScopes'

let directory: string
let path: string
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'bcfd-scopes-'))
  path = join(directory, 'scopes.json')
})
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true })
})

it('persists scopes across instances and isolates different bots', async () => {
  const store = new InteractionPublicationScopes(path)
  expect(await store.get('bot-a')).toEqual([])
  await store.remember('bot-a', 'server-a')
  await store.remember('bot-a', 'server-a')
  await store.remember('bot-b', 'server-b')
  const reopened = new InteractionPublicationScopes(path)
  expect(await reopened.get('bot-a')).toEqual(['server-a'])
  expect(await reopened.get('bot-b')).toEqual(['server-b'])
  await reopened.forget('bot-a', 'server-a')
  expect(await store.get('bot-a')).toEqual([])
  expect(await store.get('bot-b')).toEqual(['server-b'])
})

it('does not silently discard a corrupt scope ledger', async () => {
  await fs.writeFile(path, '{"bot-a": "invalid"}')
  await expect(new InteractionPublicationScopes(path).remember('bot-b', 'server')).rejects.toThrow()
  expect(await fs.readFile(path, 'utf8')).toBe('{"bot-a": "invalid"}')
})

it('reports storage failures', async () => {
  await fs.mkdir(path)
  await expect(new InteractionPublicationScopes(path).remember('bot', 'server')).rejects.toThrow()
})
