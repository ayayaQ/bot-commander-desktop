import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  McpConfigStore,
  MCP_ENV_NAMES,
  prepareMcpLaunch,
  validateMcpServer,
  type McpServerConfig
} from './agentMcpConfig'
import { mcpDigest, mcpDisplayJson } from '@ayayaq/vivi/extensions/mcp'
import { atomicWrite, reopenAtomicWrites } from './atomicPersistence'
import { pauseAgentPersistence, resumeAgentPersistence } from './agentPersistenceLifecycle'
import { mcpContainsSecret } from './agentMcpPrivacy'
import { agentMcpStartDisclosure } from './agentMcpService'
vi.mock('electron', () => ({ app: { getPath: () => '/unreferenced-test-state' } }))
const roots: string[] = []
beforeEach(() => {
  reopenAtomicWrites()
  resumeAgentPersistence()
})
afterEach(async () => {
  resumeAgentPersistence()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-mcp-config-'))
  roots.push(directory)
  const executable = join(directory, process.platform === 'win32' ? 'fixture.exe' : 'fixture')
  await copyFile(process.platform === 'win32' ? process.execPath : '/bin/true', executable)
  await chmod(executable, 0o700)
  const server: McpServerConfig = {
    id: 'fixture',
    label: 'Inert fixture',
    executable,
    args: [],
    cwd: directory,
    protocol: 'legacy',
    environment: []
  }
  return { directory, server, store: new McpConfigStore(join(directory, 'private')) }
}
describe('private bounded persistence and installed launch validation', () => {
  it('creates private client child/atomic primary/backup without requiring mode0700 userData', async () => {
    const subject = await fixture()
    await chmod(subject.directory, 0o755)
    const saved = await subject.store.save([subject.server], (await subject.store.load()).revision),
      path = join(subject.store.directory, 'mcp-servers.json')
    expect(saved.revision).toBe(mcpDigest([subject.server]))
    expect(await subject.store.load()).toEqual(saved)
    expect(Object.isFrozen(saved.servers[0].args)).toBe(true)
    expect(Object.keys(JSON.parse(await readFile(path, 'utf8'))).sort()).toEqual([
      'schemaVersion',
      'servers'
    ])
    await subject.store.save([{ ...subject.server, label: 'Changed' }], saved.revision)
    expect(JSON.parse(await readFile(`${path}.bak`, 'utf8')).servers[0].label).toBe('Inert fixture')
    if (process.platform !== 'win32') {
      expect((await stat(subject.store.directory)).mode & 0o777).toBe(0o700)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(`${path}.bak`)).mode & 0o777).toBe(0o600)
    }
  })
  it('checks revision and refuses corrupted current evidence instead of launching from backup', async () => {
    const subject = await fixture()
    await subject.store.save([subject.server], (await subject.store.load()).revision)
    await expect(subject.store.save([], 'stale')).rejects.toThrow('changed')
    const path = join(subject.store.directory, 'mcp-servers.json')
    await writeFile(path, '{invalid-private-marker')
    await expect(subject.store.load()).rejects.toThrow()
    await expect(subject.store.save([], mcpDigest([subject.server]))).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{invalid-private-marker')
  })
  it('honors app persistence admission pause', async () => {
    const subject = await fixture(),
      current = await subject.store.load()
    pauseAgentPersistence()
    await expect(subject.store.save([subject.server], current.revision)).rejects.toThrow(
      'shutting down'
    )
    resumeAgentPersistence()
    expect(await subject.store.load()).toEqual(current)
  })
  it('retains uncertain committed file but withholds launch until a confirmed save', async () => {
    const subject = await fixture()
    let uncertain = true
    const writer: typeof atomicWrite = vi.fn(async (path, raw, options) => {
      const result = await atomicWrite(path, raw, options)
      return uncertain ? { durability: 'uncertain' as const } : result
    })
    const store = new McpConfigStore(subject.store.directory, [], writer)
    await expect(store.save([subject.server], (await store.load()).revision)).rejects.toThrow(
      'committed'
    )
    expect((await store.load()).servers).toEqual([subject.server])
    expect(() => store.assertLaunchable()).toThrow('unconfirmed')
    uncertain = false
    await store.save([subject.server], (await store.load()).revision)
    expect(() => store.assertLaunchable()).not.toThrow()
  })
  it.skipIf(process.platform === 'win32')(
    'rejects insecure directory, symlink/hardlink primary and unsafe backup',
    async () => {
      const subject = await fixture()
      await mkdir(subject.store.directory, { mode: 0o755 })
      await expect(subject.store.load()).rejects.toThrow('private')
      await chmod(subject.store.directory, 0o700)
      const path = join(subject.store.directory, 'mcp-servers.json'),
        other = join(subject.directory, 'other')
      await writeFile(other, JSON.stringify({ schemaVersion: 1, servers: [subject.server] }), {
        mode: 0o600
      })
      await symlink(other, path)
      await expect(subject.store.load()).rejects.toThrow('regular file')
      await rm(path)
      await link(other, path)
      await expect(subject.store.load()).rejects.toThrow('regular file')
      await rm(path)
      await writeFile(`${path}.bak`, '{}', { mode: 0o644 })
      await expect(
        subject.store.save([subject.server], (await subject.store.load()).revision)
      ).rejects.toThrow('private ordinary')
    }
  )
  it('bounds imported size and rejects duplicates/unknown fields/enabled state', async () => {
    const subject = await fixture()
    await mkdir(subject.store.directory, { mode: 0o700 })
    const path = join(subject.store.directory, 'mcp-servers.json')
    for (const body of [
      { schemaVersion: 1, servers: [{ ...subject.server, enabled: true }] },
      { schemaVersion: 1, servers: [subject.server, subject.server] },
      { schemaVersion: 2, servers: [] },
      { schemaVersion: 1, servers: [], token: 'unexpected' }
    ]) {
      await writeFile(path, JSON.stringify(body), { mode: 0o600 })
      await expect(subject.store.load()).rejects.toThrow()
    }
    await writeFile(path, ' '.repeat(65537))
    await expect(subject.store.load()).rejects.toThrow('bounded')
  })
  it('rejects unsafe/remote/shell/inline/credential launch configurations without reading getters', async () => {
    const { server } = await fixture()
    for (const change of [
      { executable: 'node' },
      { executable: '/installed/npx' },
      { executable: '/installed/bash' },
      { executable: '/installed/pwsh.exe' },
      { transport: 'http' },
      { enabled: true },
      { environment: ['PATH'] },
      { environment: ['OPENAI_API_KEY'] },
      { args: ['--token', 'secret'] },
      { args: ['sk-proj-' + 'x'.repeat(30)] },
      { executable: '/installed/node', args: ['--eval', 'source'] },
      { executable: '/installed/python3', args: ['-Icprint(1)'] },
      { executable: '/installed/bun', args: ['some-package'] },
      { label: '\x1b[2J' },
      { protocol: 'auto' },
      { args: ['known-fixture-credential'] }
    ])
      expect(() =>
        validateMcpServer({ ...server, ...change }, ['known-fixture-credential'])
      ).toThrow()
    const getter = vi.fn(() => [])
    const invalid = Object.defineProperty({ ...server }, 'args', { enumerable: true, get: getter })
    expect(() => validateMcpServer(invalid)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it('rejects Node package scripts and direct known manager executables/modules while allowing installed servers', async () => {
    const { server } = await fixture()
    for (const args of [['--run', 'install'], ['--run=install']])
      expect(() => validateMcpServer({ ...server, executable: '/installed/node', args })).toThrow()
    for (const name of ['uv', 'uvx', 'pip', 'pip3', 'pip3.14', 'pipx', 'poetry', 'pdm', 'hatch']) {
      expect(() =>
        validateMcpServer({
          ...server,
          executable: `/installed/${name}`,
          args: ['install', 'an-uninstalled-package']
        })
      ).toThrow()
      expect(() =>
        validateMcpServer({
          ...server,
          executable: `/installed/${name}.exe`,
          args: ['run', 'an-uninstalled-package']
        })
      ).toThrow()
    }
    for (const module of [
      'pip',
      'pipx',
      'pip._internal',
      'ensurepip',
      'uv',
      'poetry',
      'pdm',
      'hatch'
    ]) {
      for (const args of [
        ['-m', module, 'install'],
        [`-m${module}`, 'install'],
        ['-Im', module, 'install'],
        [`-Im${module}`, 'install']
      ])
        expect(() =>
          validateMcpServer({ ...server, executable: '/installed/python3.14', args })
        ).toThrow()
    }
    for (const args of [
      ['-m', 'mcp_server'],
      ['-Im', 'mcp_server'],
      ['-mmcp_server'],
      ['-X', 'utf8', '-m', 'mcp_server'],
      ['/installed/server.py', '-m', 'pip']
    ])
      expect(() =>
        validateMcpServer({ ...server, executable: '/installed/python3.14', args })
      ).not.toThrow()
  })
  it('inherits only explicitly chosen bounded safe values and fingerprints executable plus cwd identity', async () => {
    const { server, directory } = await fixture(),
      name = MCP_ENV_NAMES[0],
      selected = { ...server, environment: [name] }
    const launch = await prepareMcpLaunch(selected, 'revision', {
      [name]: directory,
      PATH: 'unapproved',
      NODE_OPTIONS: 'unapproved',
      API_KEY: 'fixture-private-key'
    })
    expect(launch.environment).toEqual({ [name]: directory })
    expect(launch.executableRevision).toHaveLength(64)
    expect(launch.workingDirectoryRevision).toHaveLength(64)
    expect(Object.isFrozen(launch.environment)).toBe(true)
    for (const value of [
      'fixture-private-key',
      'Bearer ' + 'x'.repeat(20),
      '() { shell; }',
      'a'.repeat(4097)
    ])
      await expect(
        prepareMcpLaunch(selected, 'revision', { [name]: value, API_KEY: 'fixture-private-key' })
      ).rejects.toThrow('unsafe')
    await writeFile(server.executable, 'changed installed bytes')
    expect((await prepareMcpLaunch(selected, 'revision', { [name]: directory })).digest).not.toBe(
      launch.digest
    )
  })
  it('renders hidden codepoints as exact escaped JSON and bounds disclosure expansion', async () => {
    const { server } = await fixture(),
      value = 'visible\u202ehidden\u200b\ufe0f\u{e0100}\u2028end',
      rendered = mcpDisplayJson(value)
    expect(JSON.parse(rendered)).toBe(value)
    const launch = await prepareMcpLaunch(
        { ...server, label: value, args: [value] },
        'revision',
        {}
      ),
      disclosure = agentMcpStartDisclosure(launch)
    expect(disclosure).toContain(rendered)
    expect(disclosure).not.toContain(value)
    expect(disclosure).toContain('not a sandbox')
    expect(() =>
      agentMcpStartDisclosure({
        ...launch,
        server: { ...launch.server, args: Array(3).fill('\u200b'.repeat(3000)) }
      })
    ).toThrow('exceeds')
  })
  it('scans malformed-percent neighbors, final32nd decode, and numeric arrays without stack overflow', () => {
    const secrets = ['fixture-known-secret']
    for (const item of [
      'fixture%2Dknown%2Dsecret invalid-%',
      'fixture%2Dknown%2Dsecret%FF',
      'fixture\\u0025%32%44known%2Dsecret',
      { 'fixture%2Dknown%2Dsecret': 'ordinary' }
    ])
      expect(mcpContainsSecret(item, secrets)).toBe(true)
    expect(mcpContainsSecret('ordinary invalid-% and %FF', secrets)).toBe(false)
    let encoded = '%66ixture-known-secret'
    for (let i = 1; i < 32; i++) encoded = encoded.replace(/%/g, '%25')
    expect(mcpContainsSecret(encoded, secrets)).toBe(true)
    const array: Array<number | string> = Array(200000).fill(0)
    expect(mcpContainsSecret(array, secrets)).toBe(false)
    array.push('fixture%2Dknown%2Dsecret')
    expect(mcpContainsSecret(array, secrets)).toBe(true)
  })
})
