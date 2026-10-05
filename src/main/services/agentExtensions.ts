import { createToolRegistry, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'

/** Explicit trusted imports only; this snapshot is private to one desktop agent run. */
export function createAgentExtensionRegistry(reservedNames: readonly string[]): ToolRegistry {
  return createToolRegistry([calculatorExtension], { reservedNames })
}
