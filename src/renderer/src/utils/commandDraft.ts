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

/** Prepare a detached submission so failed saves do not erase retained editor payloads. */
export function prepareCommandDraftForSave(
  command: BCFDCommand,
  actions: ReadonlyArray<{ type: string }>
): BCFDCommand {
  const prepared = cloneCommandDraft(command)
  if ([2, 3, 4].includes(prepared.type)) {
    prepared.requiredRole = ''
    prepared.isAdmin = false
    prepared.phrase = false
    prepared.isNSFW = false
    prepared.deleteAfter = false
    prepared.deleteNum = 0
    prepared.deleteIfStrings = ''
    prepared.reaction = ''
    prepared.isKick = false
    prepared.isBan = false
    prepared.isVoiceMute = false
    prepared.command = ''
  }
  const active = new Set(actions.map((action) => action.type))
  const emptyEmbed = () => ({
    title: '',
    description: '',
    hexColor: '',
    imageURL: '',
    thumbnailURL: '',
    footer: ''
  })
  if (!active.has('sendMessage')) prepared.channelMessage = ''
  if (!active.has('sendPrivateMessage')) prepared.privateMessage = ''
  if (!active.has('sendChannelEmbed')) prepared.channelEmbed = emptyEmbed()
  if (!active.has('sendPrivateEmbed')) prepared.privateEmbed = emptyEmbed()
  if (!active.has('specificChannel')) prepared.specificChannel = ''
  if (!active.has('reaction')) prepared.reaction = ''
  if (!active.has('deleteIf')) prepared.deleteIfStrings = ''
  if (!active.has('deleteX')) prepared.deleteNum = 0
  if (!active.has('roleAssigner')) prepared.roleToAssign = ''
  if (!active.has('requiredRole')) prepared.requiredRole = ''
  return prepared
}
