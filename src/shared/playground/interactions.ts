import { withScheduler } from './scheduling'
import {
  consumeCascadeWork,
  currentGatewayEvent,
  inheritCascade,
  runGatewayCascade
} from './cascades'
import { prepareWorldEvent, commitWorld, assertManageable } from './world'
import { deliverInteractionDM } from '../runtime/errors'
import { incompleteReasons, recordFailure } from './failures'
import { scheduledOperation, requireBotPermission } from './runtimeContext'
import { runInteractionActions } from '../runtime/actions'
import { PLAYGROUND_OPTION_NAME } from './optionName'
import type {
  BCFDInteractionAction,
  BCFDInteractionButton,
  BCFDInteractionCommand,
  BCFDSlashCommandOption
} from '../../main/types/types'
import {
  sendMessage,
  buildFakeEmbed,
  hasPermission,
  toggleRole,
  validateState,
  runMessageEvent
} from './engine'
import { evaluateTemplate } from './template'
import type { TemplateContext } from './template'
import type { ScriptSandboxFactory } from './script'
import { executionContext } from './executionContext'
import { recordCooldown, remainingCooldown } from './sessionState'
import { PLAYGROUND_LIMITS, PlaygroundExecutionError } from './types'
import type {
  PlaygroundInteractionRequest,
  PlaygroundResult,
  PlaygroundResourceResult,
  PlaygroundState
} from './types'

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
      if (
        definition.type === 7 &&
        value !== state.channelId &&
        !state.channels?.some(
          (channel) => channel.id === value && !channel.deleted && channel.guildId === state.guildId
        )
      )
        fail()
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

async function renderButtons(
  buttons: BCFDInteractionButton[],
  ctx: TemplateContext
): Promise<BCFDInteractionButton[]> {
  if (!Array.isArray(buttons)) throw new Error('Invalid action buttons')
  const output: BCFDInteractionButton[] = []
  for (const button of buttons.slice(0, 5)) {
    if (
      !button ||
      typeof button.customId !== 'string' ||
      button.customId.length > 100 ||
      ![1, 2, 3, 4, 5].includes(button.style)
    )
      throw new Error('Invalid button')
    output.push({
      ...structuredClone(button),
      label: await evaluateTemplate(button.label || 'Button', ctx)
    })
  }
  return output
}

async function executeAction(
  state: PlaygroundState,
  command: BCFDInteractionCommand,
  action: BCFDInteractionAction,
  senderId: string,
  options: Record<string, string | number | boolean> | undefined,
  isButton: boolean,
  trace: string[],
  ctx: TemplateContext,
  warnings: string[]
): Promise<void> {
  const sender = state.members.find((member) => member.id === senderId)!
  // Production interaction contexts have no messageEvent/mentionedMember.
  const render = async (text: string) => await evaluateTemplate(text, ctx)
  if (action.deferReply)
    await scheduledOperation(state, 'interaction.defer', [!!action.ephemeral], () => {})
  if (!isButton) {
    if (action.deleteX) {
      if (!hasPermission(sender, 'manageMessages', state))
        throw new PlaygroundExecutionError('Manage Messages permission required', 'blocked')
      const count = Math.min(Math.max(Number(action.deleteNum) || 0, 1), 100)
      await scheduledOperation(state, 'message.purge', [count], () => {
        if (state.world) requireBotPermission(state, 'ManageMessages', state.channelId)
        state.messages
          .filter(
            (message) =>
              message.kind !== 'dm' &&
              !message.deleted &&
              !message.ephemeral &&
              (!state.world || message.channelId === state.channelId)
          )
          .slice(-count)
          .forEach((message) => (message.deleted = true))
      })
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
        if (!hasPermission(sender, permission, state, target.voiceChannelId))
          throw new PlaygroundExecutionError(`${permission} permission required`, 'blocked')
        await scheduledOperation(state, `member.${key}`, [target.id], () => {
          requireBotPermission(
            state,
            { kicked: 'KickMembers', banned: 'BanMembers', muted: 'MuteMembers' }[key],
            key === 'muted' ? (target.voiceChannelId ?? state.channelId) : undefined
          )
          assertManageable(state, target)
          target[key] = true
        })
        trace.push(`${key}: ${target.name}`)
      }
    }
  } else if (action.deleteX || action.isKick || action.isBan || action.isVoiceMute) {
    trace.push('Button moderation/deletion flags are ignored by the production button handler')
  }
  await runInteractionActions({
    response: async () => {
      let response =
        action.sendChannelMessage && action.channelMessage
          ? await render(action.channelMessage)
          : ''
      const embed = action.sendChannelEmbed
        ? await buildFakeEmbed(action.channelEmbed, ctx)
        : undefined
      if (!response && !embed) response = '\u200B'
      const buttons = await renderButtons(action.buttons, ctx)
      await sendMessage(state, {
        kind: 'bot',
        author: 'Playground Bot',
        content: response,
        embed,
        buttons,
        ephemeral: !!action.ephemeral,
        recipient: action.ephemeral ? sender.id : undefined,
        deferred: !!action.deferReply
      })
      trace.push(action.deferReply ? 'Deferred reply then edit' : 'Interaction reply')
    },
    dm: async () => {
      if (action.sendPrivateMessage && action.privateMessage) {
        const content = await render(action.privateMessage)
        await deliverInteractionDM(
          () =>
            sendMessage(state, {
              kind: 'dm',
              author: 'Playground Bot',
              recipient: sender.id,
              content
            }),
          (error) => warnings.push(`Could not send DM: ${String(error)}`)
        )
      }
    },
    dmEmbed: async () => {
      if (action.sendPrivateEmbed) {
        const embed = await buildFakeEmbed(action.privateEmbed, ctx)
        await deliverInteractionDM(
          () =>
            sendMessage(state, {
              kind: 'dm',
              author: 'Playground Bot',
              recipient: sender.id,
              content: '',
              embed
            }),
          (error) => warnings.push(`Could not send DM embed: ${String(error)}`)
        )
      }
    },
    role: async () => {
      if (action.isRoleAssigner && action.roleToAssign) {
        await toggleRole(state, sender, await render(action.roleToAssign))
        trace.push(`Toggled role on invoking member ${sender.name}`)
      }
    }
  })
}

export async function runInteraction(
  request: PlaygroundInteractionRequest,
  factory?: ScriptSandboxFactory
): Promise<PlaygroundResult> {
  return runGatewayCascade(
    request,
    (input) => runInteractionEvent(input as PlaygroundInteractionRequest, factory),
    (input) => runMessageEvent(input, factory)
  )
}

async function runInteractionEvent(
  request: PlaygroundInteractionRequest,
  factory?: ScriptSandboxFactory
): Promise<PlaygroundResult> {
  validateState(request.state)
  const previous = request.state
  request = {
    ...request,
    state: prepareWorldEvent(request.state, request.context, request.kind, request.senderId)
  }
  inheritCascade(previous, request.state)
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
  inheritCascade(request.state, draft)
  const trace: string[] = [],
    errors: string[] = [],
    diagnostics: string[] = [],
    warnings: string[] = []
  const resources: PlaygroundResourceResult[] = request.interactions.map((command) => ({
    eventId: currentGatewayEvent(draft)?.id,
    resourceId: command.id,
    kind: 'interaction',
    matched: false,
    executed: false,
    outcome: 'unmatched',
    reason: 'Interaction was not targeted'
  }))
  let resource: PlaygroundResourceResult | undefined
  let scope: ReturnType<typeof executionContext> | undefined
  try {
    consumeCascadeWork(draft)
    return await withScheduler(draft, async () => {
      let command: BCFDInteractionCommand, action: BCFDInteractionAction
      let options: Record<string, string | number | boolean> | undefined
      if (request.kind === 'slash') {
        const selected = request.interactions.find(
          (interaction) => interaction.id === request.commandId
        )
        if (!selected)
          throw new PlaygroundExecutionError('Saved slash command not found', 'unmatched')
        command = selected
        resource = resources[request.interactions.indexOf(command)]
        resource.matched = true
        action = command.rootAction
        options = validateOptions(command.options, request.options ?? {}, draft)
        trace.push(
          `Invoked saved /${command.commandName}; publication status is not required for offline simulation`
        )
      } else {
        const message = original.messages.find(
          (item) =>
            item.id === request.messageId &&
            !item.deleted &&
            (!original.world || item.channelId === original.channelId)
        )
        if (
          !message ||
          ((message.kind === 'dm' || message.ephemeral) && message.recipient !== sender.id)
        )
          throw new PlaygroundExecutionError(
            'Button message is unavailable to this fake sender',
            'blocked'
          )
        const visible = message.buttons?.find((button) => button.customId === request.customId)
        if (!visible || visible.disabled || visible.style === 5)
          throw new PlaygroundExecutionError('Button is disabled, inert, or unavailable', 'blocked')
        const found = findButton(request.interactions, request.customId ?? '')
        if (!found)
          throw new PlaygroundExecutionError('This button is no longer active', 'unmatched')
        command = found.command
        resource = resources[request.interactions.indexOf(command)]
        resource.matched = true
        action = found.button.action
        // No slash option snapshot: contextForInteractionEvent deliberately omits options on buttons.
        options = undefined
        trace.push(
          `Clicked ${request.customId}; slash options are unavailable on production button events`
        )
      }
      scope = executionContext(
        {
          state: draft,
          sender: draft.members.find((member) => member.id === request.senderId)!,
          content: '',
          wrapEvalInIIFE: request.wrapEvalInIIFE,
          trigger: '',
          options,
          command,
          trace,
          diagnostics
        },
        factory
      )
      if (request.kind === 'slash' && (command.cooldown ?? 0) > 0 && command.cooldownType) {
        const remaining = remainingCooldown(draft, command, request.senderId)
        if (remaining > 0) {
          await sendMessage(draft, {
            kind: 'bot',
            author: 'Playground Bot',
            ephemeral: true,
            recipient: sender.id,
            content: command.cooldownMessage
              ? await evaluateTemplate(command.cooldownMessage, scope.context)
              : `This command is on cooldown. Try again in ${remaining}s.`
          })
          trace.push(
            `Blocked: ${command.cooldownType.toLowerCase()} cooldown; ${remaining}s remaining`
          )
          scope.commit()
          resource.outcome = 'blocked'
          resource.reason = `Cooldown; ${remaining}s remaining`
          return {
            state: commitWorld(draft),
            trace,
            errors,
            diagnostics,
            warnings,
            incomplete: incompleteReasons(draft),
            resources
          }
        }
      }
      await executeAction(
        draft,
        command,
        action,
        request.senderId,
        options,
        request.kind === 'button',
        trace,
        scope.context,
        warnings
      )
      if (request.kind === 'slash') recordCooldown(draft, command, request.senderId)
      scope.commit()
      resource.outcome = 'executed'
      resource.executed = true
      resource.reason = undefined
      return {
        state: commitWorld(draft),
        trace,
        errors,
        diagnostics,
        warnings,
        incomplete: incompleteReasons(draft),
        resources
      }
    })
  } catch (error) {
    recordFailure(draft, error)
    // A denied button can still target an existing candidate; coverage is derived
    // from structured resource resolution, never user-facing trace strings.
    if (!resource && request.kind === 'button') {
      try {
        const found = findButton(request.interactions, request.customId ?? '')
        if (found) {
          resource = resources[request.interactions.indexOf(found.command)]
          resource.matched = true
        }
      } catch {
        // Preserve the original handler error if its definition cannot be resolved.
      }
    }
    if (resource) {
      resource.outcome = error instanceof PlaygroundExecutionError ? error.outcome : 'error'
      resource.reason = error instanceof Error ? error.message : 'Interaction execution failed'
      resource.error = resource.reason
    }
    errors.push(error instanceof Error ? error.message : 'Interaction execution failed')
    return {
      state: commitWorld(draft),
      trace: [...trace, 'Failed; earlier interaction effects retained'],
      errors,
      diagnostics,
      warnings,
      incomplete: incompleteReasons(draft),
      resources
    }
  } finally {
    if (resource && incompleteReasons(draft).length) {
      resource.outcome = 'not_run'
      resource.reason = incompleteReasons(draft).join('; ')
    }
    scope?.dispose()
  }
}
