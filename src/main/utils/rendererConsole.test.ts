import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mocks.send } }]
  }
}))

describe('rendererConsole', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('records entries while forwarding them to the renderer', async () => {
    const { getRendererConsoleEntries, rendererConsole } = await import('./rendererConsole')

    rendererConsole.info('Connected')
    rendererConsole.error('Command failed')

    expect(mocks.send).toHaveBeenCalledWith('console:info', 'Connected')
    expect(getRendererConsoleEntries({ types: ['error'] })).toMatchObject([
      { id: 1, type: 'error', message: 'Command failed' }
    ])
    expect(getRendererConsoleEntries({ limit: 1 })).toMatchObject([
      { type: 'error', message: 'Command failed' }
    ])
  })
})
