import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const mocks = vi.hoisted(() => ({
  appGetPath: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: mocks.appGetPath
  }
}))

vi.mock('openai', () => ({
  default: vi.fn()
}))

describe('chatService persistence', () => {
  let userDataPath: string

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    userDataPath = await fs.mkdtemp(join(tmpdir(), 'bcfd-chat-service-'))
    mocks.appGetPath.mockReturnValue(userDataPath)
  })

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true })
  })

  it('creates an empty chats file when none exists', async () => {
    const { loadChats } = await import('./chatService')

    await expect(loadChats()).resolves.toEqual({ chats: [], activeChat: null })
    await expect(fs.readFile(join(userDataPath, 'chats.json'), 'utf-8')).resolves.toContain(
      '"chats": []'
    )
  })

  it('recovers a valid JSON prefix and backs up the corrupt file', async () => {
    const validData = {
      chats: [
        {
          id: 'chat-1',
          title: 'Recovered',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          contexts: []
        }
      ],
      activeChat: 'chat-1'
    }
    await fs.writeFile(join(userDataPath, 'chats.json'), `${JSON.stringify(validData)}garbage`)
    const { loadChats } = await import('./chatService')

    await expect(loadChats()).resolves.toEqual(validData)

    const files = await fs.readdir(userDataPath)
    expect(files.some((file) => file.startsWith('chats.json.corrupt-'))).toBe(true)
    await expect(fs.readFile(join(userDataPath, 'chats.json'), 'utf-8')).resolves.toBe(
      JSON.stringify(validData, null, 2)
    )
  })

  it('updates active chat after deleting the current chat', async () => {
    const { deleteChat, getChats, setChats } = await import('./chatService')
    setChats({
      activeChat: 'chat-1',
      chats: [
        {
          id: 'chat-1',
          title: 'First',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          contexts: []
        },
        {
          id: 'chat-2',
          title: 'Second',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          messages: [],
          contexts: []
        }
      ]
    })

    expect(deleteChat('chat-1')).toBe(true)
    expect(getChats().activeChat).toBe('chat-2')
  })
})
