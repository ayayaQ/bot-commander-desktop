import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import fsSync from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import {
  createSkillCatalog,
  parseSkillDocument,
  skillCreatorSource,
  SKILL_LIMITS,
  validateSkillResourcePath,
  validateSkillName,
  type SkillCatalog,
  type SkillReadRequest,
  type SkillSource
} from '@ayayaq/vivi/extensions/skills'
import { atomicWrite } from './atomicPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import { withResourceMutationLock, resourceRevision } from './resourceChangeService'
import { getAgentSkillSaveSupport } from './agentSkillSaveSupport'
import type { AgentSkillDiagnostic, AgentSkillsStatus } from '../../shared/agentSkillTypes'

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

type Identity = { dev: number; ino: number; path: string }
export interface PreparedSkillSave {
  name: string
  content: string
  expectedRevision: string | null
  parent: Identity
  collection: Identity | null
  directory: Identity | null
}
interface Binding {
  collection: string
  root: string
  identity: Identity
  revision: string
  content: string
  readOnly: boolean
}

/** Check ordinary directory ancestry and actual identity; Windows spelling aliases are valid. */
export async function checkedSkillDirectory(path: string): Promise<Identity> {
  if (!isAbsolute(path) || resolve(path) !== path)
    throw new Error('Skill folder must be an absolute canonical path')
  let current = parse(path).root
  for (const part of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part)
    const stat = await fs.lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('Skill folders must be ordinary directories without symlinks')
  }
  const canonical = await fs.realpath(path)
  const stat = await fs.lstat(path)
  const actual = await fs.lstat(canonical)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    actual.isSymbolicLink() ||
    !actual.isDirectory() ||
    stat.ino === 0 ||
    actual.dev !== stat.dev ||
    actual.ino !== stat.ino
  )
    throw new Error('Skill folder canonical identity changed')
  return { dev: stat.dev, ino: stat.ino, path: canonical }
}

async function assertDirectory(path: string, expected: Identity): Promise<void> {
  const actual = await checkedSkillDirectory(path)
  if (actual.dev !== expected.dev || actual.ino !== expected.ino)
    throw new Error('Skill folder changed; refresh the skills catalog')
}

function assertDirectorySync(path: string, expected?: Identity): void {
  let ancestor = parse(path).root
  for (const part of path.slice(ancestor.length).split(/[\\/]/u).filter(Boolean)) {
    ancestor = join(ancestor, part)
    const stat = fsSync.lstatSync(ancestor)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe skill folder')
  }
  const stat = fsSync.lstatSync(path)
  if (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))
    throw new Error('Skill folder changed before saving')
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
    await checkedSkillDirectory(current)
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
  prepareSave: (args: Record<string, unknown>) => Promise<{
    save: PreparedSkillSave
    before: { id: string; content: string } | null
    after: { id: string; content: string }
  }>
  commitSave: (
    save: PreparedSkillSave,
    context?: { signal?: AbortSignal; beforeCommit?: () => void }
  ) => Promise<void>
  reviewRevision: (name: string) => string
} {
  async function snapshot(): Promise<AgentSkillSnapshot> {
    const ownedRoot = options.ownedRoot()
    const externalRoots = [...(await options.externalRoots())]
    if (externalRoots.length > MAX_ROOTS) throw new Error('Too many configured skill folders')
    const diagnostics: AgentSkillDiagnostic[] = []
    const candidates: Array<{ name: string; source: SkillSource; binding: Binding }> = []
    let entries = 0
    const collections = new Set<string>()
    const diagnostic = (source: string, message: string) => diagnostics.push({ source, message })
    for (const collection of [ownedRoot, ...externalRoots]) {
      const readOnly = collection !== ownedRoot
      try {
        const identity = await checkedSkillDirectory(collection)
        const state = await checkedSkillDirectory(dirname(ownedRoot))
        if (readOnly && skillPathsOverlap(identity.path, state.path))
          throw new Error('Read-only skill folders cannot overlap the app state folder')
        const key = `${identity.dev}:${identity.ino}`
        if (collections.has(key)) continue
        collections.add(key)
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
            const identity = await checkedSkillDirectory(root)
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

  async function optionalDirectory(path: string): Promise<Identity | null> {
    try {
      return await checkedSkillDirectory(path)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async function prepareSave(args: Record<string, unknown>) {
    if (
      Object.keys(args).length !== 3 ||
      !['name', 'content', 'expectedRevision'].every((key) => Object.hasOwn(args, key))
    )
      throw new Error('Supply only name, content and expectedRevision for a skill save')
    validateSkillName(args.name)
    const name = args.name.trim().normalize('NFKC')
    validateSkillResourcePath(`${name}/SKILL.md`)
    if (name === 'skill-creator' || protectedComponent.test(name))
      throw new Error('This skill name is reserved or protected')
    if (
      args.expectedRevision !== null &&
      (typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(args.expectedRevision))
    )
      throw new Error('expectedRevision must be null or a listed SHA-256 revision')
    if (typeof args.content !== 'string') throw new Error('Skill content must be text')
    const document = parseSkillDocument(args.content, name)
    if (
      document.warnings.some((warning) =>
        /"(?:disable-model-invocation|user-invocable|context|agent)"/u.test(warning)
      )
    )
      throw new Error('Host-specific invocation semantics are unsupported')
    options.assertContent?.(args.content)
    const ownedRoot = options.ownedRoot()
    const parent = await checkedSkillDirectory(dirname(ownedRoot))
    const collection = await optionalDirectory(ownedRoot)
    const directory = collection ? await optionalDirectory(join(ownedRoot, name)) : null
    const catalog = await snapshot()
    const existing = catalog.catalog.document(name)
    if (catalog.status.skills.find((skill) => skill.name === name)?.readOnly)
      throw new Error('Built-in or read-only skills cannot be replaced')
    // Excluded/duplicate/invalid folders must not be silently overwritten or shadowed.
    if (directory && !existing)
      throw new Error('Existing skill folder is unavailable; refresh skills')
    for (const external of await options.externalRoots()) {
      const direct = basename(external) === name ? external : join(external, name)
      if (
        await fs.lstat(direct).catch((error) => {
          if (!isMissing(error)) throw error
          return null
        })
      )
        throw new Error('A read-only skill folder already uses this name')
    }
    if (args.expectedRevision !== (existing?.revision ?? null))
      throw new Error('Skill revision is stale; read the current catalog before saving')
    if (!existing && catalog.status.skills.length >= SKILL_LIMITS.maximumSkills)
      throw new Error('Skill limit reached')
    return {
      save: {
        name,
        content: args.content,
        expectedRevision: args.expectedRevision as string | null,
        parent,
        collection,
        directory
      },
      before: existing ? { id: name, content: existing.content } : null,
      after: { id: name, content: args.content }
    }
  }

  // Used both by the reviewer binding and by the final synchronous atomic commit gate.
  function reviewRevision(name: string): string {
    validateSkillName(name)
    validateSkillResourcePath(`${name}/SKILL.md`)
    const path = join(options.ownedRoot(), name, 'SKILL.md')
    try {
      assertDirectorySync(dirname(path))
      const stat = fsSync.lstatSync(path)
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > SKILL_LIMITS.maximumDocumentBytes
      )
        throw new Error('Unsafe skill file')
      const file = fsSync.openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const opened = fsSync.fstatSync(file)
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size > SKILL_LIMITS.maximumDocumentBytes
        )
          throw new Error('Skill file changed while opening')
        const buffer = Buffer.alloc(SKILL_LIMITS.maximumDocumentBytes + 1)
        let length = 0
        while (length < buffer.length) {
          const bytes = fsSync.readSync(file, buffer, length, buffer.length - length, length)
          if (!bytes) break
          length += bytes
        }
        const after = fsSync.fstatSync(file)
        const named = fsSync.lstatSync(path)
        if (
          length > SKILL_LIMITS.maximumDocumentBytes ||
          after.size !== length ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs ||
          named.isSymbolicLink() ||
          named.nlink !== 1 ||
          named.dev !== opened.dev ||
          named.ino !== opened.ino
        )
          throw new Error('Skill file changed while reading')
        return resourceRevision({
          name,
          revision: parseSkillDocument(decoder.decode(buffer.subarray(0, length)), name).revision
        })
      } finally {
        fsSync.closeSync(file)
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      return resourceRevision({ name, revision: null })
    }
  }

  function commitSave(
    input: PreparedSkillSave,
    context: { signal?: AbortSignal; beforeCommit?: () => void } = {}
  ): Promise<void> {
    const save = structuredClone(input)
    return withAgentPersistenceOperation(() =>
      withResourceMutationLock('skills', async () => {
        context.signal?.throwIfAborted()
        const current = await prepareSave({
          name: save.name,
          content: save.content,
          expectedRevision: save.expectedRevision
        })
        for (const key of ['parent', 'collection', 'directory'] as const) {
          const before = save[key],
            after = current.save[key]
          if (
            !!before !== !!after ||
            (before && (before.dev !== after!.dev || before.ino !== after!.ino))
          )
            throw new Error('Skill folder changed; propose a fresh save')
        }
        const ownedRoot = options.ownedRoot()
        if (!current.save.collection) await fs.mkdir(ownedRoot)
        const collection = await checkedSkillDirectory(ownedRoot)
        const root = join(ownedRoot, save.name)
        if (!current.save.directory) await fs.mkdir(root)
        const directory = await checkedSkillDirectory(root)
        const expected = resourceRevision({ name: save.name, revision: save.expectedRevision })
        // Validate every ancestor synchronously immediately before rename, including on Windows.
        const gate = () => {
          context.signal?.throwIfAborted()
          assertDirectorySync(dirname(ownedRoot), save.parent)
          assertDirectorySync(ownedRoot, collection)
          assertDirectorySync(root, directory)
          if (reviewRevision(save.name) !== expected)
            throw new Error('Skill revision changed before saving')
          options.assertContent?.(save.content)
          context.beforeCommit?.()
        }
        try {
          gate()
          const backup = join(root, 'SKILL.md.bak')
          const stat = await fs.lstat(backup).catch((error) => {
            if (!isMissing(error)) throw error
            return null
          })
          if (
            stat &&
            (stat.isSymbolicLink() ||
              !stat.isFile() ||
              stat.nlink !== 1 ||
              stat.size > SKILL_LIMITS.maximumDocumentBytes)
          )
            throw new Error('Unsafe skill backup')
          await atomicWrite(join(root, 'SKILL.md'), save.content, {
            validate: (content) => {
              parseSkillDocument(content, save.name)
            },
            beforeCommit: gate
          })
        } catch (error) {
          // Only remove empty directories created by this failed attempt, never user content.
          if (!save.directory) {
            try {
              assertDirectorySync(root, directory)
              await fs.rmdir(root)
            } catch {
              /* kept */
            }
          }
          if (!save.collection) {
            try {
              assertDirectorySync(ownedRoot, collection)
              await fs.rmdir(ownedRoot)
            } catch {
              /* kept */
            }
          }
          throw error
        }
      })
    )
  }

  return { snapshot, prepareSave, commitSave, reviewRevision }
}
