import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSkillsExtension, parseSkillDocument } from '@ayayaq/vivi/extensions/skills'
import { createAgentSkillStore } from './agentSkillStore'
import { drainAgentPersistence, resumeAgentPersistence } from './agentPersistenceLifecycle'

const source = (name: string, body = 'Return three factual bullets.') =>
  `---\nname: ${name}\ndescription: >-\n  Summarize supplied text.\n  Use for a short summary.\nlicense: Apache-2.0\ncompatibility: Requires supplied text only\nmetadata:\n  author: Example\nallowed-tools: read_skill\ncustom-field: retained\n---\n\n${body}\n`
const signal = () => new AbortController().signal

describe('desktop instruction skill store', () => {
  let home: string
  let roots: string[]
  let store: ReturnType<typeof createAgentSkillStore>
  beforeEach(async () => {
    home = await fs.mkdtemp(join(tmpdir(), 'desktop-skills-'))
    roots = []
    await fs.mkdir(join(home, 'state'))
    resumeAgentPersistence()
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
  const draft = (
    name = 'summary',
    content = source(name),
    expectedRevision: string | null = null
  ) => ({
    name,
    content,
    expectedRevision
  })
  it('creates and replaces exact source, preserving references and rejecting stale revisions', async () => {
    const original = await store.prepareSave(draft())
    const before = await store.snapshot()
    await store.commitSave(original.save)
    expect(before.catalog.document('summary')).toBeUndefined()
    const current = await store.snapshot()
    const document = current.catalog.document('summary')!
    expect(document.content).toBe(source('summary'))
    expect(current.status.skills.find((s) => s.name === 'summary')!.readOnly).toBe(false)
    const root = join(home, 'state/agent-skills/summary')
    await fs.mkdir(join(root, 'references'))
    await fs.writeFile(join(root, 'references/style.md'), 'Keep this reference.')
    const updated = source('summary', 'Return one sentence.')
    const replacement = await store.prepareSave(draft('summary', updated, document.revision))
    await store.commitSave(replacement.save)
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(updated)
    expect(await fs.readFile(join(root, 'references/style.md'), 'utf8')).toBe(
      'Keep this reference.'
    )
    await expect(store.commitSave(replacement.save)).rejects.toThrow('stale')
    await expect(store.prepareSave(draft())).rejects.toThrow('stale')
  })
  it.each(['skill-creator', '../escape', 'con', 'credentials'])(
    'rejects protected or unsafe names (%s)',
    async (name) => {
      await expect(store.prepareSave(draft(name))).rejects.toThrow()
      await expect(fs.stat(join(home, 'state/agent-skills'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  )
  it('refuses imported, malformed and unsupported skills without writing', async () => {
    roots = [join(home, 'external')]
    const root = await folder(roots[0], 'summary')
    await expect(
      store.prepareSave(
        draft('summary', source('summary'), parseSkillDocument(source('summary')).revision)
      )
    ).rejects.toThrow('read-only')
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(source('summary'))
    await expect(store.prepareSave(draft('other', '# missing frontmatter'))).rejects.toThrow(
      'frontmatter'
    )
    await expect(
      store.prepareSave(
        draft('other', source('other').replace('custom-field: retained', 'context: fork'))
      )
    ).rejects.toThrow('invocation')
    await expect(
      store.prepareSave(draft('other', source('other', 'x'.repeat(66000))))
    ).rejects.toThrow('byte limit')
  })
  it('serializes competing creates and never overwrites a newer skill', async () => {
    const first = await store.prepareSave(draft())
    const second = await store.prepareSave(draft('summary', source('summary', 'Another draft.')))
    const results = await Promise.allSettled([
      store.commitSave(first.save),
      store.commitSave(second.save)
    ])
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected'])
    expect((await store.snapshot()).catalog.document('summary')!.content).toBe(source('summary'))
  })
  it('does not overwrite a revision changed after approval, including during atomic staging', async () => {
    const root = await folder(join(home, 'state/agent-skills'), 'summary')
    const prepared = await store.prepareSave(
      draft(
        'summary',
        source('summary', 'New draft.'),
        parseSkillDocument(source('summary')).revision
      )
    )
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp'))
        await fs.writeFile(join(root, 'SKILL.md'), source('summary', 'Changed outside app.'))
      return open(...args)
    })
    await expect(store.commitSave(prepared.save)).rejects.toThrow('revision changed')
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(
      source('summary', 'Changed outside app.')
    )
  })
  it('rejects symlink destinations and replaced directory identities', async () => {
    const prepared = await store.prepareSave(draft())
    const external = join(home, 'outside')
    await fs.mkdir(external)
    await fs.symlink(
      external,
      join(home, 'state/agent-skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await expect(store.commitSave(prepared.save)).rejects.toThrow('without symlinks')
    expect(await fs.readdir(external)).toEqual([])
  })
  it('checks cancellation again at the commit gate, allowing a later retry', async () => {
    const prepared = await store.prepareSave(draft())
    const controller = new AbortController()
    const open = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp')) controller.abort(new Error('Cancelled before rename'))
      return open(...args)
    })
    await expect(store.commitSave(prepared.save, { signal: controller.signal })).rejects.toThrow(
      'Cancelled'
    )
    spy.mockRestore()
    await store.commitSave((await store.prepareSave(draft())).save)
    expect((await store.snapshot()).catalog.document('summary')).toBeDefined()
  })
  it('rechecks the credential policy after staging and leaves the existing skill unchanged', async () => {
    let blocked = false
    const guarded = createAgentSkillStore({
      ownedRoot: () => join(home, 'state/agent-skills'),
      externalRoots: async () => [],
      assertContent: () => {
        if (blocked) throw new Error('Configured credential in skill')
      }
    })
    const root = await folder(join(home, 'state/agent-skills'), 'summary')
    const prepared = await guarded.prepareSave(
      draft(
        'summary',
        source('summary', 'Replacement.'),
        parseSkillDocument(source('summary')).revision
      )
    )
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('.tmp')) blocked = true
      return open(...args)
    })
    await expect(guarded.commitSave(prepared.save)).rejects.toThrow('Configured credential')
    expect(await fs.readFile(join(root, 'SKILL.md'), 'utf8')).toBe(source('summary'))
  })
  it('preserves committed content if cancellation arrives after the primary rename', async () => {
    const prepared = await store.prepareSave(draft())
    const controller = new AbortController()
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to)
      if (String(to).endsWith('SKILL.md')) controller.abort()
    })
    await store.commitSave(prepared.save, { signal: controller.signal })
    expect((await store.snapshot()).catalog.document('summary')!.content).toBe(source('summary'))
  })
  it('always includes the portable read-only creator, without scanning cwd or creating folders', async () => {
    const snapshot = await store.snapshot()
    expect(snapshot.catalog.skills.map((skill) => skill.name)).toEqual(['skill-creator'])
    expect(snapshot.catalog.skills.every((skill) => skill.readOnly)).toBe(true)
    expect(snapshot.status.saveSupport.available).toBe(true)
    expect(Object.keys(store)).toEqual(['snapshot', 'prepareSave', 'commitSave', 'reviewRevision'])
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
      authorizeRead: snapshot.authorizeRead
    })
    expect(extension.tools.map((tool) => tool.definition.name)).toEqual([
      'list_skills',
      'read_skill'
    ])
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
    await fs.symlink(
      original,
      join(roots[0], 'summary'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
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
  it.skipIf(process.platform !== 'win32')(
    'accepts ordinary Windows case spelling aliases for read-only folders',
    async () => {
      const collection = join(home, 'MixedCaseSkills')
      await folder(collection, 'summary')
      roots = [collection.toUpperCase()]
      const snapshot = await store.snapshot()
      expect(snapshot.catalog.document('summary')!.content).toBe(source('summary'))
      expect(snapshot.catalog.skills.find((skill) => skill.name === 'summary')!.readOnly).toBe(true)
    }
  )
})
