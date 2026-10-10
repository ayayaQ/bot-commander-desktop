import {
  createExtensionScope,
  type ExtensionScope,
  type ToolExtension
} from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { createSkillsExtension, type SkillsExtensionHost } from '@ayayaq/vivi/extensions/skills'
import { MCP_RESOURCE_TOOL_NAMES } from '@ayayaq/vivi/extensions/mcp'

/** Prepare an unpublished candidate; the run owns its disposal after successful setup. */
export async function createAgentExtensionScope(
  reservedNames: readonly string[],
  skills?: Pick<SkillsExtensionHost, 'catalog' | 'authorizeRead'>,
  mcp?: ToolExtension
): Promise<ExtensionScope> {
  const mcpNames = new Set(mcp?.tools.map((tool) => tool.definition.name) ?? [])
  const scope = createExtensionScope({
    reservedNames: [
      ...new Set([
        ...reservedNames,
        'save_skill',
        ...MCP_RESOURCE_TOOL_NAMES.filter((name) => !mcpNames.has(name))
      ])
    ]
  })
  try {
    scope.register(calculatorExtension)
    if (skills)
      scope.register(
        createSkillsExtension({ catalog: skills.catalog, authorizeRead: skills.authorizeRead })
      )
    if (mcp) scope.register(mcp)
    return scope
  } catch (error) {
    try {
      await scope.dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Agent extension setup and cleanup failed')
    }
    throw error
  }
}
