import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { get } from 'svelte/store'
import { readFileSync } from 'node:fs'
import { compile } from 'svelte/compiler'
import type {
  AgentMcpLaunchPreparation,
  AgentMcpHttpServerConfig,
  AgentMcpStdioServerConfig,
  AgentMcpStatus
} from '../../../shared/agentMcpTypes'
import { createAgentMcpControls, parseAgentMcpDraft, type AgentMcpConfigDraft } from './agentMcp'

const config: AgentMcpStdioServerConfig = {
  id: 'fixture',
  label: 'Installed fixture',
  executable: '/installed/server',
  args: ['--stdio'],
  cwd: '/installed',
  protocol: 'legacy',
  environment: ['HOME']
}
const status = (patch: Partial<AgentMcpStatus> = {}): AgentMcpStatus => ({
  revision: 'revision-fixture',
  servers: [{ server: config, state: 'disabled', cleanupPending: false }],
  environmentNames: ['HOME', 'TMPDIR'],
  paused: false,
  ...patch
})
const launch = (patch: Partial<AgentMcpLaunchPreparation> = {}): AgentMcpLaunchPreparation => ({
  token: 'one-shot-fixture',
  serverId: config.id,
  disclosure: 'Exact fixture <untrusted> ["--stdio"]',
  launchDigest: 'digest-fixture',
  expiresAt: 61000,
  ...patch
})
type StdioDraft = AgentMcpConfigDraft & { transport?: 'stdio' }
const draft = (patch: Partial<StdioDraft> = {}): StdioDraft => ({
  ...config,
  argsJson: JSON.stringify(config.args),
  ...patch
})
const httpConfig: AgentMcpHttpServerConfig = {
  transport: 'http',
  id: 'remote',
  label: 'Anonymous HTTP fixture',
  endpoint: 'https://example.invalid/mcp',
  protocol: 'legacy',
  allowLoopbackHttp: false
}
const httpDraft = (
  patch: Partial<AgentMcpConfigDraft> = {}
): AgentMcpConfigDraft & { transport: 'http' } => ({ ...httpConfig, ...patch, transport: 'http' })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
const cleanups: (() => void)[] = []
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
  vi.useRealTimers()
})
async function fixture(initial = status()) {
  const listeners = new Set<(next: AgentMcpStatus) => void>()
  const invoke = vi.fn(async (channel: string, ..._args: unknown[]): Promise<unknown> => {
    if (channel === 'agent-mcp:prepare-launch') return launch()
    if (channel === 'agent-mcp:start') return { started: true, status: initial }
    if (channel === 'agent-mcp:cancel-launch') return undefined
    return initial
  })
  const ipc = {
    invoke,
    on: vi.fn((_channel: string, listener: (next: AgentMcpStatus) => void) =>
      listeners.add(listener)
    ),
    removeListener: vi.fn((_channel: string, listener: (next: AgentMcpStatus) => void) =>
      listeners.delete(listener)
    )
  }
  let time = 1000
  const controls = createAgentMcpControls(ipc, () => time)
  controls.mount()
  cleanups.push(controls.unmount)
  await settle()
  return {
    controls,
    invoke,
    ipc,
    listeners,
    state: () => get(controls),
    event: (next: AgentMcpStatus) => listeners.forEach((listener) => listener(next)),
    clock: (next: number) => {
      time = next
    }
  }
}
const channels = (invoke: ReturnType<typeof vi.fn>) => invoke.mock.calls.map(([channel]) => channel)

describe('agent MCP inert controls and local status', () => {
  it('mounts one distinct listener and local list only; repeated mount cannot initialize twice', async () => {
    const f = await fixture()
    f.controls.mount()
    expect(f.ipc.on).toHaveBeenCalledTimes(1)
    expect(channels(f.invoke)).toEqual(['agent-mcp:list'])
    expect(f.state().preparation).toBeNull()
  })
  it('saving and reloading configuration never starts or prepares a process', async () => {
    const f = await fixture()
    await f.controls.configure(config)
    await f.controls.reload()
    expect(f.invoke).toHaveBeenCalledWith('agent-mcp:configure', config)
    expect(channels(f.invoke)).toEqual(['agent-mcp:list', 'agent-mcp:configure', 'agent-mcp:list'])
  })
  it('serializes repeated configuration/removal clicks', async () => {
    const f = await fixture()
    const pending = deferred<AgentMcpStatus>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.configure(config)
    expect(await f.controls.configure(config)).toBe(false)
    expect(await f.controls.remove(config.id)).toBe(false)
    pending.resolve(status())
    expect(await first).toBe(true)
    expect(channels(f.invoke).filter((name) => name === 'agent-mcp:configure')).toHaveLength(1)
  })
  it('a newer pushed full status wins over a delayed local list response', async () => {
    const f = await fixture()
    const pending = deferred<AgentMcpStatus>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const request = f.controls.reload()
    f.event(status({ revision: 'newer-event', servers: [] }))
    pending.resolve(status({ revision: 'older-response' }))
    await request
    expect(f.state().status?.revision).toBe('newer-event')
    expect(f.state().status?.servers).toEqual([])
  })
  it('keeps inspector data local and explicitly refreshes only selected categories', async () => {
    const category = {
      state: 'stale' as const,
      count: 1,
      available: 0,
      entries: [
        {
          remoteKey: 'quarantined-fixture',
          alias: 'fixture_alias',
          state: 'quarantined' as const,
          reason: 'Invalid schema',
          descriptorJson: '{"description":"<script>fixture</script>"}'
        }
      ]
    }
    const f = await fixture(
      status({
        servers: [
          {
            server: config,
            state: 'connected',
            cleanupPending: false,
            catalog: {
              generation: 2,
              tools: category,
              resources: { ...category, state: 'unsupported' },
              resourceTemplates: { ...category, state: 'error' }
            }
          }
        ]
      })
    )
    expect(f.state().status?.servers[0].catalog?.tools.entries[0].state).toBe('quarantined')
    expect(channels(f.invoke)).toEqual(['agent-mcp:list'])
    expect(await f.controls.refresh(config.id, [])).toBe(false)
    await f.controls.refresh(config.id, ['resources', 'resourceTemplates', 'resources'])
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:refresh', config.id, [
      'resources',
      'resourceTemplates'
    ])
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
  })
  it('pauses mutating controls but allows read-only status reload', async () => {
    const f = await fixture(status({ paused: true }))
    await f.controls.configure(config)
    await f.controls.prepare(config.id)
    await f.controls.disconnect(config.id)
    await f.controls.reload()
    expect(channels(f.invoke)).toEqual(['agent-mcp:list', 'agent-mcp:list'])
  })
  it('shows a local-list error and retries only on explicit reload', async () => {
    const f = await fixture()
    f.invoke.mockRejectedValueOnce(new Error('Status unavailable'))
    await f.controls.reload()
    expect(f.state().error).toBe('Status unavailable')
    await vi.advanceTimersByTimeAsync(120000)
    expect(channels(f.invoke)).toEqual(['agent-mcp:list', 'agent-mcp:list'])
    await f.controls.reload()
    expect(f.state().error).toBe('')
  })
})

describe('agent MCP one-shot exact launch and staleness', () => {
  it('prepares exact disclosure without start and then sends only the exact token once', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    expect(f.state().preparation).toEqual(launch())
    expect(channels(f.invoke)).toEqual(['agent-mcp:list', 'agent-mcp:prepare-launch'])
    await f.controls.start()
    await f.controls.start()
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:start', 'one-shot-fixture')
    expect(channels(f.invoke).filter((name) => name === 'agent-mcp:start')).toHaveLength(1)
  })
  it('guards duplicate prepare and other actions while the exact review is open', async () => {
    const f = await fixture()
    const pending = deferred<AgentMcpLaunchPreparation>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.prepare(config.id)
    await f.controls.prepare(config.id)
    pending.resolve(launch())
    await first
    await f.controls.prepare(config.id)
    expect(await f.controls.configure(config)).toBe(false)
    expect(await f.controls.remove(config.id)).toBe(false)
    expect(channels(f.invoke)).toEqual(['agent-mcp:list', 'agent-mcp:prepare-launch'])
  })
  it('cancel of a review consumes the exact token; repeated cancel sends nothing', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.controls.cancel()
    f.controls.cancel()
    await f.controls.start()
    expect(f.state().preparation).toBeNull()
    expect(channels(f.invoke)).toEqual([
      'agent-mcp:list',
      'agent-mcp:prepare-launch',
      'agent-mcp:cancel-launch'
    ])
  })
  it('cancel during preparation revokes the delayed token and never reopens review', async () => {
    const f = await fixture()
    const pending = deferred<AgentMcpLaunchPreparation>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.prepare(config.id)
    f.controls.cancel()
    pending.resolve(launch())
    await first
    expect(f.state().preparation).toBeNull()
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', 'one-shot-fixture')
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
  })
  it('an unsaved form change invalidates the review', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.controls.configurationChanged()
    await f.controls.start()
    expect(f.state().preparation).toBeNull()
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
  })
  it.each(['config', 'removal', 'pause', 'cleanup'])(
    'invalidates review on pushed %s change',
    async (kind) => {
      const f = await fixture()
      await f.controls.prepare(config.id)
      const next = status()
      const patch: Partial<AgentMcpStatus> =
        kind === 'config'
          ? { revision: 'new-revision' }
          : kind === 'removal'
            ? { servers: [] }
            : kind === 'pause'
              ? { paused: true }
              : { servers: [{ ...next.servers[0], cleanupPending: true }] }
      f.event(status(patch))
      await f.controls.start()
      expect(f.state().preparation).toBeNull()
      expect(channels(f.invoke)).not.toContain('agent-mcp:start')
    }
  )
  it('config change during pending preparation cancels its late token', async () => {
    const f = await fixture()
    const pending = deferred<AgentMcpLaunchPreparation>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.prepare(config.id)
    f.event(status({ servers: [] }))
    pending.resolve(launch())
    await first
    expect(f.state().preparation).toBeNull()
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', 'one-shot-fixture')
  })
  it.each([launch({ serverId: 'other' }), launch({ expiresAt: 1000 })])(
    'rejects expired or wrong-server response',
    async (result) => {
      const f = await fixture()
      f.invoke.mockResolvedValueOnce(result)
      await f.controls.prepare(config.id)
      expect(f.state().preparation).toBeNull()
      expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', result.token)
    }
  )
  it('expires a review and refuses a late click', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.clock(61000)
    await vi.advanceTimersByTimeAsync(60000)
    await f.controls.start()
    expect(f.state().preparation).toBeNull()
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
  })
  it('double confirmation cannot duplicate asynchronous start', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    const pending = deferred<{ started: boolean; status: AgentMcpStatus }>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.start()
    expect(await f.controls.start()).toBe(false)
    pending.resolve({ started: true, status: status() })
    await first
    expect(channels(f.invoke).filter((name) => name === 'agent-mcp:start')).toHaveLength(1)
  })
  it('its own connecting status does not cancel startup, but changed config does', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    const pending = deferred<{ started: boolean; status: AgentMcpStatus }>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.start()
    f.event(status({ servers: [{ server: config, state: 'connecting', cleanupPending: false }] }))
    expect(channels(f.invoke)).not.toContain('agent-mcp:cancel-launch')
    f.event(
      status({
        servers: [
          { server: { ...config, cwd: '/changed' }, state: 'disabled', cleanupPending: false }
        ]
      })
    )
    pending.resolve({ started: true, status: status() })
    await first
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', 'one-shot-fixture')
    const changed = f.state().status?.servers[0].server
    expect(changed?.transport !== 'http' && changed?.cwd).toBe('/changed')
    expect(f.state().notice).not.toBe('Server started.')
  })
  it('startup failure does not retry or reconstruct an approval', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.invoke.mockRejectedValueOnce(new Error('Fixture startup failed'))
    await f.controls.start()
    await f.controls.start()
    await vi.advanceTimersByTimeAsync(120000)
    expect(f.state().error).toBe('Fixture startup failed')
    expect(channels(f.invoke).filter((name) => name === 'agent-mcp:start')).toHaveLength(1)
  })
  it('surfaces cancellation failure without claiming cancellation succeeded', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.invoke.mockRejectedValueOnce(new Error('Cleanup unverified'))
    f.controls.cancel()
    await settle()
    expect(f.state().error).toBe('Cleanup unverified')
    expect(f.state().notice).toBe('Start cancellation requested.')
  })
  it('blocks connected, connecting, cleanup-pending and unknown launches', async () => {
    const f = await fixture()
    for (const entry of [
      { state: 'connected' as const, cleanupPending: false },
      { state: 'connecting' as const, cleanupPending: false },
      { state: 'error' as const, cleanupPending: true }
    ]) {
      f.event(status({ servers: [{ server: config, ...entry }] }))
      await f.controls.prepare(config.id)
    }
    await f.controls.prepare('unknown')
    expect(channels(f.invoke)).toEqual(['agent-mcp:list'])
  })
})

describe('agent MCP unmount and remount interruption', () => {
  it('unmount cancels review, removes listener and never expires into a replay', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.controls.unmount()
    expect(f.listeners.size).toBe(0)
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', 'one-shot-fixture')
    await f.controls.start()
    await vi.advanceTimersByTimeAsync(120000)
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
    expect(channels(f.invoke).filter((name) => name === 'agent-mcp:cancel-launch')).toHaveLength(1)
  })
  it('unmount during preparation revokes its late token', async () => {
    const f = await fixture()
    const pending = deferred<AgentMcpLaunchPreparation>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.prepare(config.id)
    f.controls.unmount()
    pending.resolve(launch())
    await first
    expect(f.state().preparation).toBeNull()
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', 'one-shot-fixture')
  })
  it('unmount during start retains exact token for cancellation and ignores late success', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    const pending = deferred<{ started: boolean; status: AgentMcpStatus }>()
    f.invoke.mockImplementationOnce(() => pending.promise)
    const first = f.controls.start()
    f.controls.unmount()
    expect(f.invoke).toHaveBeenLastCalledWith('agent-mcp:cancel-launch', 'one-shot-fixture')
    pending.resolve({ started: true, status: status({ revision: 'late-result' }) })
    await first
    expect(f.state().status?.revision).toBe('revision-fixture')
    expect(f.state().notice).not.toBe('Server started.')
  })
  it('Back/Forward remount has one fresh listener and local status without replaying Start', async () => {
    const f = await fixture()
    await f.controls.prepare(config.id)
    f.controls.unmount()
    const next = createAgentMcpControls(f.ipc, () => 1000)
    next.mount()
    cleanups.push(next.unmount)
    await settle()
    expect(f.listeners.size).toBe(1)
    expect(get(next).preparation).toBeNull()
    expect(channels(f.invoke)).toEqual([
      'agent-mcp:list',
      'agent-mcp:prepare-launch',
      'agent-mcp:cancel-launch',
      'agent-mcp:list'
    ])
  })
})

describe('agent MCP bounded form and escaped render', () => {
  it('preserves transport-less stdio configs and accepts an explicit stdio discriminator', () => {
    expect(parseAgentMcpDraft(draft(), ['HOME'])).toEqual(config)
    expect(parseAgentMcpDraft(draft({ transport: 'stdio' }), ['HOME'])).toEqual({
      ...config,
      transport: 'stdio'
    })
  })
  it('parses a minimal anonymous HTTP draft without carrying hidden stdio or auth fields', () => {
    expect(parseAgentMcpDraft(httpDraft(), [])).toEqual(httpConfig)
    expect(
      parseAgentMcpDraft(
        httpDraft({ executable: '/old/server', argsJson: '[broken', environment: ['TOKEN'] }),
        []
      )
    ).toEqual(httpConfig)
    expect(parseAgentMcpDraft(httpDraft({ protocol: '2026-07-28' }), []).protocol).toBe(
      '2026-07-28'
    )
  })
  it.each(['http://127.0.0.1:8123/mcp', 'http://[::1]:8123/mcp'])(
    'requires explicit local HTTP opt-in for %s',
    (endpoint) => {
      expect(() => parseAgentMcpDraft(httpDraft({ endpoint }), [])).toThrow('explicitly allow')
      expect(
        parseAgentMcpDraft(httpDraft({ endpoint, allowLoopbackHttp: true }), []).endpoint
      ).toBe(endpoint)
    }
  )
  it.each([
    'http://example.invalid/mcp',
    'http://localhost/mcp',
    'http://127.1/mcp',
    'http://2130706433/mcp',
    'http://0x7f000001/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'https://user:secret@example.invalid/mcp',
    'https://example.invalid/mcp?token=secret',
    'https://example.invalid/mcp?',
    'https://example.invalid/mcp#fragment',
    'https://example.invalid/mcp#',
    'https://example.invalid/white space',
    'https://example.invalid/\npath',
    'file:///mcp',
    '/relative/mcp',
    ''
  ])('rejects unsafe or malformed HTTP draft endpoint %s', (endpoint) => {
    expect(() => parseAgentMcpDraft(httpDraft({ endpoint, allowLoopbackHttp: true }), [])).toThrow()
  })
  it('bounds endpoint length and shares ID, label and protocol checks across transports', () => {
    expect(() =>
      parseAgentMcpDraft(httpDraft({ endpoint: 'https://example.invalid/' + 'a'.repeat(4096) }), [])
    ).toThrow('bounded')
    expect(() => parseAgentMcpDraft(httpDraft({ id: 'UPPERCASE' }), [])).toThrow('lowercase')
    expect(() => parseAgentMcpDraft(httpDraft({ label: 'bad\nlabel' }), [])).toThrow('label')
    expect(() =>
      parseAgentMcpDraft(httpDraft({ protocol: 'unsupported' as 'legacy' }), [])
    ).toThrow('protocol')
  })
  it('preserves exact argument text without interpreting it and accepts only offered names', () => {
    const result = parseAgentMcpDraft(
      draft({
        argsJson: '["--stdio", "<b>fixture</b>", "$(fixture)"]',
        environment: ['HOME', 'HOME']
      }),
      ['HOME']
    )
    expect(result.args).toEqual(['--stdio', '<b>fixture</b>', '$(fixture)'])
    expect(result.environment).toEqual(['HOME'])
    expect(() => parseAgentMcpDraft(draft({ environment: ['TOKEN=value'] }), ['HOME'])).toThrow(
      'safe environment'
    )
    expect(() => parseAgentMcpDraft(draft({ executable: 'npx' }), ['HOME'])).toThrow(
      'absolute paths'
    )
    expect(() => parseAgentMcpDraft(draft({ cwd: './folder' }), ['HOME'])).toThrow('absolute paths')
    expect(() => parseAgentMcpDraft(draft({ id: 'UPPERCASE' }), ['HOME'])).toThrow('lowercase')
  })
  it.each(['[1]', '{}', 'null', '"--stdio"', '["\\u0000"]', '["\\n"]', '[broken'])(
    'rejects malformed or control-bearing arguments %s',
    (argsJson) => {
      expect(() => parseAgentMcpDraft(draft({ argsJson }), ['HOME'])).toThrow()
    }
  )
  it('bounds argument count and UTF-8 configuration bytes', () => {
    expect(() =>
      parseAgentMcpDraft(draft({ argsJson: JSON.stringify(Array(17).fill('x')) }), ['HOME'])
    ).toThrow('up to 16')
    expect(() =>
      parseAgentMcpDraft(draft({ argsJson: JSON.stringify(Array(4).fill('あ'.repeat(2000))) }), [
        'HOME'
      ])
    ).toThrow('16 KiB')
  })
  it('compiles remote disclosure, metadata, aliases and messages to escaped plain text', () => {
    const source = readFileSync(
      new URL('../components/AgentMcpSettingsCard.svelte', import.meta.url),
      'utf8'
    )
    const compiled = compile(source, { generate: 'server' }).js.code
    expect(source).not.toContain('{@html')
    expect(source).not.toContain('marked')
    expect(compiled).toContain('.preparation.disclosure)')
    for (const value of ['item.descriptorJson', 'item.remoteKey', 'item.alias', 'entry.message'])
      expect(compiled).toContain(`$.escape(${value})`)
    expect(source).toContain('Available scalar templates')
    expect(source).toContain('expanded URI before approving once')
    expect(source).toContain('including Auto')
  })
})

describe('agent MCP anonymous HTTP controls', () => {
  const httpStatus = (server = httpConfig) =>
    status({ servers: [{ server, state: 'disabled', cleanupPending: false }] })

  it('saves and reloads anonymous HTTP configuration without network startup or auth IPC', async () => {
    const f = await fixture(httpStatus())
    await f.controls.configure(httpConfig)
    await f.controls.reload()
    expect(f.invoke).toHaveBeenCalledWith('agent-mcp:configure', httpConfig)
    expect(channels(f.invoke)).toEqual(['agent-mcp:list', 'agent-mcp:configure', 'agent-mcp:list'])
  })
  it('cancels HTTP review and requires a fresh disclosure after endpoint or opt-in changes', async () => {
    const f = await fixture(httpStatus())
    f.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'agent-mcp:prepare-launch') return launch({ serverId: httpConfig.id })
      return httpStatus()
    })
    await f.controls.prepare(httpConfig.id)
    f.controls.cancel()
    await f.controls.start()
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
    for (const patch of [
      { endpoint: 'https://example.invalid/changed' },
      { allowLoopbackHttp: true }
    ]) {
      f.event(httpStatus())
      await f.controls.prepare(httpConfig.id)
      expect(f.state().preparation?.serverId).toBe(httpConfig.id)
      f.event(httpStatus({ ...httpConfig, ...patch }))
      await f.controls.start()
      expect(f.state().preparation).toBeNull()
    }
    expect(channels(f.invoke)).not.toContain('agent-mcp:start')
    expect(
      channels(f.invoke).filter((channel) => channel === 'agent-mcp:cancel-launch')
    ).toHaveLength(3)
  })
})
