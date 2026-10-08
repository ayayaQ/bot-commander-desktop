import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import {
  createSkillCatalog,
  parseSkillDocument,
  skillCreatorSource,
  SKILL_LIMITS,
  validateSkillResourcePath,
  type SkillCatalog,
  type SkillReadRequest,
  type SkillSource
} from '@ayayaq/vivi/extensions/skills'
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
                readOnly: true,
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

  return { snapshot }
}
