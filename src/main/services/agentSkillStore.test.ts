import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSkillsExtension,
  parseSkillDocument,
  type SkillSaveProposal
} from '@ayayaq/vivi/extensions/skills'
import { createAgentSkillStore } from './agentSkillStore'
import * as atomic from './atomicPersistence'
import {
  drainAgentPersistence,
  pauseAgentPersistence,
  resumeAgentPersistence
} from './agentPersistenceLifecycle'

vi.mock('./agentSkillSaveSupport', () => ({
  getAgentSkillSaveSupport: () => ({
    available: true,
    reason: 'Ordinary temporary-folder fixture writer only; not production acceptance'
  })
}))

const source = (name: string, body = 'Return three factual bullets.') =>
  `---\nname: ${name}\ndescription: >-\n  Summarize supplied text.\n  Use for a short summary.\nlicense: Apache-2.0\ncompatibility: Requires supplied text only\nmetadata:\n  author: Example\nallowed-tools: read_skill\ncustom-field: retained\n---\n\n${body}\n`
const signal = () => new AbortController().signal
const proposal = (
  name: string,
  content: string,
  before: ReturnType<typeof parseSkillDocument> | null = null
): SkillSaveProposal => ({
  name,
  before,
  expectedRevision: before?.revision ?? null,
  after: parseSkillDocument(content, name)
})

describe('desktop instruction-only skill store with an ordinary temporary-folder fixture writer', () => {
  let home: string
  let roots: string[]
  let store: ReturnType<typeof createAgentSkillStore>
  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'desktop-skills-'))
    roots = []
    await fs.mkdir(join(home, 'state'))
    resumeAgentPersistence()
    atomic.reopenAtomicWrites()
    store = createAgentSkillStore({
      ownedRoot: () => join(home, 'state/agent-skills'),
      externalRoots: async () => [...roots]
    })
  })
  afterEach(async () => {
    resumeAgentPersistence()
    await drainAgentPersistence()
    vi.restoreAllMocks()
    await fs.rm(home, { recursive: true, force: true })
  })
  async function folder(collection: string, name: string, content = source(name)) {
    const root = join(collection, name)
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(join(root, 'SKILL.md'), content)
    return root
  }
  it('always includes the portable read-only creator, without scanning cwd or creating folders', async () => {
    const snapshot = await store.snapshot()
    expect(snapshot.catalog.skills.map((skill) => skill.name)).toEqual(['skill-creator'])
    expect(snapshot.catalog.skills[0].readOnly).toBe(true)
    expect(snapshot.status.ownedRoot).toBe(join(home, 'state/agent-skills'))
    await expect(fs.stat(snapshot.status.ownedRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('supports canonical Unicode folder names without rewriting sources', async () => {
    await folder(join(home, 'state/agent-skills'), 'café', source('café'))
    const snapshot = await store.snapshot()
    expect(snapshot.catalog.document('café')!.content).toBe(source('café'))
  })
  it('reads existing standard folders and references unchanged, preserving unknown fields and YAML', async () => {
    roots = [join(home, 'existing')]
    const root = await folder(roots[0], 'concise-summary')
    await fs.mkdir(join(root, 'references'))
    await fs.writeFile(join(root, 'references', 'style.md'), '# Style\nUse plain language.\n')
    const before = await fs.readFile(join(root, 'SKILL.md'), 'utf8')
    const snapshot = await store.snapshot()
    const doc = snapshot.catalog.document('concise-summary')!
    expect(doc.content).toBe(before)
    expect(doc.metadata.description).toBe('Summarize supplied text. Use for a short summary.')
    expect(doc.metadata.metadata).toEqual({ author: 'Example' })
    expect(snapshot.status.diagnostics.map((entry) => entry.message)).toContain(
      'Unsupported frontmatter field ignored: "custom-field"'
    )
    const request = {
      name: 'concise-summary',
      path: 'references/style.md',
      expectedRevision: doc.revision
    }
    expect(await snapshot.authorizeRead(request, { signal: signal() })).toBe(true)
    expect(await snapshot.catalog.read(request, { signal: signal() })).toBe(
      '# Style\nUse plain language.\n'
    )
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(before)
  })
  it('keeps scripts inert and refuses changed source resources and removed external roots', async () => {
    roots = [join(home, 'existing')]
    const root = await folder(roots[0], 'summarize')
    await fs.mkdir(join(root, 'scripts'))
    await fs.writeFile(join(root, 'scripts', 'example.py'), 'print("inert example")\n')
    const snapshot = await store.snapshot()
    const request = {
      name: 'summarize',
      path: 'scripts/example.py',
      expectedRevision: snapshot.catalog.document('summarize')!.revision
    }
    expect(await snapshot.catalog.read(request, { signal: signal() })).toContain('inert example')
    await fs.writeFile(join(root, 'SKILL.md'), source('summarize', 'Changed instructions.'))
    await expect(snapshot.catalog.read(request, { signal: signal() })).rejects.toThrow(
      'Skill source changed'
    )
    roots = []
    expect(
      await snapshot.authorizeRead({ ...request, path: 'SKILL.md' }, { signal: signal() })
    ).toBe(false)
  })
  it('reports size, invalid format and unsupported invocation diagnostics without losing the creator', async () => {
    const collection = join(home, 'state/agent-skills')
    await folder(collection, 'too-large', source('too-large', 'a'.repeat(66000)))
    await folder(collection, 'invalid', '# no frontmatter')
    await folder(
      collection,
      'manual-only',
      source('manual-only').replace('custom-field: retained', 'disable-model-invocation: true')
    )
    const snapshot = await store.snapshot()
    expect(snapshot.catalog.skills.map((item) => item.name)).toEqual(['skill-creator'])
    expect(snapshot.status.diagnostics.map((item) => item.message).join('\n')).toMatch(
      /frontmatter.*invocation.*64 KiB/s
    )
  })
  it('excludes duplicate names instead of shadowing, and leaves the bundled creator immutable', async () => {
    roots = [join(home, 'external')]
    await folder(roots[0], 'same-name')
    await folder(join(home, 'state/agent-skills'), 'same-name')
    await folder(roots[0], 'skill-creator')
    const snapshot = await store.snapshot()
    expect(snapshot.catalog.skills.map((item) => item.name)).toEqual(['skill-creator'])
    expect(
      snapshot.status.diagnostics.filter((item) => item.message.includes('Duplicate')).length
    ).toBe(3)
    const extension = createSkillsExtension({
      catalog: snapshot.catalog,
      authorizeRead: snapshot.authorizeRead,
      save: {
        authorize: () => true,
        commit: (draft, context) => store.commit(draft, context).then(() => undefined)
      }
    })
    await expect(
      extension.tools.at(-1)!.execute(
        {
          id: 'readonly',
          name: 'save_skill',
          arguments: {
            name: 'skill-creator',
            expectedRevision: snapshot.catalog.document('skill-creator')!.revision,
            content: source('skill-creator')
          }
        },
        { signal: signal() }
      )
    ).rejects.toThrow('read-only')
  })
  it('saves exact reviewed SKILL.md, retains a backup on update and activates only on a new snapshot', async () => {
    const first = await store.snapshot()
    const content = source('new-summary')
    const receipt = await store.commit(proposal('new-summary', content), { signal: signal() })
    expect(receipt).toMatchObject({
      saved: true,
      available: 'next_turn',
      destination: join(home, 'state/agent-skills/new-summary/SKILL.md')
    })
    expect(first.catalog.document('new-summary')).toBeUndefined()
    expect(await fs.readFile(receipt.destination, 'utf8')).toBe(content)
    const next = await store.snapshot()
    const before = next.catalog.document('new-summary')!
    await store.commit(
      proposal('new-summary', source('new-summary', 'Revised instructions.'), before),
      { signal: signal() }
    )
    expect(await fs.readFile(`${receipt.destination}.bak`, 'utf8')).toBe(content)
    expect(next.catalog.document('new-summary')!.content).toBe(content)
    expect((await store.snapshot()).catalog.document('new-summary')!.content).toContain(
      'Revised instructions'
    )
  })
  it('rechecks the on-disk revision after review, preserving later changes and malformed evidence', async () => {
    const root = await folder(join(home, 'state/agent-skills'), 'summary')
    const before = (await store.snapshot()).catalog.document('summary')!
    const reviewed = proposal('summary', source('summary', 'Reviewed edit.'), before)
    const later = source('summary', 'Later edit.')
    await fs.writeFile(join(root, 'SKILL.md'), later)
    await expect(store.commit(reviewed, { signal: signal() })).rejects.toThrow(
      'revision changed after review'
    )
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(later)
    await fs.writeFile(join(root, 'SKILL.md'), 'damaged but preserved')
    await expect(store.commit(reviewed, { signal: signal() })).rejects.toThrow('frontmatter')
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe('damaged but preserved')
  })
  it('honors cancellation at the atomic pre-rename boundary and permits a fresh retry', async () => {
    const controller = new AbortController()
    const real = atomic.atomicWrite
    const wrapper = vi.spyOn(atomic, 'atomicWrite').mockImplementation(async (...args) => {
      controller.abort()
      return real(...args)
    })
    await expect(
      store.commit(proposal('summary', source('summary')), { signal: controller.signal })
    ).rejects.toThrow()
    await expect(fs.stat(join(home, 'state/agent-skills/summary/SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    wrapper.mockRestore()
    expect(
      (await store.commit(proposal('summary', source('summary')), { signal: signal() })).saved
    ).toBe(true)
  })
  it('rejects cancelled or unadmitted saves, and retains an outcome cancelled only after rename', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      store.commit(proposal('summary', source('summary')), { signal: controller.signal })
    ).rejects.toThrow()
    pauseAgentPersistence()
    await expect(
      store.commit(proposal('summary', source('summary')), { signal: signal() })
    ).rejects.toThrow('paused')
    resumeAgentPersistence()
    const committed = new AbortController()
    const real = atomic.atomicWrite
    vi.spyOn(atomic, 'atomicWrite').mockImplementation(async (...args) => {
      const result = await real(...args)
      committed.abort()
      return result
    })
    const receipt = await store.commit(proposal('summary', source('summary')), {
      signal: committed.signal
    })
    expect(receipt.saved).toBe(true)
    expect(await fs.readFile(receipt.destination, 'utf8')).toBe(source('summary'))
  })
  it('bounds resource bytes, strictly decodes UTF-8, and protects known state/credential components', async () => {
    roots = [join(home, 'external')]
    const root = await folder(roots[0], 'summary')
    await fs.mkdir(join(root, 'references'))
    await fs.writeFile(join(root, 'references', 'large.md'), Buffer.alloc(65537, 65))
    await fs.writeFile(join(root, 'references', 'invalid.md'), Buffer.from([0xff]))
    const snapshot = await store.snapshot()
    const request = {
      name: 'summary',
      path: '',
      expectedRevision: snapshot.catalog.document('summary')!.revision
    }
    await expect(
      snapshot.catalog.read({ ...request, path: 'references/large.md' }, { signal: signal() })
    ).rejects.toThrow('64 KiB')
    await expect(
      snapshot.catalog.read({ ...request, path: 'references/invalid.md' }, { signal: signal() })
    ).rejects.toThrow()
    await expect(
      snapshot.catalog.read({ ...request, path: 'references/credentials.md' }, { signal: signal() })
    ).rejects.toThrow('Credential and app-state')
    roots = [join(home, 'state')]
    expect(
      (await store.snapshot()).status.diagnostics.some((item) =>
        item.message.includes('overlap the app state')
      )
    ).toBe(true)
  })
  it('refuses linked documents and preserves the current source on a precommit writer failure', async () => {
    const root = await folder(join(home, 'state/agent-skills'), 'summary')
    const before = (await store.snapshot()).catalog.document('summary')!
    vi.spyOn(atomic, 'atomicWrite').mockRejectedValueOnce(
      new Error('Fixture filesystem is read-only')
    )
    await expect(
      store.commit(proposal('summary', source('summary', 'Replacement.'), before), {
        signal: signal()
      })
    ).rejects.toThrow('read-only')
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(before.content)
    await fs.link(join(root, 'SKILL.md'), join(home, 'ordinary-copy.md'))
    expect((await store.snapshot()).catalog.document('summary')).toBeUndefined()
  })
  it('rechecks registered fixture content policy after asynchronous discovery', async () => {
    roots = [join(home, 'external')]
    await folder(
      roots[0],
      'summary',
      source('summary', 'Use fixture-only-credential as an illustrative placeholder.')
    )
    let guardEnabled = false
    const guarded = createAgentSkillStore({
      ownedRoot: () => join(home, 'state/agent-skills'),
      externalRoots: async () => roots,
      assertContent(content) {
        if (guardEnabled && content.includes('fixture-only-credential'))
          throw new Error('Registered fixture content is unavailable')
      }
    })
    const snapshot = await guarded.snapshot()
    guardEnabled = true
    await expect(
      snapshot.authorizeRead(
        {
          name: 'summary',
          path: 'SKILL.md',
          expectedRevision: snapshot.catalog.document('summary')!.revision
        },
        { signal: signal() }
      )
    ).rejects.toThrow('Registered fixture')
    expect((await guarded.snapshot()).catalog.document('summary')).toBeUndefined()
  })
  it('refuses symlinked folders and safe-path validation rejects unsupported relative syntax', async () => {
    roots = [join(home, 'external')]
    await fs.mkdir(roots[0])
    const original = await folder(join(home, 'ordinary'), 'summary')
    await fs.symlink(original, join(roots[0], 'summary'), 'dir')
    const snapshot = await store.snapshot()
    expect(snapshot.catalog.document('summary')).toBeUndefined()
    expect(snapshot.status.diagnostics[0].message).toContain('without symlinks')
    const creator = snapshot.catalog.document('skill-creator')!
    await expect(
      snapshot.catalog.read(
        {
          name: 'skill-creator',
          path: './references/style.md',
          expectedRevision: creator.revision
        },
        { signal: signal() }
      )
    ).rejects.toThrow('relative path')
  })
})
