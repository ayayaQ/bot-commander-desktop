import { app } from 'electron'
import { isAbsolute, join, resolve } from 'node:path'
import fs from 'node:fs/promises'
import { createAgentPersistence } from './agentPersistence'
import { withAgentPersistenceOperation } from './agentPersistenceLifecycle'
import { getSettings } from './settingsService'
import { createAgentSkillStore, skillPathsOverlap } from './agentSkillStore'

interface SkillFolders {
  version: 1
  roots: string[]
}
const folders = createAgentPersistence<SkillFolders>({
  path: () => join(app.getPath('userData'), 'agent-skill-folders.json'),
  label: 'Agent skill folders',
  empty: () => ({ version: 1, roots: [] }),
  decode(raw) {
    const parsed = JSON.parse(raw) as SkillFolders
    if (
      parsed?.version !== 1 ||
      !Array.isArray(parsed.roots) ||
      parsed.roots.length > 8 ||
      parsed.roots.some(
        (root) => typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root
      ) ||
      new Set(parsed.roots).size !== parsed.roots.length
    )
      throw new Error('Invalid agent skill folders')
    return parsed
  }
})
let rootList: string[] | undefined
let loading: Promise<string[]> | undefined
async function externalRoots(): Promise<string[]> {
  loading ??= folders.load().then(({ data }) => (rootList = [...data.roots]))
  await loading
  return [...rootList!]
}
export const agentSkillStore = createAgentSkillStore({
  ownedRoot: () => join(app.getPath('userData'), 'agent-skills'),
  externalRoots,
  assertContent(content) {
    const settings = getSettings()
    if (
      [settings.openaiApiKey, settings.openrouterApiKey].some((key) => key && content.includes(key))
    )
      throw new Error(
        'Skill text contains a currently configured provider credential; remove it before discovery or saving'
      )
  }
})
export const loadAgentSkills = async () => (await agentSkillStore.snapshot()).status

let configurationChain: Promise<unknown> = Promise.resolve()
export function configureAgentSkillFolder(path: string, add: boolean) {
  return withAgentPersistenceOperation(() => {
    const pending = configurationChain
      .catch(() => undefined)
      .then(async () => {
        const current = await externalRoots()
        folders.assertWritable()
        if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path)
          throw new Error('Choose an absolute skill folder')
        if (add) {
          if (skillPathsOverlap(path, app.getPath('userData')))
            throw new Error('Read-only skill folders cannot overlap the app state folder')
          const stat = await fs.lstat(path)
          if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(path)) !== path)
            throw new Error('Choose an ordinary skill folder without symlinks')
        }
        const next = add
          ? [...new Set([...current, path])]
          : current.filter((root) => root !== path)
        if (next.length > 8)
          throw new Error('At most eight read-only skill folders can be configured')
        if (next.includes(join(app.getPath('userData'), 'agent-skills')))
          throw new Error('The owned skill store is already available')
        await folders.save({ version: 1, roots: next })
        rootList = next
        return loadAgentSkills()
      })
    configurationChain = pending
    return pending
  })
}
