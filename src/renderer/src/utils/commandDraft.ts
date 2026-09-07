import type { BCFDCommand } from '../types/types'

export function cloneCommandDraft(command: BCFDCommand): BCFDCommand {
  // Commands are JSON data. This also detaches nested Svelte proxies, which
  // structuredClone cannot clone directly and a spread would retain.
  return JSON.parse(JSON.stringify(command))
}

export function commandDraftSignature(
  command: BCFDCommand,
  actions: ReadonlyArray<{ type: string }>
): string {
  // Action membership can change without changing its retained payload in the editor.
  return JSON.stringify([command, actions.map((action) => action.type).sort()])
}
