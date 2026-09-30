import { PLAYGROUND_OPTION_NAME } from './optionName'
import type {
  BCFDInteractionAction,
  BCFDInteractionButton,
  BCFDInteractionCommand,
  BCFDSlashCommandOption
} from '../../main/types/types'
import {
  addMessage,
  assertNoHeldFeatures,
  buildFakeEmbed,
  hasPermission,
  toggleRole,
  validateState
} from './engine'
import { evaluateTemplate } from './template'
import type { TemplateContext } from './template'
import { PLAYGROUND_LIMITS } from './types'
import type { PlaygroundInteractionRequest, PlaygroundResult, PlaygroundState } from './types'

const optionTypes = new Set([3, 4, 5, 6, 7, 8, 10])

export function validateOptions(
  definitions: BCFDSlashCommandOption[],
  values: Record<string, string | number | boolean>,
  state: PlaygroundState
): Record<string, string | number | boolean> {
  if (
    !Array.isArray(definitions) ||
    definitions.length > 25 ||
    !values ||
    typeof values !== 'object' ||
    Array.isArray(values)
  )
    throw new Error('Invalid slash options')
  const result: Record<string, string | number | boolean> = Object.create(null)
  const names = new Set<string>()
  for (const definition of definitions) {
    if (
      !definition ||
      typeof definition.name !== 'string' ||
      !PLAYGROUND_OPTION_NAME.test(definition.name) ||
      names.has(definition.name.toLowerCase()) ||
      !optionTypes.has(definition.type)
    )
      throw new Error('Invalid or duplicate slash option definition')
    names.add(definition.name.toLowerCase())
    const provided = Object.hasOwn(values, definition.name)
    if (!provided) {
      if (definition.required) throw new Error(`Required option missing: ${definition.name}`)
      continue
    }
    const value = values[definition.name]
    const fail = () => {
      throw new Error(`Invalid value for option ${definition.name}`)
    }
    if (
      definition.type === 3 &&
      (typeof value !== 'string' || value.length > 6000 || value.length === 0)
    )
      fail()
    if (definition.type === 4 && (typeof value !== 'number' || !Number.isSafeInteger(value))) fail()
    if (
      definition.type === 10 &&
      (typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > Number.MAX_SAFE_INTEGER)
    )
      fail()
    if (definition.type === 5 && typeof value !== 'boolean') fail()
    if ([6, 7, 8].includes(definition.type)) {
      if (typeof value !== 'string') fail()
      if (
        definition.type === 6 &&
        !state.members.some((member) => member.id === value && !member.kicked && !member.banned)
      )
        fail()
      if (definition.type === 7 && value !== state.channelId) fail()
      if (definition.type === 8 && !state.roles.some((role) => role.id === value)) fail()
    }
    if (
      definition.choices !== undefined &&
      (!Array.isArray(definition.choices) || definition.choices.length > 0)
    ) {
      if (
        ![3, 4, 10].includes(definition.type) ||
        !Array.isArray(definition.choices) ||
        definition.choices.length > 25 ||
        !definition.choices.some((choice) => choice.value === value)
      )
        fail()
    }
    result[definition.name] = value
  }
  for (const name of Object.keys(values))
    if (!definitions.some((definition) => definition.name === name))
      throw new Error(`Unknown option: ${name}`)
  return result
}

function findButton(
  interactions: BCFDInteractionCommand[],
  customId: string
): { command: BCFDInteractionCommand; button: BCFDInteractionButton } | undefined {
  let visited = 0
  const walk = (
    action: BCFDInteractionAction,
    depth: number
  ): BCFDInteractionButton | undefined => {
    if (++visited > 1000 || depth > 16) throw new Error('Button tree exceeds the playground limit')
    if (!Array.isArray(action.buttons)) throw new Error('Invalid action buttons')
    for (const button of action.buttons) {
      if (button.customId === customId) return button
      const nested = walk(button.action, depth + 1)
      if (nested) return nested
    }
    return undefined
  }
  // Production resolves custom IDs across saved interactions, first match wins.
  for (const command of interactions) {
    const button = walk(command.rootAction, 0)
    if (button) return { command, button }
  }
  return undefined
}

function renderButtons(
  buttons: BCFDInteractionButton[],
  ctx: TemplateContext
): BCFDInteractionButton[] {
  if (!Array.isArray(buttons)) throw new Error('Invalid action buttons')
  return buttons.slice(0, 5).map((button) => {
    if (
      !button ||
      typeof button.customId !== 'string' ||
      button.customId.length > 100 ||
      ![1, 2, 3, 4, 5].includes(button.style)
    )
      throw new Error('Invalid button')
    return { ...structuredClone(button), label: evaluateTemplate(button.label || 'Button', ctx) }
  })
}

function executeAction(
  state: PlaygroundState,
  command: BCFDInteractionCommand,
  action: BCFDInteractionAction,
  senderId: string,
  options: Record<string, string | number | boolean> | undefined,
  isButton: boolean,
  trace: string[]
): void {
  const sender = state.members.find((member) => member.id === senderId)!
  // Production interaction contexts have no messageEvent/mentionedMember.
  const ctx: TemplateContext = { state, sender, content: '', trigger: '', options }
  const render = (text: string) => evaluateTemplate(text, ctx)
  if (!isButton) {
    if (action.deleteX) {
      if (!hasPermission(sender, 'manageMessages'))
        throw new Error('Manage Messages permission required')
      const count = Math.min(Math.max(Number(action.deleteNum) || 0, 1), 100)
      state.messages
        .filter((message) => message.kind !== 'dm' && !message.deleted && !message.ephemeral)
        .slice(-count)
        .forEach((message) => (message.deleted = true))
      trace.push(`Deleted up to ${count} fake channel messages`)
    }
    if (action.isKick || action.isBan || action.isVoiceMute) {
      const definition = command.options.find(
        (option) => option.name === action.targetUserOptionName
      )
      const targetId = options?.[action.targetUserOptionName]
      const target = state.members.find(
        (member) => member.id === targetId && !member.kicked && !member.banned
      )
      if (!definition || definition.type !== 6 || !target)
        throw new Error('A configured user option is required for targeted moderation')
      for (const [enabled, permission, key] of [
        [action.isKick, 'kick', 'kicked'],
        [action.isBan, 'ban', 'banned'],
        [action.isVoiceMute, 'mute', 'muted']
      ] as const) {
        if (!enabled) continue
        if (!hasPermission(sender, permission)) throw new Error(`${permission} permission required`)
        target[key] = true
        trace.push(`${key}: ${target.name}`)
      }
    }
  } else if (action.deleteX || action.isKick || action.isBan || action.isVoiceMute) {
    trace.push('Button moderation/deletion flags are ignored by the production button handler')
  }
  let response =
    action.sendChannelMessage && action.channelMessage ? render(action.channelMessage) : ''
  const embed = action.sendChannelEmbed ? buildFakeEmbed(action.channelEmbed, ctx) : undefined
  if (!response && !embed) response = '\u200B'
  const buttons = renderButtons(action.buttons, ctx)
  addMessage(state, {
    kind: 'bot',
    author: 'Playground Bot',
    content: response,
    embed,
    buttons,
    ephemeral: !!action.ephemeral,
    recipient: action.ephemeral ? sender.id : undefined,
    deferred: !!action.deferReply
  })
  trace.push(
    action.deferReply ? 'Deferred reply then edit (timing not modeled)' : 'Interaction reply'
  )
  if (action.sendPrivateMessage && action.privateMessage)
    addMessage(state, {
      kind: 'dm',
      author: 'Playground Bot',
      recipient: sender.id,
      content: render(action.privateMessage)
    })
  if (action.sendPrivateEmbed)
    addMessage(state, {
      kind: 'dm',
      author: 'Playground Bot',
      recipient: sender.id,
      content: '',
      embed: buildFakeEmbed(action.privateEmbed, ctx)
    })
  if (action.isRoleAssigner && action.roleToAssign) {
    toggleRole(state, sender, render(action.roleToAssign))
    trace.push(`Toggled role on invoking member ${sender.name}`)
  }
}

export function runInteraction(request: PlaygroundInteractionRequest): PlaygroundResult {
  validateState(request.state)
  if (
    !Array.isArray(request.interactions) ||
    request.interactions.length > PLAYGROUND_LIMITS.commands
  )
    throw new Error('Saved-interaction limit exceeded')
  const sender = request.state.members.find(
    (member) => member.id === request.senderId && !member.kicked && !member.banned
  )
  if (!sender) throw new Error('Choose an available fake sender')
  const original = structuredClone(request.state),
    draft = structuredClone(request.state)
  const trace: string[] = [],
    errors: string[] = []
  try {
    let command: BCFDInteractionCommand, action: BCFDInteractionAction
    let options: Record<string, string | number | boolean> | undefined
    if (request.kind === 'slash') {
      const selected = request.interactions.find(
        (interaction) => interaction.id === request.commandId
      )
      if (!selected) throw new Error('Saved slash command not found')
      command = selected
      action = command.rootAction
      options = validateOptions(command.options, request.options ?? {}, draft)
      trace.push(
        `Invoked saved /${command.commandName}; publication status is not required for offline simulation`
      )
    } else {
      const message = original.messages.find(
        (item) => item.id === request.messageId && !item.deleted
      )
      if (!message || (message.ephemeral && message.recipient !== sender.id))
        throw new Error('Button message is unavailable to this fake sender')
      const visible = message.buttons?.find((button) => button.customId === request.customId)
      if (!visible || visible.disabled || visible.style === 5)
        throw new Error('Button is disabled, inert, or unavailable')
      const found = findButton(request.interactions, request.customId ?? '')
      if (!found) throw new Error('This button is no longer active')
      command = found.command
      action = found.button.action
      // No slash option snapshot: contextForInteractionEvent deliberately omits options on buttons.
      options = undefined
      trace.push(
        `Clicked ${request.customId}; slash options are unavailable on production button events`
      )
    }
    assertNoHeldFeatures(command)
    executeAction(
      draft,
      command,
      action,
      request.senderId,
      options,
      request.kind === 'button',
      trace
    )
    return { state: draft, trace, errors }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Interaction execution failed')
    return { state: original, trace: ['Failed closed; no interaction effects applied'], errors }
  }
}
