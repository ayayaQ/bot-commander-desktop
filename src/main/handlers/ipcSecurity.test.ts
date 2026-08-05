import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  on: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
    on: mocks.on
  }
}))

function eventFor(url: string, options: { trustedWindow?: boolean; mainFrame?: boolean } = {}) {
  const frame = { url }
  const mainFrame = options.mainFrame === false ? { url } : frame
  return {
    sender: options.trustedWindow === false ? { mainFrame } : trustedContents,
    senderFrame: frame
  }
}

const trustedContents = { mainFrame: null } as unknown as Electron.WebContents

describe('ipcSecurity', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('accepts only the configured renderer main frame and URL', async () => {
    const { configureTrustedRenderer, isTrustedIpcSender } = await import('./ipcSecurity')
    const frame = { url: 'file:///app/renderer/index.html' }
    Object.assign(trustedContents, { mainFrame: frame })
    configureTrustedRenderer(trustedContents, frame.url)

    expect(isTrustedIpcSender({ sender: trustedContents, senderFrame: frame } as any)).toBe(true)
    expect(isTrustedIpcSender(eventFor('https://attacker.example') as any)).toBe(false)
    expect(isTrustedIpcSender(eventFor(frame.url, { trustedWindow: false }) as any)).toBe(false)
    expect(isTrustedIpcSender(eventFor(frame.url, { mainFrame: false }) as any)).toBe(false)
  })

  it('blocks untrusted invoke senders before calling the handler', async () => {
    const { configureTrustedRenderer, trustedIpcMain } = await import('./ipcSecurity')
    const frame = { url: 'file:///app/renderer/index.html' }
    Object.assign(trustedContents, { mainFrame: frame })
    configureTrustedRenderer(trustedContents, frame.url)
    const listener = vi.fn()
    trustedIpcMain.handle('sensitive-operation', listener)
    const registered = mocks.handle.mock.calls[0][1]

    expect(() => registered(eventFor('https://attacker.example'))).toThrow('untrusted renderer')
    expect(listener).not.toHaveBeenCalled()

    registered({ sender: trustedContents, senderFrame: frame })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
