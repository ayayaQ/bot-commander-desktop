// SPDX-License-Identifier: Apache-2.0
// OS/configuration policy adapted from licensed vivi-cli src/mcp-config.ts. Pure data helpers use Vivi.
import { constants } from 'node:fs'
import { access, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { assertMcpJson, mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import type { AgentMcpServerConfig } from '../../shared/agentMcpTypes'
import { atomicWrite } from './atomicPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import { environmentSecrets } from './agentMcpPrivacy'

export const MCP_ENV_NAMES =
  process.platform === 'win32'
    ? (['SYSTEMROOT', 'USERPROFILE', 'TEMP', 'TMP'] as const)
    : (['HOME', 'TMPDIR'] as const)
export type McpServerConfig = AgentMcpServerConfig
export interface McpConfiguration {
  readonly revision: string
  readonly servers: readonly McpServerConfig[]
}
const MAX_CONFIG_BYTES = 64 * 1024
const controls = /[\u0000-\u001f\u007f-\u009f]/
export function mcpText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= limit && !controls.test(value)
  )
}
export function mcpFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) mcpFreeze(child)
    Object.freeze(value)
  }
  return value
}
export function mcpRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (item) => item.enumerable && 'value' in item
    )
  )
}
function fail(): never {
  throw new Error('Invalid agent MCP configuration; choose a trusted installed server')
}
export function validateMcpServer(
  value: unknown,
  secrets: readonly string[] = []
): McpServerConfig {
  assertMcpJson(value, 16 * 1024)
  if (
    !mcpRecord(value) ||
    Object.keys(value).length !== 7 ||
    !Object.keys(value).every((key) =>
      ['id', 'label', 'executable', 'args', 'cwd', 'protocol', 'environment'].includes(key)
    ) ||
    typeof value.id !== 'string' ||
    !/^[a-z][a-z0-9_-]{0,15}$/.test(value.id) ||
    !mcpText(value.label, 80) ||
    !mcpText(value.executable, 4096) ||
    !isAbsolute(value.executable) ||
    !mcpText(value.cwd, 4096) ||
    !isAbsolute(value.cwd) ||
    (process.platform === 'win32' &&
      (!/^[a-z]:[\\/]/i.test(value.executable) || !/^[a-z]:[\\/]/i.test(value.cwd))) ||
    !Array.isArray(value.args) ||
    value.args.length > 16 ||
    !value.args.every(
      (arg) => typeof arg === 'string' && arg.length <= 4096 && !controls.test(arg)
    ) ||
    !Array.isArray(value.environment) ||
    value.environment.length > MCP_ENV_NAMES.length ||
    !value.environment.every((name) => (MCP_ENV_NAMES as readonly unknown[]).includes(name)) ||
    new Set(value.environment).size !== value.environment.length ||
    typeof value.protocol !== 'string' ||
    !['legacy', '2026-07-28'].includes(value.protocol)
  )
    fail()
  // No shell startup strings or package runners. Installed interpreters may run an explicitly trusted installed script.
  if (
    /^(?:npx|npm|pnpm|yarn|bunx|uv|uvx|pip(?:\d+(?:\.\d+)*)?|pipx|poetry|pdm|hatch|sh|ash|bash|dash|ksh|csh|tcsh|zsh|fish|cmd|powershell|pwsh)(?:\.exe|\.cmd|\.bat)?$/i.test(
      basename(value.executable)
    ) ||
    /\.(?:cmd|bat|ps1)$/i.test(value.executable)
  )
    fail()
  const server: McpServerConfig = {
    id: value.id,
    label: value.label,
    executable: value.executable,
    args: [...value.args],
    cwd: value.cwd,
    protocol: value.protocol as McpServerConfig['protocol'],
    environment: [...value.environment]
  }
  if (
    server.args.some((arg) =>
      /^(?:--?)(?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret|credential|authorization)(?:=|$)/i.test(
        arg
      )
    )
  )
    fail()
  const runtime = basename(server.executable)
    .replace(/\.exe$/i, '')
    .toLowerCase()
  if (/^(?:node|bun|python(?:\d+(?:\.\d+)*)?|perl|ruby)$/.test(runtime)) {
    // Exclude direct known package dispatchers; trusted installed code is still not sandboxed.
    if (runtime === 'node' && server.args.some((arg) => /^--run(?:=|$)/.test(arg))) fail()
    if (runtime.startsWith('python')) {
      for (let index = 0; index < server.args.length; index++) {
        const argument = server.args[index]
        if (argument === '--' || argument === '-' || !argument.startsWith('-')) break
        if (argument === '-W' || argument === '-X' || argument === '--check-hash-based-pycs') {
          index++
          continue
        }
        const moduleSwitch = /^-[bBdEhiIOPqRsSuvVx]*m(.*)$/.exec(argument)
        if (!moduleSwitch) continue
        const moduleName = moduleSwitch[1] || server.args[index + 1] || ''
        if (
          /^(?:pip(?:\d+(?:\.\d+)*)?|pipx|ensurepip|uv|poetry|pdm|hatch)(?:\.|$)/i.test(moduleName)
        )
          fail()
        break
      }
    }
    if (
      server.args.some(
        (arg) =>
          /^(?:-e|-p|-c|--eval|--print)(?:=|$)/.test(arg) || /^(?:data:|--[^=]+=data:)/i.test(arg)
      )
    )
      fail()
    // Recognize each runtime's inline switches and conservative short-switch bundles, not option-value text.
    if (
      server.args.some((arg) =>
        runtime === 'node'
          ? /^-[ep]+(?:=|$)/.test(arg)
          : runtime.startsWith('python')
            ? /^-[bBdEhiIOPqRsSuvVx]*c/.test(arg)
            : runtime === 'perl'
              ? /^-[0-9acCdfhlnpsStTuUvVwWxX]*[eE]/.test(arg)
              : runtime === 'ruby'
                ? /^-[0-9acdhlnpsSuvUwWy]*e/.test(arg)
                : /^-[ep]/.test(arg)
      )
    )
      fail()
    // Bun's default dispatcher can install packages. Permit only an explicit local script with installation disabled.
    if (
      runtime === 'bun' &&
      (server.args[0] !== '--no-install' ||
        !server.args[1] ||
        !isAbsolute(server.args[1]) ||
        !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(server.args[1]) ||
        (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(server.args[1])) ||
        server.args.slice(1).some((arg) => /^(?:--(?:no-)?install|--shell|-i)(?:=|$)/.test(arg)))
    )
      fail()
  }
  const encoded = JSON.stringify(server)
  if (/\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|Bearer\s+[^\s"\\]{12,})/.test(encoded)) fail()
  if (
    Buffer.byteLength(encoded) > 16 * 1024 ||
    secrets.some((secret) => secret && encoded.includes(secret))
  )
    fail()
  return mcpFreeze(server)
}
function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function privateEntry(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return (
    process.platform === 'win32' ||
    (info.uid === process.getuid?.() && (Number(info.mode) & 0o077) === 0)
  )
}
async function directoryInfo(
  directory: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || !privateEntry(info))
      throw new Error('MCP state directory must be a private owned real directory')
    return info
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}
/** App-private configuration only. Loading never starts or enables a process. */
export class McpConfigStore {
  readonly directory: string
  private readonly secrets: string[]
  private checkpointUnconfirmed = false
  assertLaunchable(): void {
    if (this.checkpointUnconfirmed)
      throw new Error(
        'MCP configuration durable checkpoint is unconfirmed; retry saving before launch'
      )
  }
  constructor(
    directory: string,
    secrets: readonly string[] = [],
    private readonly writer: typeof atomicWrite = atomicWrite
  ) {
    this.directory = resolve(directory)
    this.secrets = [...secrets]
  }
  addSecrets(secrets: readonly string[]): void {
    this.secrets.push(...secrets.filter((value) => value && !this.secrets.includes(value)))
  }
  async load(): Promise<McpConfiguration> {
    const parent = await directoryInfo(this.directory)
    if (!parent) return mcpFreeze({ revision: mcpDigest([]), servers: [] })
    const target = join(this.directory, 'mcp-servers.json')
    let entry
    try {
      entry = await lstat(target)
    } catch (error) {
      if (missing(error)) return mcpFreeze({ revision: mcpDigest([]), servers: [] })
      throw error
    }
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      !privateEntry(entry) ||
      entry.nlink !== 1 ||
      entry.size > MAX_CONFIG_BYTES
    )
      throw new Error('MCP configuration must be a bounded private regular file')
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const current = await file.stat(),
        after = await directoryInfo(this.directory)
      if (
        !current.isFile() ||
        current.nlink !== 1 ||
        !privateEntry(current) ||
        current.dev !== entry.dev ||
        current.ino !== entry.ino ||
        !after ||
        after.dev !== parent.dev ||
        after.ino !== parent.ino
      )
        throw new Error('MCP configuration changed while loading')
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, null)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset > MAX_CONFIG_BYTES) throw new Error('MCP configuration exceeds its byte limit')
      const final = await file.stat(),
        named = await lstat(target),
        directory = await directoryInfo(this.directory)
      if (
        named.isSymbolicLink() ||
        !named.isFile() ||
        named.nlink !== 1 ||
        !privateEntry(named) ||
        named.dev !== current.dev ||
        named.ino !== current.ino ||
        final.size !== offset ||
        final.size !== current.size ||
        final.mtimeMs !== current.mtimeMs ||
        final.ctimeMs !== current.ctimeMs ||
        !directory ||
        directory.dev !== parent.dev ||
        directory.ino !== parent.ino
      )
        throw new Error('MCP configuration changed while reading')
      const parsed: unknown = JSON.parse(bytes.subarray(0, offset).toString('utf8'))
      if (
        !mcpRecord(parsed) ||
        Object.keys(parsed).length !== 2 ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.servers) ||
        parsed.servers.length > 8
      )
        fail()
      const servers = parsed.servers.map((server) => validateMcpServer(server, this.secrets))
      if (new Set(servers.map((server) => server.id)).size !== servers.length) fail()
      return mcpFreeze({ revision: mcpDigest(servers), servers })
    } finally {
      await file.close()
    }
  }
  save(servers: readonly McpServerConfig[], expectedRevision: string): Promise<McpConfiguration> {
    return withAgentPersistenceOperation(() => this.saveAdmitted(servers, expectedRevision))
  }
  private async saveAdmitted(
    servers: readonly McpServerConfig[],
    expectedRevision: string
  ): Promise<McpConfiguration> {
    if (!Array.isArray(servers) || servers.length > 8) fail()
    const validated = servers.map((server) => validateMcpServer(server, this.secrets))
    if (new Set(validated.map((server) => server.id)).size !== validated.length) fail()
    const encoded = JSON.stringify({ schemaVersion: 1, servers: validated }) + '\n'
    if (Buffer.byteLength(encoded) > MAX_CONFIG_BYTES) fail()
    // The dedicated child is private; userData itself need not be mode 0700.
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const parent = await directoryInfo(this.directory)
    if (!parent) throw new Error('MCP private state directory is unavailable')
    const target = join(this.directory, 'mcp-servers.json'),
      lockPath = join(this.directory, 'mcp-servers.lock')
    const lease = await open(
      lockPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    const leaseInfo = await lease.stat()
    try {
      if ((await this.load()).revision !== expectedRevision)
        throw new Error('MCP configuration changed; reload its settings')
      for (const path of [target, `${target}.bak`]) {
        try {
          const entry = await lstat(path)
          if (
            !entry.isFile() ||
            entry.isSymbolicLink() ||
            entry.nlink !== 1 ||
            !privateEntry(entry) ||
            entry.size > MAX_CONFIG_BYTES
          )
            throw new Error('MCP persistence targets must be bounded private ordinary files')
        } catch (error) {
          if (!missing(error)) throw error
        }
      }
      const after = await directoryInfo(this.directory)
      if (!after || after.dev !== parent.dev || after.ino !== parent.ino)
        throw new Error('MCP state directory changed while saving')
      const result = await this.writer(target, encoded, {
        validate: (raw) => {
          const parsed: unknown = JSON.parse(raw)
          if (
            !mcpRecord(parsed) ||
            Object.keys(parsed).length !== 2 ||
            parsed.schemaVersion !== 1 ||
            !Array.isArray(parsed.servers) ||
            parsed.servers.length > 8
          )
            fail()
          const values = parsed.servers.map((server) => validateMcpServer(server, this.secrets))
          if (new Set(values.map((server) => server.id)).size !== values.length) fail()
        }
      })
      this.checkpointUnconfirmed = result.durability === 'uncertain'
      if (this.checkpointUnconfirmed)
        throw new Error(
          'MCP configuration committed, but its durable checkpoint is unconfirmed; retry saving before launch'
        )
      const final = await directoryInfo(this.directory)
      if (!final || final.dev !== parent.dev || final.ino !== parent.ino)
        throw new Error('MCP state directory changed while saving')
      return mcpFreeze({ revision: mcpDigest(validated), servers: validated })
    } finally {
      await lease.close()
      const current = await lstat(lockPath).catch(() => undefined)
      if (current?.dev === leaseInfo.dev && current.ino === leaseInfo.ino) await unlink(lockPath)
    }
  }
}
export interface McpLaunchIdentity {
  readonly server: McpServerConfig
  readonly configRevision: string
  readonly executableRevision: string
  readonly workingDirectoryRevision: string
  readonly environment: Readonly<Record<string, string>>
  readonly digest: string
}
/** Resolve an already installed executable; no PATH lookup, shell or installation. */
export async function prepareMcpLaunch(
  server: McpServerConfig,
  configRevision: string,
  env: NodeJS.ProcessEnv,
  secrets: readonly string[] = []
): Promise<McpLaunchIdentity> {
  const knownSecrets = [...secrets, ...environmentSecrets(env)]
  const checked = validateMcpServer(server, knownSecrets)
  const executable = await realpath(checked.executable),
    cwd = await realpath(checked.cwd)
  const info = await lstat(executable),
    folder = await lstat(cwd)
  if (!info.isFile() || !folder.isDirectory() || info.size > 256 * 1024 * 1024)
    throw new Error('MCP launch requires an installed executable and an existing working directory')
  const canonical = validateMcpServer({ ...checked, executable, cwd }, knownSecrets)
  if ([checked.executable, executable].some((path) => /^bun(?:\.exe)?$/i.test(basename(path)))) {
    const script = await realpath(checked.args[1] ?? '')
    if (!(await lstat(script)).isFile())
      throw new Error('Bun MCP launch requires an already installed script')
    await access(script, constants.R_OK)
  }
  if (process.platform !== 'win32' && (Number(info.mode) & 0o6000) !== 0)
    throw new Error('MCP requires an unprivileged installed executable')
  await access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  if (process.platform === 'win32' && !/\.exe$/i.test(executable))
    throw new Error('MCP launch requires a native installed .exe on Windows')
  const file = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  const hash = createHash('sha256')
  try {
    const before = await file.stat()
    if (before.dev !== info.dev || before.ino !== info.ino)
      throw new Error('MCP executable changed')
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
    const after = await file.stat()
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('MCP executable changed')
  } finally {
    await file.close()
  }
  const environment: Record<string, string> = {}
  for (const name of checked.environment) {
    const value =
      process.platform === 'win32'
        ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
        : env[name]
    if (value === undefined) continue
    if (
      !mcpText(value, 4096) ||
      value.startsWith('()') ||
      knownSecrets.some((secret) => secret && value.includes(secret)) ||
      /\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|Bearer\s+[^\s"\\]{12,})/.test(value)
    )
      throw new Error('MCP environment value is unavailable or unsafe')
    environment[name] = value
  }
  const body = {
    server: canonical,
    configRevision,
    executableRevision: hash.digest('hex'),
    workingDirectoryRevision: mcpDigest({ dev: String(folder.dev), ino: String(folder.ino) }),
    environment
  }
  return mcpFreeze({ ...body, digest: mcpDigest(body) })
}
