import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeBCFDCommand } from '../../../shared/commandCodec'
import { createPlaygroundState } from '../../../shared/playground/types'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('../../../shared/playground/script', () => ({ loadScriptSandboxFactory: load }))
beforeEach(() => {
  load.mockReset()
  load.mockResolvedValue(() => {
    throw new Error('Script sandbox was unexpectedly needed for pure fixture tests')
  })
})

async function workerHarness() {
  const scope = {
    onmessage: null as ((event: { data: unknown }) => Promise<void>) | null,
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
    await scope.onmessage!({
      data: { state, commands: [], senderId: state.members[0].id, content: 'hello' }
    })
    expect(scope.postMessage.mock.calls[0][0].result.state.messages[0].content).toBe('hello')
    await scope.onmessage!({
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
    await scope.onmessage!({
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
    await scope.onmessage!({
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

  it('ignores queued requests while the current offline WASM initialization is pending', async () => {
    let ready!: (factory: unknown) => void
    load.mockReturnValue(
      new Promise((resolve) => {
        ready = resolve
      })
    )
    const scope = await workerHarness(),
      state = createPlaygroundState()
    const first = scope.onmessage!({
      data: { state, commands: [], senderId: state.members[0].id, content: 'first' }
    })
    await scope.onmessage!({
      data: { state, commands: [], senderId: state.members[0].id, content: 'queued' }
    })
    expect(scope.postMessage).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledTimes(1)
    ready(() => {
      throw new Error('No VM needed')
    })
    await first
    expect(scope.postMessage).toHaveBeenCalledTimes(1)
    expect(scope.postMessage.mock.calls[0][0].result.state.messages[0].content).toBe('first')
  })
})
