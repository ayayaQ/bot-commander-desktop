import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeBCFDCommand } from '../../../shared/commandCodec'
import { createPlaygroundState } from '../../../shared/playground/types'

async function workerHarness() {
  const scope = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage: vi.fn()
  }
  vi.stubGlobal('self', scope)
  vi.resetModules()
  await import('./playgroundWorker')
  return scope
}

afterEach(() => vi.unstubAllGlobals())

describe('headless worker entry-point boundary', () => {
  it('dispatches both message and interaction-only requests without service access', async () => {
    const scope = await workerHarness(),
      state = createPlaygroundState()
    scope.onmessage!({
      data: { state, commands: [], senderId: state.members[0].id, content: 'hello' }
    })
    expect(scope.postMessage.mock.calls[0][0].result.state.messages[0].content).toBe('hello')
    scope.onmessage!({
      data: {
        kind: 'slash',
        state,
        interactions: [],
        senderId: state.members[0].id,
        commandId: 'missing'
      }
    })
    expect(scope.postMessage.mock.calls[1][0].result.errors[0]).toContain('not found')
  })

  it('rejects serialized oversized input before evaluating any template', async () => {
    const scope = await workerHarness(),
      state = createPlaygroundState()
    scope.onmessage!({
      data: { state, commands: [], senderId: state.members[0].id, content: 'x'.repeat(2_000_001) }
    })
    expect(scope.postMessage.mock.calls[0][0].error).toContain('request is too large')
  })

  it('bounds aggregate transcript growth before transferring a result to the renderer', async () => {
    const scope = await workerHarness(),
      state = createPlaygroundState()
    const command = decodeBCFDCommand({
      id: 'large',
      command: '*',
      commandDescription: 'Large',
      type: 0,
      channelMessage: `$replace(aaaa,a,${'b'.repeat(8000)})`,
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {}
    }).command
    scope.onmessage!({
      data: {
        state,
        commands: Array.from({ length: 100 }, () => command),
        senderId: state.members[0].id,
        content: 'hello'
      }
    })
    const response = scope.postMessage.mock.calls[0][0]
    expect(
      response.result.errors.some((error: string) => error.includes('Transcript size limit'))
    ).toBe(true)
    expect(JSON.stringify(response).length).toBeLessThanOrEqual(2_000_000)
  })
})
