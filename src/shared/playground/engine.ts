import type { BCFDCommand, BCFDEmbedMessageTemplate } from '../../main/types/types'
import { commandCapabilities } from '../commandCapabilities'
import { evaluateTemplate } from './template'
import type { TemplateContext } from './template'
import type { ScriptSandboxFactory } from './script'
import { executionContext } from './executionContext'
import { recordCooldown, remainingCooldown, validateSessionState } from './sessionState'
import { PLAYGROUND_LIMITS } from './types'
import type {
  FakeMember,
  FakePermission,
  PlaygroundMessage,
  PlaygroundMessageRequest,
  PlaygroundResult,
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
  if (state.messages.length >= PLAYGROUND_LIMITS.messages)
    throw new Error('Message limit reached; reset the playground')
  const result = { ...message, id: state.nextId++ }
  state.messages.push(result)
  if (JSON.stringify(state).length > PLAYGROUND_LIMITS.requestBytes) {
    state.messages.pop()
    state.nextId--
    throw new Error('Transcript size limit reached; reset the playground')
  }
  return result
}

export function hasPermission(member: FakeMember, permission: FakePermission): boolean {
  return member.permissions.includes('admin') || member.permissions.includes(permission)
}

export function buildFakeEmbed(
  embed: BCFDEmbedMessageTemplate,
  ctx: TemplateContext
): BCFDEmbedMessageTemplate {
  if (!embed || typeof embed !== 'object') throw new Error('Invalid embed template')
  // URLs are inert strings; nothing here fetches, loads, links, or executes them.
  return Object.fromEntries(
    ['title', 'description', 'hexColor', 'imageURL', 'thumbnailURL', 'footer'].map((key) => [
      key,
      evaluateTemplate(embed[key] ?? '', ctx)
    ])
  ) as BCFDEmbedMessageTemplate
}

export function toggleRole(state: PlaygroundState, sender: FakeMember, roleId: string): void {
  if (!state.roles.some((role) => role.id === roleId))
    throw new Error(`Unknown fake role: ${roleId}`)
  sender.roles = sender.roles.includes(roleId)
    ? sender.roles.filter((id) => id !== roleId)
    : [...sender.roles, roleId]
}

function matches(command: BCFDCommand, content: string): boolean {
  return (
    command.type === 0 &&
    (content === command.command ||
      command.command === '*' ||
      (command.startsWith && content.startsWith(command.command)) ||
      (command.phrase && content.toLowerCase().includes(command.command.toLowerCase())) ||
      ((command.isKick || command.isBan || command.isVoiceMute) &&
        content.split(' ')[0] === command.command &&
        content.split(' ').length === 2))
  )
}

function executeCommand(
  state: PlaygroundState,
  command: BCFDCommand,
  senderId: string,
  content: string,
  inputId: number,
  trace: string[],
  ctx: TemplateContext
): void {
  const sender = state.members.find((member) => member.id === senderId)!
  const mentionedId = /<@!?(\d+)>/.exec(content)?.[1]
  const mentioned = state.members.find((member) => member.id === mentionedId)
  const render = (source: string) => evaluateTemplate(source, ctx)
  if (
    command.channelWhitelist?.trim() &&
    !command.channelWhitelist
      .split(',')
      .map((id) => id.trim())
      .includes(state.channelId)
  ) {
    trace.push('Skipped: fake channel is not whitelisted')
    return
  }
  if (
    command.serverWhitelist?.trim() &&
    !command.serverWhitelist
      .split(',')
      .map((id) => id.trim())
      .includes(state.guildId)
  ) {
    trace.push('Skipped: fake server is not whitelisted')
    return
  }
  if (command.requiredRole?.trim() && !sender.roles.includes(command.requiredRole)) {
    trace.push('Blocked: missing required fake role')
    return
  }
  if (command.isAdmin && !hasPermission(sender, 'admin')) {
    trace.push('Blocked: administrator required')
    return
  }
  if (command.isNSFW && !state.nsfw) {
    trace.push('Blocked: fake channel is not NSFW')
    return
  }
  if ((command.cooldown ?? 0) > 0 && command.cooldownType) {
    const remaining = remainingCooldown(state, command, senderId)
    if (remaining > 0) {
      if (command.cooldownMessage || !command.ignoreErrorMessage)
        addMessage(state, {
          kind: 'bot',
          author: 'Playground Bot',
          replyTo: inputId,
          content: command.cooldownMessage
            ? render(command.cooldownMessage)
            : `This command is on cooldown. Try again in ${remaining}s.`
        })
      trace.push(`Blocked: ${command.cooldownType.toLowerCase()} cooldown; ${remaining}s remaining`)
      return
    }
  }
  if (command.specificChannel?.trim() && command.specificChannel !== state.channelId)
    throw new Error('Specific channel is outside the fake channel')
  if (command.specificMessage?.trim()) throw new Error('Specific-message effects are unsupported')
  if (command.reaction?.trim()) throw new Error('Reaction effects are unsupported')
  if (command.deleteNum > 0) {
    if (!hasPermission(sender, 'manageMessages')) {
      trace.push('Blocked: Manage Messages required')
      return
    }
    if (!Number.isInteger(command.deleteNum) || command.deleteNum > 100)
      throw new Error('Deletion count must be from 1 to 100')
    state.messages
      .filter((message) => message.kind !== 'dm' && !message.deleted && !message.ephemeral)
      .slice(-command.deleteNum)
      .forEach((message) => (message.deleted = true))
    trace.push(`Deleted ${command.deleteNum} fake channel messages`)
  }
  if (
    command.deleteAfter ||
    command.deleteIfStrings?.split('|').some((text) => text && content.includes(text))
  ) {
    const input = state.messages.find((message) => message.id === inputId)
    if (input) input.deleted = true
  }
  if (commandCapabilities.sendsChannelMessage(command))
    addMessage(state, {
      kind: 'bot',
      author: 'Playground Bot',
      content: render(command.channelMessage),
      replyTo: command.channelMessageAsReply ? inputId : undefined
    })
  if (commandCapabilities.sendsPrivateMessage(command))
    addMessage(state, {
      kind: 'dm',
      author: 'Playground Bot',
      recipient: senderId,
      content: render(command.privateMessage)
    })
  if (commandCapabilities.sendsChannelEmbed(command))
    addMessage(state, {
      kind: 'bot',
      author: 'Playground Bot',
      content: '',
      embed: buildFakeEmbed(command.channelEmbed, ctx),
      replyTo: command.channelEmbedAsReply ? inputId : undefined
    })
  if (commandCapabilities.sendsPrivateEmbed(command))
    addMessage(state, {
      kind: 'dm',
      author: 'Playground Bot',
      recipient: senderId,
      content: '',
      embed: buildFakeEmbed(command.privateEmbed, ctx)
    })
  // Traditional moderation runs only for exactly “trigger mention”, as in onMessageCreate.
  if (
    (command.isKick || command.isBan || command.isVoiceMute) &&
    content.split(' ')[0] === command.command &&
    content.split(' ').length === 2
  ) {
    if (!mentioned || mentioned.kicked || mentioned.banned)
      throw new Error('Mention an available fake member for moderation')
    for (const [enabled, permission, key] of [
      [command.isKick, 'kick', 'kicked'],
      [command.isBan, 'ban', 'banned'],
      [command.isVoiceMute, 'mute', 'muted']
    ] as const) {
      if (!enabled) continue
      if (!hasPermission(sender, permission))
        throw new Error(`Missing fake ${permission} permission`)
      mentioned[key] = true
      trace.push(`${key}: ${mentioned.name}`)
    }
  }
  if (commandCapabilities.assignsRole(command)) {
    toggleRole(state, sender, render(command.roleToAssign))
    trace.push(`Toggled role on invoking member ${sender.name}`)
  }
  if (command.channelMessageTyping || command.channelEmbedTyping)
    trace.push('Typing is simulated; no network activity')
  recordCooldown(state, command, senderId)
  trace.push(`Executed ${command.command}`)
}

export function runMessage(
  request: PlaygroundMessageRequest,
  factory?: ScriptSandboxFactory
): PlaygroundResult {
  validateState(request.state)
  if (!Array.isArray(request.commands) || request.commands.length > PLAYGROUND_LIMITS.commands)
    throw new Error('Saved-command limit exceeded')
  if (typeof request.content !== 'string' || request.content.length > PLAYGROUND_LIMITS.input)
    throw new Error('Input exceeds the playground limit')
  const sender = request.state.members.find((member) => member.id === request.senderId)
  if (!sender || sender.kicked || sender.banned) throw new Error('Choose an available fake sender')
  let state = structuredClone(request.state)
  const trace: string[] = [],
    errors: string[] = []
  const input = addMessage(state, { kind: 'user', author: sender.name, content: request.content })
  const matching = request.commands.filter((command) => matches(command, request.content))
  trace.push(`${matching.length} matching saved message command(s)`)
  for (const command of matching) {
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
        content: request.content,
        trigger: command.command,
        command,
        trace: commandTrace
      },
      factory
    )
    try {
      executeCommand(
        draft,
        command,
        request.senderId,
        request.content,
        input.id,
        commandTrace,
        scope.context
      )
      scope.commit()
      state = draft
      trace.push(...commandTrace)
    } catch (error) {
      errors.push(
        `${command.command}: ${error instanceof Error ? error.message : 'Execution failed'}`
      )
      trace.push(`Failed closed: ${command.command}; no command effects applied`)
    } finally {
      scope.dispose()
    }
  }
  return { state, trace, errors }
}
