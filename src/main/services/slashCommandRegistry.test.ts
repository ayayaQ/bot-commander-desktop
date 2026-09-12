import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BCFDInteractionCommand } from '../types/types'

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  getScopes: vi.fn(),
  rememberScope: vi.fn(),
  forgetScope: vi.fn()
}))
vi.mock('electron', () => ({ app: { getPath: () => '/test-user-data' } }))
vi.mock('./interactionPublicationScopes', () => ({
  InteractionPublicationScopes: class {
    get = mocks.getScopes
    remember = mocks.rememberScope
    forget = mocks.forgetScope
  }
}))
vi.mock('./botService', () => ({ getClient: mocks.getClient }))
vi.mock('discord.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('discord.js')>()
  return {
    ...original,
    REST: class {
      setToken() {
        return this
      }
      put = mocks.put
      post = mocks.post
      get = mocks.get
      delete = mocks.delete
    }
  }
})
import { createInteractionPublishBackend } from './slashCommandRegistry'

const command = {
  id: 'test',
  commandName: 'hello',
  commandDescription: 'Greeting',
  guildId: 'server',
  options: [
    {
      name: 'color',
      description: 'Color',
      type: 3,
      required: false,
      choices: [{ name: 'Blue', value: 'blue' }]
    }
  ]
} as BCFDInteractionCommand

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getScopes.mockResolvedValue([])
  mocks.rememberScope.mockResolvedValue(undefined)
  mocks.forgetScope.mockResolvedValue(undefined)
  mocks.getClient.mockReturnValue({
    isReady: () => true,
    token: 'test-token',
    user: { id: 'app' },
    guilds: { cache: new Map([['server', {}]]) }
  })
})

describe('Discord publication backend', () => {
  it('routes global and server replacements correctly and preserves option choices', async () => {
    const backend = createInteractionPublishBackend()
    await backend.replace('', [])
    await backend.replace('server', [command])
    expect(mocks.put).toHaveBeenNthCalledWith(1, '/applications/app/commands', { body: [] })
    expect(mocks.put).toHaveBeenNthCalledWith(2, '/applications/app/guilds/server/commands', {
      body: [{ name: 'hello', description: 'Greeting', options: command.options }]
    })
  })

  it('reports a missing server instead of silently sending its commands globally', async () => {
    await expect(
      createInteractionPublishBackend().replace('missing', [command])
    ).rejects.toMatchObject({ feedback: { code: 'server-missing' } })
    expect(mocks.put).not.toHaveBeenCalled()
  })

  it('waits for individual registration and propagates Discord failures', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Rejected'))
    await expect(createInteractionPublishBackend().register(command)).rejects.toThrow('Rejected')
    expect(mocks.post).toHaveBeenCalledWith(
      '/applications/app/guilds/server/commands',
      expect.anything()
    )
  })

  it('unregisters only the matching slash command in its original scope', async () => {
    mocks.get.mockResolvedValue([
      { id: 'context', name: 'hello', type: 2 },
      { id: 'slash', name: 'hello', type: 1 }
    ])
    await createInteractionPublishBackend().unregister(command)
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith(
      '/applications/app/guilds/server/commands/slash'
    )
  })

  it('rejects offline bots and detects a replaced connection', () => {
    const backend = createInteractionPublishBackend()
    mocks.getClient.mockReturnValue(null)
    expect(backend.isCurrent()).toBe(false)
    expect(() => createInteractionPublishBackend()).toThrow('bot-required')
  })

  it('remembers a server before publishing, even when Discord fails', async () => {
    mocks.put.mockImplementationOnce(async () => {
      expect(mocks.rememberScope).toHaveBeenCalledWith('app', 'server')
      throw new Error('Response lost')
    })
    await expect(createInteractionPublishBackend().replace('server', [command])).rejects.toThrow(
      'Response lost'
    )
    expect(mocks.forgetScope).not.toHaveBeenCalled()
  })

  it('tracks individual registrations and forgets a server only after confirmed empty replacement', async () => {
    const backend = createInteractionPublishBackend()
    await backend.register(command)
    expect(mocks.rememberScope).toHaveBeenCalledWith('app', 'server')
    mocks.put.mockImplementationOnce(async () => {
      expect(mocks.forgetScope).not.toHaveBeenCalled()
    })
    await backend.replace('server', [])
    expect(mocks.forgetScope).toHaveBeenCalledWith('app', 'server')
  })

  it('does not contact Discord when the scope cannot be persisted', async () => {
    mocks.rememberScope.mockRejectedValueOnce(new Error('Disk full'))
    await expect(createInteractionPublishBackend().register(command)).rejects.toMatchObject({
      feedback: { code: 'scope-save-failed' }
    })
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('reads managed scopes for the captured application only', async () => {
    mocks.getScopes.mockResolvedValue(['server'])
    expect(await createInteractionPublishBackend().managedGuildIds()).toEqual(['server'])
    expect(mocks.getScopes).toHaveBeenCalledWith('app')
  })

  it('does not publish after the connection changes while saving the scope', async () => {
    mocks.rememberScope.mockImplementationOnce(async () => {
      mocks.getClient.mockReturnValue(null)
    })
    await expect(createInteractionPublishBackend().register(command)).rejects.toMatchObject({
      feedback: { code: 'connection-changed' }
    })
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
