import { createToolRegistry, type ToolRegistry, type ToolExtension } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { createSkillsExtension, type SkillsExtensionHost } from '@ayayaq/vivi/extensions/skills'
import { MCP_RESOURCE_TOOL_NAMES } from '@ayayaq/vivi/extensions/mcp'

/** Explicit trusted imports only; this snapshot is private to one desktop agent run. */
export function createAgentExtensionRegistry(
  reservedNames: readonly string[],
  skills?: Pick<SkillsExtensionHost, 'catalog' | 'authorizeRead'>,
  mcp?: ToolExtension
): ToolRegistry {
  const mcpNames = new Set(mcp?.tools.map((tool) => tool.definition.name) ?? [])
  return createToolRegistry(
    [
      calculatorExtension,
      ...(skills
        ? [createSkillsExtension({ catalog: skills.catalog, authorizeRead: skills.authorizeRead })]
        : []),
      ...(mcp ? [mcp] : [])
    ],
    {
      reservedNames: [
        ...new Set([
          ...reservedNames,
          'save_skill',
          ...MCP_RESOURCE_TOOL_NAMES.filter((name) => !mcpNames.has(name))
        ])
      ]
    }
  )
}
