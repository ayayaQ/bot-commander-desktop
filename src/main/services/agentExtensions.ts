import { createToolRegistry, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { createSkillsExtension, type SkillsExtensionHost } from '@ayayaq/vivi/extensions/skills'

/** Explicit trusted imports only; this snapshot is private to one desktop agent run. */
export function createAgentExtensionRegistry(
  reservedNames: readonly string[],
  skills?: Pick<SkillsExtensionHost, 'catalog' | 'authorizeRead'>
): ToolRegistry {
  return createToolRegistry(
    [
      calculatorExtension,
      ...(skills
        ? [createSkillsExtension({ catalog: skills.catalog, authorizeRead: skills.authorizeRead })]
        : [])
    ],
    { reservedNames: [...new Set([...reservedNames, 'save_skill'])] }
  )
}
