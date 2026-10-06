import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createSkillCatalog,
  parseSkillDocument,
  skillCreatorSource,
  SKILL_LIMITS,
  validateSkillResourcePath,
  type SkillCatalog,
  type SkillReadRequest,
  type SkillSaveProposal,
  type SkillSource
} from '@ayayaq/vivi/extensions/skills'
import { getAgentSkillSaveSupport } from './agentSkillSaveSupport'
import { atomicWrite } from './atomicPersistence'
import { reportAgentPersistenceNotice } from './agentPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import type {
  AgentSkillDiagnostic,
  AgentSkillReceipt,
  AgentSkillsStatus
} from '../../shared/agentSkillTypes'

const MAX_ROOTS = 8
const MAX_DIRECTORY_ENTRIES = 1000
// Match vivi-cli's documented state/credential resource exclusion. This is not a secret detector.
const protectedComponent =
  /^(?:\.git|\.aws|\.codex|\.env(?:[._-].*)?|credentials?(?:[._-].*)?|auth(?:[._-].*)?|tokens?(?:[._-].*)?|passwords?(?:[._-].*)?|secrets?(?:[._-].*)?|private[-_]keys?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|sessions?(?:[._-].*)?|preferences?(?:[._-].*)?|memories?(?:[._-].*)?|.*\.(?:pem|key|p12|pfx))$/iu
export function skillPathsOverlap(left: string, right: string): boolean {
  const within = (root: string, path: string) => {
    const difference = relative(root, path)
    return (
      difference === '' ||
      (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
    )
  }
  return within(left, right) || within(right, left)
}
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Identity = { dev: number; ino: number }
interface Binding {
  collection: string
  root: string
  identity: Identity
  revision: string
  content: string
  readOnly: boolean
}

/** Refuse symlink/reparse aliases, including parents, rather than granting another root. */
async function checkedDirectory(path: string): Promise<Identity> {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error('Skill folder must be an absolute canonical path')
  let current = parse(path).root
  for (const part of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Skill folders must be ordinary directories without symlinks')
  }
  if ((await fs.realpath(path)) !== path) throw new Error('Skill folder canonical path changed')
  const stat = await fs.lstat(path)
  return { dev: stat.dev, ino: stat.ino }
}

async function assertDirectory(path: string, expected: Identity): Promise<void> {
  const actual = await checkedDirectory(path)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error('Skill folder changed; refresh the skills catalog')
}

/** Bound bytes before reading, use one file handle, and reject changed file/root evidence. */
async function readText(root: string, path: string, expected: Identity): Promise<string> {
  validateSkillResourcePath(path)
  if (path.split('/').some((part) => protectedComponent.test(part)))
    throw new Error('Credential and app-state resource components are not readable as skills')
  await assertDirectory(root, expected)
  const parts = path.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    await checkedDirectory(current)
  }
  const destination = join(current, parts.at(-1)!)
  const before = await fs.lstat(destination)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1)
    throw new Error('Skill text must be an ordinary file without symlinks')
  if (before.size > SKILL_LIMITS.maximumResourceBytes)
    throw new Error('Skill text exceeds the 64 KiB byte limit')
  const file = await fs.open(destination, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  try {
    const opened = await file.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > SKILL_LIMITS.maximumResourceBytes
    )
      throw new Error('Skill file changed while opening')
    const buffer = Buffer.alloc(SKILL_LIMITS.maximumResourceBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, length)
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length > SKILL_LIMITS.maximumResourceBytes)
      throw new Error('Skill text exceeds the 64 KiB byte limit')
    const after = await file.stat()
    const named = await fs.lstat(destination)
    if (
      named.isSymbolicLink() ||
      named.nlink !== 1 ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      after.size !== length ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error('Skill file changed while reading; refresh the skills catalog')
    await assertDirectory(root, expected)
    return decoder.decode(buffer.subarray(0, length))
  } finally {
    await file.close()
  }
}

async function withStoreLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const path = join(root, '.agent-skills.lock')
  const token = randomUUID()
  let file: Awaited<ReturnType<typeof fs.open>>
  try {
    file = await fs.open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const recoveryPath = join(root, '.agent-skills-recovery.lock')
    const recovery = await fs.open(recoveryPath, 'wx', 0o600).catch(() => {
      throw new Error('Skill store recovery is busy; retry or resolve an interrupted recovery')
    })
    try {
      // A crashed host leaves only an internal lock. Never break a live or unreadable lock.
      const identity = await checkedDirectory(root)
      const raw = await readText(root, '.agent-skills.lock', identity)
      const lock = JSON.parse(raw) as { pid?: unknown }
      if (!Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0)
        throw new Error('Skill store lock needs manual recovery')
      try {
        process.kill(Number(lock.pid), 0)
        throw new Error('Skill store is busy in another process; retry later')
      } catch (check) {
        if ((check as NodeJS.ErrnoException).code !== 'ESRCH') throw check
      }
      // Recheck exact bytes before recovering a dead process's lock.
      if ((await readText(root, '.agent-skills.lock', identity)) !== raw)
        throw new Error('Skill store lock changed; retry later')
      await fs.unlink(path)
      file = await fs.open(path, 'wx', 0o600)
    } finally {
      await recovery.close()
      await fs.unlink(recoveryPath).catch(() => undefined)
    }
  }
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8')
    await file.sync()
    return await operation()
  } finally {
    await file.close().catch((error) => {
      reportAgentPersistenceNotice({
        level: 'warning',
        message: `Skill store lock close failed: ${detail(error)}. Any committed skill remains saved; inspect its current revision before retrying.`
      })
    })
    // Do not remove a replacement lock owned by another process.
    try {
      const identity = await checkedDirectory(root)
      const raw = await readText(root, '.agent-skills.lock', identity)
      if ((JSON.parse(raw) as { token?: string }).token === token) await fs.unlink(path)
    } catch (error) {
      reportAgentPersistenceNotice({
        level: 'warning',
        message: `Skill store lock cleanup failed: ${detail(error)}. Any committed skill remains saved; the next save may need lock recovery.`
      })
    }
  }
}

export interface AgentSkillSnapshot {
  catalog: SkillCatalog
  status: AgentSkillsStatus
  authorizeRead: (request: SkillReadRequest, context: { signal: AbortSignal }) => Promise<boolean>
}

export function createAgentSkillStore(options: {
  ownedRoot: () => string
  externalRoots: () => Promise<readonly string[]>
  assertContent?: (content: string) => void
}): {
  snapshot: () => Promise<AgentSkillSnapshot>
  destination: (name: string) => string
  commit: (
    proposal: SkillSaveProposal,
    context: { signal: AbortSignal }
  ) => Promise<AgentSkillReceipt>
} {
  let chain: Promise<unknown> = Promise.resolve()
  const destination = (name: string): string => {
    validateSkillResourcePath(`${name}/SKILL.md`)
    if (
      parseSkillDocument(`---\nname: ${name}\ndescription: Check\n---\nCheck.`, name).metadata
        .name !== name
    )
      throw new Error('Skill destination must use its canonical name')
    if (name === 'skill-creator') throw new Error('The bundled skill creator is read-only')
    return join(options.ownedRoot(), name, 'SKILL.md')
  }

  async function snapshot(): Promise<AgentSkillSnapshot> {
    const ownedRoot = options.ownedRoot()
    const externalRoots = [...(await options.externalRoots())]
    if (externalRoots.length > MAX_ROOTS) throw new Error('Too many configured skill folders')
    const diagnostics: AgentSkillDiagnostic[] = []
    const candidates: Array<{ name: string; source: SkillSource; binding: Binding }> = []
    let entries = 0
    const diagnostic = (source: string, message: string) => diagnostics.push({ source, message })
    for (const collection of [ownedRoot, ...externalRoots]) {
      const readOnly = collection !== ownedRoot
      try {
        if (readOnly && skillPathsOverlap(collection, dirname(ownedRoot)))
          throw new Error('Read-only skill folders cannot overlap the app state folder')
        await checkedDirectory(collection)
        const folders: string[] = []
        const direct = await fs.lstat(join(collection, 'SKILL.md')).catch((error) => {
          if (!isMissing(error)) throw error
          return null
        })
        if (readOnly && direct) folders.push(collection)
        else {
          const directory = await fs.opendir(collection)
          for await (const entry of directory) {
            if (++entries > MAX_DIRECTORY_ENTRIES)
              throw new Error('Skill folder scan exceeds 1000 entries')
            if (entry.name.startsWith('.')) continue
            if (entry.isDirectory() || entry.isSymbolicLink())
              folders.push(join(collection, entry.name))
          }
        }
        for (const root of folders.sort()) {
          if (candidates.length >= SKILL_LIMITS.maximumSkills - 1) {
            diagnostic(collection, 'Skill limit reached (99 folders plus bundled creator)')
            break
          }
          try {
            validateSkillResourcePath(`${basename(root)}/SKILL.md`)
            const identity = await checkedDirectory(root)
            const content = await readText(root, 'SKILL.md', identity)
            options.assertContent?.(content)
            const document = parseSkillDocument(content, basename(root))
            if (document.metadata.name !== basename(root))
              throw new Error(
                'Skill folder must use its canonical normalized name; source has not been rewritten'
              )
            for (const warning of document.warnings) diagnostic(root, warning)
            if (
              document.warnings.some((warning) =>
                /"(?:disable-model-invocation|user-invocable|context|agent)"/u.test(warning)
              )
            ) {
              diagnostic(root, 'Not discovered: host-specific invocation semantics are unsupported')
              continue
            }
            if (document.metadata.compatibility)
              diagnostic(
                root,
                `Compatibility requirements (not granted): ${document.metadata.compatibility}`
              )
            const binding: Binding = {
              root,
              collection,
              identity,
              revision: document.revision,
              content,
              readOnly
            }
            candidates.push({
              name: document.metadata.name,
              binding,
              source: {
                content,
                readOnly,
                readResource: async (request, { signal }) => {
                  signal.throwIfAborted()
                  if (!(await authorized(binding)))
                    throw new Error('Skill folder is no longer configured')
                  if (
                    parseSkillDocument(await readText(root, 'SKILL.md', identity), basename(root))
                      .revision !== request.expectedRevision
                  )
                    throw new Error(
                      'Skill source changed; refresh on the next turn before reading resources'
                    )
                  const resource = await readText(root, request.path, identity)
                  options.assertContent?.(resource)
                  signal.throwIfAborted()
                  if (
                    parseSkillDocument(await readText(root, 'SKILL.md', identity), basename(root))
                      .revision !== request.expectedRevision
                  )
                    throw new Error('Skill source changed while reading resources')
                  options.assertContent?.(resource)
                  return resource
                }
              }
            })
          } catch (error) {
            diagnostic(root, detail(error))
          }
        }
      } catch (error) {
        if (!(collection === ownedRoot && isMissing(error))) diagnostic(collection, detail(error))
      }
    }
    const sources: SkillSource[] = [skillCreatorSource]
    const bindings = new Map<string, Binding>()
    for (const candidate of candidates) {
      if (
        candidate.name === 'skill-creator' ||
        candidates.filter((item) => item.name === candidate.name).length > 1
      ) {
        diagnostic(candidate.binding.root, `Duplicate skill name excluded: ${candidate.name}`)
        continue
      }
      try {
        createSkillCatalog([...sources, candidate.source])
        sources.push(candidate.source)
        bindings.set(candidate.name, candidate.binding)
      } catch (error) {
        diagnostic(candidate.binding.root, detail(error))
      }
    }
    const catalog = createSkillCatalog(sources)
    return {
      catalog,
      status: {
        saveSupport: getAgentSkillSaveSupport(),
        ownedRoot,
        externalRoots,
        skills: structuredClone(catalog.skills) as AgentSkillsStatus['skills'],
        diagnostics
      },
      authorizeRead: async (request, { signal }) => {
        signal.throwIfAborted()
        if (request.name === 'skill-creator') return true
        const binding = bindings.get(request.name)
        return !!binding && (await authorized(binding))
      }
    }
  }

  async function authorized(binding: Binding): Promise<boolean> {
    if (binding.readOnly && !(await options.externalRoots()).includes(binding.collection))
      return false
    await assertDirectory(binding.root, binding.identity)
    options.assertContent?.(binding.content)
    return true
  }

  function commit(
    proposal: SkillSaveProposal,
    { signal }: { signal: AbortSignal }
  ): Promise<AgentSkillReceipt> {
    const captured = structuredClone(proposal)
    return withAgentPersistenceOperation(() => {
      const pending = chain
        .catch(() => undefined)
        .then(async () => {
          signal.throwIfAborted()
          const support = getAgentSkillSaveSupport()
          if (!support.available) throw new Error(support.reason)
          const target = destination(captured.name)
          options.assertContent?.(captured.after.content)
          const after = parseSkillDocument(captured.after.content, captured.name)
          if (after.revision !== captured.after.revision)
            throw new Error('Reviewed skill content changed')
          const ownedRoot = options.ownedRoot()
          // Only create the known app-owned root; never create a selected external collection.
          await checkedDirectory(dirname(ownedRoot))
          await fs.mkdir(ownedRoot, { recursive: false }).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          })
          const rootIdentity = await checkedDirectory(ownedRoot)
          return withStoreLock(ownedRoot, async () => {
            signal.throwIfAborted()
            await assertDirectory(ownedRoot, rootIdentity)
            const folder = dirname(target)
            let current: string | null = null
            try {
              const identity = await checkedDirectory(folder)
              current = await readText(folder, 'SKILL.md', identity)
            } catch (error) {
              if (!isMissing(error)) throw error
            }
            const revision =
              current === null ? null : parseSkillDocument(current, captured.name).revision
            if (revision !== captured.expectedRevision)
              throw new Error(
                'Skill revision changed after review; refresh and review the exact new draft'
              )
            let createdFolder = false
            if (current === null) {
              // Do not create over an interrupted/externally modified folder or backup.
              const existing = await fs.lstat(folder).catch((error) => {
                if (!isMissing(error)) throw error
                return null
              })
              if (existing)
                throw new Error(
                  'Skill folder already exists without a valid SKILL.md; resolve it before creating'
                )
              await fs.mkdir(folder, { mode: 0o700 })
              createdFolder = true
            }
            try {
              const identity = await checkedDirectory(folder)
              for (const leaf of ['SKILL.md', 'SKILL.md.bak']) {
                const existing = await fs.lstat(join(folder, leaf)).catch((error) => {
                  if (!isMissing(error)) throw error
                  return null
                })
                if (
                  existing &&
                  (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)
                )
                  throw new Error('Skill save files must be ordinary files')
              }
              await assertDirectory(ownedRoot, rootIdentity)
              await assertDirectory(folder, identity)
              signal.throwIfAborted()
              const written = await atomicWrite(target, after.content, {
                validate: (content) => {
                  parseSkillDocument(content, captured.name)
                },
                beforeCommit: async () => {
                  signal.throwIfAborted()
                  await assertDirectory(ownedRoot, rootIdentity)
                  await assertDirectory(folder, identity)
                  let latest: string | null = null
                  try {
                    latest = await readText(folder, 'SKILL.md', identity)
                  } catch (error) {
                    if (!isMissing(error)) throw error
                  }
                  if (
                    (latest === null
                      ? null
                      : parseSkillDocument(latest, captured.name).revision) !==
                    captured.expectedRevision
                  )
                    throw new Error('Skill revision changed before commit; review again')
                  options.assertContent?.(after.content)
                  signal.throwIfAborted()
                }
              })
              // A resolved atomic rename is committed even if cancellation arrives afterwards.
              return {
                saved: true as const,
                name: captured.name,
                revision: after.revision,
                destination: target,
                available: 'next_turn' as const,
                durability: written.durability
              }
            } catch (error) {
              // Remove only an empty directory this operation created before any commit.
              if (createdFolder) await fs.rmdir(folder).catch(() => undefined)
              throw error
            }
          })
        })
      chain = pending
      return pending
    })
  }
  return { snapshot, destination, commit }
}
