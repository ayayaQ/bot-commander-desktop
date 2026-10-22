import { runTraditionalActions } from '../runtime/actions'
import { matchesCommand, type CommandEvent } from '../runtime/dispatch'
import { fakeChannels, operation, requireBotPermission } from './runtimeContext'
import type { BCFDCommand, BCFDEmbedMessageTemplate } from '../../main/types/types'
import { commandCapabilities } from '../commandCapabilities'
import { evaluateTemplate } from './template'
import { hasFakeRole } from './roles'
import type { TemplateContext } from './template'
import type { ScriptSandboxFactory } from './script'
import { executionContext } from './executionContext'
import { recordCooldown, remainingCooldown, validateSessionState } from './sessionState'
import { PLAYGROUND_LIMITS, PlaygroundExecutionError } from './types'
import type {
  FakeMember,
  FakePermission,
  PlaygroundMessage,
  PlaygroundMessageRequest,
  PlaygroundResult,
  PlaygroundResourceResult,
  PlaygroundState
} from './types'

export function validateState(state: PlaygroundState): void {
  if (
    !state ||
    !/^\d{1,20}$/.test(state.guildId) ||
    !/^\d{1,20}$/.test(state.channelId) ||
    typeof state.guildName !== 'string' ||
    state.guildName.length > 100 ||
    typeof state.channelName !== 'string' ||
    state.channelName.length > 100 ||
    typeof state.nsfw !== 'boolean'
  )
    throw new Error('Invalid fake channel/server context')
  if (
    !state ||
    !Array.isArray(state.members) ||
    state.members.length > PLAYGROUND_LIMITS.members ||
    !Array.isArray(state.roles) ||
    state.roles.length > PLAYGROUND_LIMITS.roles ||
    !Array.isArray(state.messages) ||
    state.messages.length > PLAYGROUND_LIMITS.messages ||
    !Number.isSafeInteger(state.nextId) ||
    state.nextId < 1
  )
    throw new Error('Invalid or oversized playground state')
  validateSessionState(state)
}

export function addMessage(
  state: PlaygroundState,
  message: Omit<PlaygroundMessage, 'id'>
): PlaygroundMessage {
  const append = () => {
    if (message.kind === 'bot') {
      requireBotPermission(state, 'SendMessages')
      if (
        state.channels?.find((channel) => channel.id === (message.channelId ?? state.channelId))
          ?.deleted
      )
        throw new Error('Channel was deleted')
    }
    if (state.messages.length >= PLAYGROUND_LIMITS.messages)
      throw new Error('Message limit reached; reset the playground')
    const result = { ...message, id: state.nextId++ }
    state.messages.push(result)
    if (JSON.stringify(state).length > PLAYGROUND_LIMITS.requestBytes - 65_536) {
      state.messages.pop()
      state.nextId--
      throw new Error('Transcript size limit reached; reset the playground')
    }
    return result
  }
  return message.kind === 'user'
    ? append()
    : operation(state, message.kind === 'dm' ? 'message.dm' : 'message.send', [message], append)
}

export function hasPermission(member: FakeMember, permission: FakePermission): boolean {
  return member.permissions.includes('admin') || member.permissions.includes(permission)
}

export async function buildFakeEmbed(
  embed: BCFDEmbedMessageTemplate,
  ctx: TemplateContext
): Promise<BCFDEmbedMessageTemplate> {
  if (!embed || typeof embed !== 'object') throw new Error('Invalid embed template')
  // URLs are inert strings; nothing here fetches, loads, links, or executes them.
  const result = {} as BCFDEmbedMessageTemplate
  for (const key of ['title', 'description', 'hexColor', 'imageURL', 'thumbnailURL', 'footer'])
    result[key] = await evaluateTemplate(embed[key] ?? '', ctx)
  return result
}

export function toggleRole(state: PlaygroundState, sender: FakeMember, roleId: string): void {
  operation(state, 'member.roles.toggle', [sender.id, roleId], () => {
    requireBotPermission(state, 'ManageRoles')
    const role = state.roles.find((item) => item.id === roleId)
    if (!role) throw new Error(`Unknown fake role: ${roleId}`)
    if (role.managed || role.editable === false || sender.manageable === false)
      throw new Error('Role or member is not manageable')
    sender.roles = sender.roles.includes(roleId)
      ? sender.roles.filter((id) => id !== roleId)
      : [...sender.roles, roleId]
  })
}

async function executeCommand(
  state: PlaygroundState,
  command: BCFDCommand,
  senderId: string,
  content: string,
  inputId: number,
  trace: string[],
  ctx: TemplateContext,
  event: CommandEvent
): Promise<{ outcome: 'executed' | 'blocked'; reason?: string }> {
  const sender = state.members.find((member) => member.id === senderId)!
  const mentionedId = /<@!?(\d+)>/.exec(content)?.[1]
  const mentioned = state.members.find((member) => member.id === mentionedId)
  const memberEvent = ['memberJoin', 'memberLeave', 'memberBan'].includes(event)
  const render = async (source: string) => await evaluateTemplate(source, ctx)
  if (
    !memberEvent &&
    command.channelWhitelist?.trim() &&
    !command.channelWhitelist
      .split(',')
      .map((id) => id.trim())
      .includes(state.channelId)
  ) {
    trace.push('Skipped: fake channel is not whitelisted')
    return { outcome: 'blocked', reason: 'Fake channel is not whitelisted' }
  }
  if (
    command.serverWhitelist?.trim() &&
    !command.serverWhitelist
      .split(',')
      .map((id) => id.trim())
      .includes(state.guildId)
  ) {
    trace.push('Skipped: fake server is not whitelisted')
    return { outcome: 'blocked', reason: 'Fake server is not whitelisted' }
  }
  if (
    !memberEvent &&
    command.requiredRole?.trim() &&
    (event === 'dm' || !hasFakeRole(state, sender, command.requiredRole))
  ) {
    trace.push('Blocked: missing required fake role')
    return { outcome: 'blocked', reason: 'Missing required fake role' }
  }
  if (!memberEvent && command.isAdmin && (event === 'dm' || !hasPermission(sender, 'admin'))) {
    trace.push('Blocked: administrator required')
    return { outcome: 'blocked', reason: 'Administrator required' }
  }
  if (!memberEvent && event !== 'dm' && command.isNSFW && !state.nsfw) {
    trace.push('Blocked: fake channel is not NSFW')
    return { outcome: 'blocked', reason: 'Fake channel is not NSFW' }
  }
  if (
    (event === 'message' || event === 'dm') &&
    (command.cooldown ?? 0) > 0 &&
    command.cooldownType
  ) {
    const remaining = remainingCooldown(state, command, senderId)
    if (remaining > 0) {
      if (command.cooldownMessage || !command.ignoreErrorMessage)
        addMessage(state, {
          kind: 'bot',
          author: 'Playground Bot',
          replyTo: inputId,
          content: command.cooldownMessage
            ? await render(command.cooldownMessage)
            : `This command is on cooldown. Try again in ${remaining}s.`
        })
      trace.push(`Blocked: ${command.cooldownType.toLowerCase()} cooldown; ${remaining}s remaining`)
      return { outcome: 'blocked', reason: `Cooldown; ${remaining}s remaining` }
    }
  }
  const destination = command.specificChannel?.trim()
    ? (fakeChannels(state).find(
        (channel) =>
          channel.id === command.specificChannel ||
          channel.name.toLowerCase() === command.specificChannel.replace(/^#/, '').toLowerCase()
      )?.id ?? state.channelId)
    : state.channelId
  const pending: Promise<unknown>[] = []
  const failures: string[] = []
  const moderate = (
    enabled: boolean,
    permission: FakePermission,
    key: 'kicked' | 'banned' | 'muted'
  ) => {
    if (!enabled || content.split(' ')[0] !== command.command || content.split(' ').length !== 2)
      return true
    if (!hasPermission(sender, permission)) return false
    if (mentioned)
      operation(state, `member.${key}`, [mentioned.id], () => {
        requireBotPermission(
          state,
          { kicked: 'KickMembers', banned: 'BanMembers', muted: 'MuteMembers' }[key]
        )
        if (mentioned.manageable === false) throw new Error('Member is not manageable')
        mentioned[key] = true
      })
    return true
  }
  let dispatched: Awaited<ReturnType<typeof runTraditionalActions>>
  try {
    dispatched = await runTraditionalActions(
      {
        purge: async () => {
          if (command.deleteNum > 0) {
            if (!hasPermission(sender, 'manageMessages')) {
              trace.push('Blocked: Manage Messages required')
              return false
            }
            if (!Number.isInteger(command.deleteNum) || command.deleteNum > 100)
              throw new Error('Deletion count must be from 1 to 100')
            operation(state, 'message.purge', [command.deleteNum], () => {
              requireBotPermission(state, 'ManageMessages')
              state.messages
                .filter(
                  (message) => message.kind !== 'dm' && !message.deleted && !message.ephemeral
                )
                .slice(-command.deleteNum)
                .forEach((message) => (message.deleted = true))
            })
            trace.push(`Deleted ${command.deleteNum} fake channel messages`)
          }
          return true
        },
        deleteIf: async () => {
          if (command.deleteIfStrings?.split('|').some((text) => text && content.includes(text))) {
            const input = state.messages.find((message) => message.id === inputId)
            if (input) input.deleted = true
          }
        },
        message: async () => {
          if (commandCapabilities.sendsChannelMessage(command))
            addMessage(state, {
              kind: 'bot',
              author: 'Playground Bot',
              channelId: destination,
              content: await render(command.channelMessage),
              replyTo: command.channelMessageAsReply ? inputId : undefined
            })
        },
        dm: async () => {
          if (commandCapabilities.sendsPrivateMessage(command))
            addMessage(state, {
              kind: 'dm',
              author: 'Playground Bot',
              channelId: destination,
              recipient: senderId,
              content: await render(command.privateMessage)
            })
        },
        embed: async () => {
          if (commandCapabilities.sendsChannelEmbed(command))
            addMessage(state, {
              kind: 'bot',
              author: 'Playground Bot',
              channelId: destination,
              content: '',
              embed: await buildFakeEmbed(command.channelEmbed, ctx),
              replyTo: command.channelEmbedAsReply ? inputId : undefined
            })
        },
        dmEmbed: async () => {
          if (commandCapabilities.sendsPrivateEmbed(command))
            addMessage(state, {
              kind: 'dm',
              author: 'Playground Bot',
              channelId: destination,
              recipient: senderId,
              content: '',
              embed: await buildFakeEmbed(command.privateEmbed, ctx)
            })
        },
        role: async () => {
          if (commandCapabilities.assignsRole(command)) {
            toggleRole(state, sender, await render(command.roleToAssign))
            trace.push(`Toggled role on invoking member ${sender.name}`)
          }
        },
        reaction: async () => {
          if (command.reaction?.trim()) {
            operation(state, 'message.react', [inputId, command.reaction], () => {
              const target = state.messages.find((item) => item.id === inputId)
              if (!target || target.deleted) throw new Error('Reaction message is unavailable')
              target.reactions = [...new Set([...(target.reactions ?? []), command.reaction])]
            })
          }
        },
        kick: () => moderate(command.isKick, 'kick', 'kicked'),
        ban: () => moderate(command.isBan, 'ban', 'banned'),
        mute: () => moderate(command.isVoiceMute, 'mute', 'muted'),
        deleteAfter: () => {
          if (command.deleteAfter) {
            const input = state.messages.find((item) => item.id === inputId)
            if (input) input.deleted = true
          }
        },
        cooldown: () => recordCooldown(state, command, senderId)
      },
      (task) => {
        pending.push(
          task.catch((error) => {
            failures.push(error instanceof Error ? error.message : String(error))
          })
        )
      },
      event
    )
  } finally {
    await Promise.all(pending)
  }
  if (failures.length) throw new Error(failures.join('; '))
  if (dispatched.blockedBy)
    return {
      outcome: 'blocked',
      reason:
        dispatched.blockedBy === 'purge'
          ? 'Manage Messages required'
          : `Missing fake ${dispatched.blockedBy} permission`
    }
  trace.push(`Executed ${command.command}`)
  return { outcome: 'executed' }
}

export async function runMessage(
  request: PlaygroundMessageRequest,
  factory?: ScriptSandboxFactory
): Promise<PlaygroundResult> {
  validateState(request.state)
  if (!Array.isArray(request.commands) || request.commands.length > PLAYGROUND_LIMITS.commands)
    throw new Error('Saved-command limit exceeded')
  if (typeof request.content !== 'string' || request.content.length > PLAYGROUND_LIMITS.input)
    throw new Error('Input exceeds the playground limit')
  const sender = request.state.members.find((member) => member.id === request.senderId)
  if (
    !sender ||
    ((sender.kicked || sender.banned) && !['memberLeave', 'memberBan'].includes(request.kind ?? ''))
  )
    throw new Error('Choose an available fake sender')
  let state = structuredClone(request.state)
  const trace: string[] = [],
    errors: string[] = []
  const memberEvent = ['memberJoin', 'memberLeave', 'memberBan'].includes(request.kind ?? '')
  const input = memberEvent
    ? { id: 0 }
    : request.kind === 'reaction'
      ? state.messages.find((item) => item.id === request.messageId)
      : addMessage(state, {
          kind: 'user',
          author: sender.name,
          content: request.content,
          channelId: state.channelId
        })
  if (!input) throw new Error('Reaction message not found')
  state.commandCount = request.commands.length
  const matching = request.commands.filter(
    (command) =>
      matchesCommand(
        command,
        request.kind ?? 'message',
        request.content,
        String(request.messageId ?? '')
      ) && !sender.bot
  )
  const resources: PlaygroundResourceResult[] = request.commands.map((command) => ({
    resourceId: command.id,
    kind: 'command',
    matched: matching.includes(command),
    executed: false,
    outcome: 'unmatched',
    reason: 'Event or trigger did not match'
  }))
  trace.push(`${matching.length} matching command(s)`)
  for (const command of matching) {
    const resource = resources[request.commands.indexOf(command)]
    const draft = structuredClone(state),
      commandTrace: string[] = []
    const sender = draft.members.find((member) => member.id === request.senderId)!
    const mentioned = draft.members.find(
      (member) => member.id === /<@!?(\d+)>/.exec(request.content)?.[1]
    )
    const scope = executionContext(
      {
        state: draft,
        sender,
        mentioned,
        event: request.kind,
        content:
          request.kind === 'reaction'
            ? (state.messages.find((item) => item.id === request.messageId)?.content ?? '')
            : memberEvent
              ? ''
              : request.content,
        wrapEvalInIIFE: request.wrapEvalInIIFE,
        trigger: command.command,
        command,
        trace: commandTrace
      },
      factory
    )
    try {
      const execution = await executeCommand(
        draft,
        command,
        request.senderId,
        request.content,
        input.id,
        commandTrace,
        scope.context,
        request.kind ?? 'message'
      )
      scope.commit()
      resource.outcome = execution.outcome
      resource.executed = execution.outcome === 'executed'
      resource.reason = execution.reason
      state = draft
      trace.push(...commandTrace)
    } catch (error) {
      resource.outcome = error instanceof PlaygroundExecutionError ? error.outcome : 'error'
      resource.reason = error instanceof Error ? error.message : 'Execution failed'
      resource.error = resource.reason
      errors.push(
        `${command.command}: ${error instanceof Error ? error.message : 'Execution failed'}`
      )
      state = draft
      trace.push(...commandTrace, `Failed: ${command.command}; earlier effects retained`)
    } finally {
      scope.dispose()
    }
  }
  return { state, trace, errors, resources }
}
