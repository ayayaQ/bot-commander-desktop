import { getQuickJS } from 'quickjs-emscripten'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBCFDCommand } from '../../../shared/commandCodec'
import {
  createScriptSandboxFactory,
  type ScriptSandboxFactory
} from '../../../shared/playground/script'
import type { PlaygroundRequest, PlaygroundResult } from '../../../shared/playground/types'
import { normalizeWorld } from '../../../shared/playground/world'
import { snapshotInteractions } from '../../../shared/playground/snapshots'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../../shared/playground/script', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadScriptSandboxFactory: load
}))

let factory: ScriptSandboxFactory
beforeAll(async () => {
  factory = createScriptSandboxFactory(await getQuickJS())
})
beforeEach(() => {
  load.mockReset()
  load.mockResolvedValue(factory)
})
afterEach(() => vi.unstubAllGlobals())

async function runWorker(request: PlaygroundRequest): Promise<PlaygroundResult> {
  const scope = {
    onmessage: null as ((event: { data: PlaygroundRequest }) => Promise<void>) | null,
    postMessage: vi.fn()
  }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('./playgroundWorker')
  await scope.onmessage!({ data: request })
  const response = scope.postMessage.mock.calls[0][0]
  expect(response.error).toBeUndefined()
  expect(response.result).not.toHaveProperty('resources')
  return response.result
}

const command = (patch = {}) =>
  decodeBCFDCommand({
    id: 'ping',
    command: '!ping',
    commandDescription: 'Ping',
    type: 0,
    channelMessage: 'Pong!',
    privateMessage: '',
    channelEmbed: {},
    privateEmbed: {},
    ...patch
  }).command

describe('interactive worker feedback without candidate coverage', () => {
  it('does not report unmatched after a successful message command', async () => {
    const state = normalizeWorld()
    const result = await runWorker({
      state,
      commands: [command()],
      senderId: state.members[0].id,
      kind: 'message',
      content: '!ping'
    })
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('Pong!')
    expect(result.feedback).toEqual([])
  })

  it('preserves the reason when a matched command is permission-blocked', async () => {
    const state = normalizeWorld()
    const result = await runWorker({
      state,
      commands: [command({ isAdmin: true })],
      senderId: state.members[1].id,
      kind: 'message',
      content: '!ping'
    })
    expect(result.errors).toEqual([])
    expect(result.trace).toContain('Blocked: administrator required')
    expect(result.feedback).toEqual(['Administrator required'])
  })

  it('still explains a genuinely unmatched trigger', async () => {
    const state = normalizeWorld()
    const result = await runWorker({
      state,
      commands: [command()],
      senderId: state.members[0].id,
      kind: 'message',
      content: 'not a command'
    })
    expect(result.errors).toEqual([])
    expect(result.feedback).toEqual([
      'No saved command matched. Choose a saved command below to try its trigger.'
    ])
  })

  it('does not report unmatched after a successful slash command', async () => {
    const state = normalizeWorld()
    const result = await runWorker({
      state,
      interactions: snapshotInteractions([
        {
          id: 'slash',
          commandName: 'ping',
          commandDescription: 'Ping',
          options: [],
          rootAction: { sendChannelMessage: true, channelMessage: 'Pong!', buttons: [] },
          isRegistered: false
        }
      ]),
      commands: [],
      senderId: state.members[0].id,
      kind: 'slash',
      commandId: 'slash'
    })
    expect(result.errors).toEqual([])
    expect(result.state.messages.at(-1)?.content).toBe('Pong!')
    expect(result.feedback).toEqual([])
  })
})
