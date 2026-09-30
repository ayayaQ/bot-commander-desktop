// Deliberately import the pure parser, never the interpreter barrel or a live service.
// This evaluator has no host callbacks, dynamic evaluation, Discord clients or I/O.
import { parse } from '../main/services/bcfdLang/parser'
import { NodeType, type ASTNode, type ConditionNode } from '../main/services/bcfdLang/types'
import { hasEmbedContent, type CommandEmbed } from './commandCapabilities'
import type { CanonicalBCFDCommand } from './commandCodec'
import type { PlaygroundRequest, PlaygroundResult, PlaygroundTrace } from './playground'
import { runPlaygroundInteractionSimulation } from './playgroundInteractionEngine'

const supported = new Set([
  'name',
  'namePlain',
  'ID',
  'id',
  'isBot',
  'memberID',
  'memberEffectiveName',
  'message',
  'messageAfterCommand',
  'argsCount',
  'args',
  'wordCount',
  'channel',
  'channelID',
  'channelAsMention',
  'channelIsNSFW',
  'serverID',
  'mentionedName',
  'mentionedID',
  'mentionedNamePlain',
  'upper',
  'lower',
  'length',
  'contains'
])
const truthy = (value: string) => value !== '' && value !== 'false' && value !== '0'

export function playgroundMatches(command: CanonicalBCFDCommand, message: string): boolean {
  return (
    command.type === 0 &&
    (message === command.command ||
      (command.startsWith && message.startsWith(command.command)) ||
      (command.phrase && message.toLowerCase().includes(command.command.toLowerCase())) ||
      command.command === '*' ||
      ((command.isBan || command.isKick || command.isVoiceMute) &&
        command.command === message.split(' ')[0] &&
        message.split(' ').length === 2))
  )
}

export function runPlaygroundSimulation(input: PlaygroundRequest): PlaygroundResult {
  // The worker's structured-clone boundary is supplemented by a clone here so direct
  // callers cannot mutate saved command objects or any state passed by reference.
  if (JSON.stringify(input).length > 256_000) throw new Error('Playground input exceeds 256 KB')
  if (input.commands.length > 100) throw new Error('Choose at most 100 commands for a run')
  if (input.message.length > 4_000)
    throw new Error('Sample messages are limited to 4,000 characters')
  if (input.interaction) return runPlaygroundInteractionSimulation(input)
  const request: PlaygroundRequest = JSON.parse(JSON.stringify(input))
  const { fixture, message } = request
  const sender = fixture.members.find((member) => member.id === request.senderId)
  if (!sender || sender.status !== 'active') throw new Error('Choose an active fake sender')
  const mentionedId = message.match(/<@!?(\d+)>/)?.[1]
  const mentioned = fixture.members.find((member) => member.id === mentionedId)
  const result: PlaygroundResult = {
    fixture,
    outputs: [],
    traces: [],
    stateBefore: JSON.parse(JSON.stringify(fixture.botState)),
    stateAfter: JSON.parse(JSON.stringify(fixture.botState))
  }
  let budget = 20_000
  const tick = (depth: number) => {
    if (--budget < 0 || depth > 64) throw new Error('Template exceeds playground complexity limit')
  }
  for (const command of request.commands) {
    const trace: PlaygroundTrace = {
      command: command.command,
      status: 'filtered',
      checks: [],
      conditions: [],
      actions: [],
      issues: []
    }
    result.traces.push(trace)
    const check = (label: string, passed: boolean) => trace.checks.push({ label, passed })
    check(
      'Message trigger matches (message-received commands only)',
      playgroundMatches(command, message)
    )
    if (!trace.checks[0].passed) continue
    check(
      'Channel whitelist',
      !command.channelWhitelist?.trim() ||
        command.channelWhitelist
          .split(',')
          .map((s) => s.trim())
          .includes(fixture.channelId)
    )
    check(
      'Server whitelist',
      !command.serverWhitelist?.trim() ||
        command.serverWhitelist
          .split(',')
          .map((s) => s.trim())
          .includes(fixture.guildId)
    )
    check(
      'Required role',
      !command.requiredRole?.trim() || sender.roles.includes(command.requiredRole)
    )
    check('Administrator', !command.isAdmin || sender.admin)
    check('NSFW channel', !command.isNSFW || fixture.nsfw)
    if (trace.checks.some((item) => !item.passed)) continue

    // Preflight EVERY branch and argument before any reply or fake mutation. A
    // hidden unsupported effect must never make a partially successful simulation.
    const validateCondition = (node: ConditionNode, depth: number) => {
      tick(depth)
      if (node.type === 'value') validateNodes(node.nodes, depth + 1)
      else if (node.type === 'group') validateCondition(node.expr, depth + 1)
      else if (node.type === 'unary') validateCondition(node.operand, depth + 1)
      else {
        validateCondition(node.left, depth + 1)
        validateCondition(node.right, depth + 1)
      }
    }
    const validateNodes = (nodes: ASTNode[], depth: number) => {
      for (const node of nodes) {
        tick(depth)
        if (node.type === NodeType.EVAL_BLOCK)
          throw new Error('$eval is unsupported; scripts and botState writes never run')
        if (node.type === NodeType.ERROR) throw new Error(node.message)
        if (node.type === NodeType.VARIABLE || node.type === NodeType.FUNCTION_CALL) {
          if (!supported.has(node.name))
            throw new Error(`$${node.name} is unsupported in the offline playground`)
          if (node.type === NodeType.FUNCTION_CALL)
            node.arguments.forEach((arg) => validateNodes(arg, depth + 1))
        } else if (node.type === NodeType.PROGRAM) validateNodes(node.children, depth + 1)
        else if (node.type === NodeType.IF_BLOCK) {
          node.branches.forEach((branch) => {
            validateCondition(branch.condition, depth + 1)
            validateNodes(branch.body, depth + 1)
          })
          validateNodes(node.elseBranch ?? [], depth + 1)
        }
      }
    }
    const parsed = new Map<string, ASTNode[]>()
    const template = (source: string) => {
      if (source.length > 16_000) throw new Error('Template exceeds 16,000 characters')
      const { ast, errors } = parse(source)
      if (errors.length) throw new Error(errors.map((error) => error.message).join('; '))
      validateNodes(ast.children, 0)
      parsed.set(source, ast.children)
    }
    try {
      if (command.cooldown && command.cooldown > 0 && command.cooldownType)
        throw new Error('Cooldown timing is unsupported')
      if (command.deleteNum > 0 || command.deleteAfter || command.deleteIfStrings?.trim())
        throw new Error('Message deletion is unsupported')
      if (command.specificChannel?.trim())
        throw new Error('Specific-channel routing is unsupported; this fixture has one channel')
      ;[
        command.channelMessage,
        command.privateMessage,
        command.roleToAssign,
        ...Object.values(command.channelEmbed),
        ...Object.values(command.privateEmbed)
      ].forEach(template)
    } catch (error) {
      trace.status = 'unsupported'
      trace.issues.push(error instanceof Error ? error.message : String(error))
      continue
    }

    const after = message.substring(command.command.length).trim()
    const args = after.split(' ').filter(Boolean)
    const value = (name: string, values: string[]) => {
      switch (name) {
        case 'name':
          return `<@${sender.id}>`
        case 'namePlain':
        case 'memberEffectiveName':
          return sender.name
        case 'id':
        case 'ID':
        case 'memberID':
          return sender.id
        case 'isBot':
          return 'false'
        case 'message':
          return message
        case 'messageAfterCommand':
          return after
        case 'argsCount':
          return String(args.length)
        case 'args':
          return args[parseInt(values[0] ?? '0', 10)] ?? ''
        case 'wordCount':
          return String(values[0]?.trim() ? values[0].trim().split(/\s+/u).length : 0)
        case 'channel':
          return fixture.channelName
        case 'channelID':
          return fixture.channelId
        case 'channelAsMention':
          return `<#${fixture.channelId}>`
        case 'channelIsNSFW':
          return String(fixture.nsfw)
        case 'serverID':
          return fixture.guildId
        case 'mentionedName':
          return `<@${mentioned?.id ?? ''}>`
        case 'mentionedID':
          return mentioned?.id ?? ''
        case 'mentionedNamePlain':
          return mentioned?.name ?? ''
        case 'upper':
          return values[0]?.toUpperCase() ?? ''
        case 'lower':
          return values[0]?.toLowerCase() ?? ''
        case 'length':
          return String(values[0]?.length ?? 0)
        case 'contains':
          return String((values[0] ?? '').includes(values[1] ?? ''))
        default:
          throw new Error(`Unsupported keyword: ${name}`)
      }
    }
    const condition = (node: ConditionNode, depth: number): string => {
      tick(depth)
      if (node.type === 'value') return evaluate(node.nodes, depth + 1)
      if (node.type === 'group') return condition(node.expr, depth + 1)
      if (node.type === 'unary') return String(!truthy(condition(node.operand, depth + 1)))
      const left = condition(node.left, depth + 1),
        right = condition(node.right, depth + 1)
      switch (node.op) {
        case '==':
          return String(left === right)
        case '!=':
          return String(left !== right)
        case '>':
          return String(parseFloat(left) > parseFloat(right))
        case '<':
          return String(parseFloat(left) < parseFloat(right))
        case '>=':
          return String(parseFloat(left) >= parseFloat(right))
        case '<=':
          return String(parseFloat(left) <= parseFloat(right))
        case '&':
          return String(truthy(left) && truthy(right))
        case '|':
          return String(truthy(left) || truthy(right))
      }
    }
    const evaluate = (nodes: ASTNode[], depth = 0): string => {
      let output = ''
      for (const node of nodes) {
        tick(depth)
        if (node.type === NodeType.TEXT) output += node.value
        else if (node.type === NodeType.VARIABLE) output += value(node.name, [])
        else if (node.type === NodeType.FUNCTION_CALL)
          output += value(
            node.name,
            node.arguments.map((arg) => evaluate(arg, depth + 1))
          )
        else if (node.type === NodeType.PROGRAM) output += evaluate(node.children, depth + 1)
        else if (node.type === NodeType.IF_BLOCK) {
          let selected = node.elseBranch ?? []
          for (const [index, branch] of node.branches.entries()) {
            const passes = truthy(condition(branch.condition, depth + 1))
            trace.conditions.push(
              `$if branch ${index + 1} at ${node.position}: ${passes ? 'passed' : 'failed'}`
            )
            if (passes) {
              selected = branch.body
              break
            }
          }
          output += evaluate(selected, depth + 1)
        }
        if (output.length > 64_000) throw new Error('Rendered output exceeds 64,000 characters')
      }
      return output
    }
    const render = (source: string) => evaluate(parsed.get(source) ?? [])
    // Stage all evaluated fields before applying effects to keep errors atomic.
    let channelText: string,
      privateText: string,
      role: string,
      channelEmbed: CommandEmbed,
      privateEmbed: CommandEmbed
    try {
      channelText = render(command.channelMessage)
      privateText = render(command.privateMessage)
      role = render(command.roleToAssign)
      const embed = (source: CommandEmbed) =>
        Object.fromEntries(
          Object.entries(source).map(([key, text]) => [key, render(text)])
        ) as CommandEmbed
      channelEmbed = embed(command.channelEmbed)
      privateEmbed = embed(command.privateEmbed)
    } catch (error) {
      trace.status = 'unsupported'
      trace.issues.push(error instanceof Error ? error.message : String(error))
      continue
    }
    trace.status = 'ran'
    if (command.channelMessage.trim()) {
      result.outputs.push({
        destination: `#${fixture.channelName}`,
        text: channelText,
        reply: !!command.channelMessageAsReply
      })
      trace.actions.push('Simulated channel message')
    }
    if (command.privateMessage.trim()) {
      result.outputs.push({ destination: `DM to ${sender.name}`, text: privateText, reply: false })
      trace.actions.push(`Simulated DM to ${sender.name}`)
    }
    let stopped = false
    for (const [enabled, action] of [
      [command.isKick, 'kick'],
      [command.isBan, 'ban'],
      [command.isVoiceMute, 'mute']
    ] as const) {
      if (!enabled || message.split(' ')[0] !== command.command || message.split(' ').length !== 2)
        continue
      if (!sender.admin) {
        trace.actions.push(
          `Stopped at ${action}: fake sender lacks moderation permission (admin fixture required)`
        )
        stopped = true
        break
      }
      if (mentioned) {
        if (action === 'mute') mentioned.muted = true
        else mentioned.status = action === 'kick' ? 'kicked' : 'banned'
        trace.actions.push(
          `Simulated ${action}: ${mentioned.name}; Discord hierarchy and API failures are not modeled`
        )
      } else trace.actions.push(`${action}: no known fake user mentioned; no effect`)
    }
    if (stopped) continue
    if (command.roleToAssign.trim()) {
      if (sender.roles.includes(role)) sender.roles = sender.roles.filter((item) => item !== role)
      else sender.roles.push(role)
      trace.actions.push(`Simulated role toggle on ${sender.name}: ${role}`)
    }
    if (hasEmbedContent(command.channelEmbed)) {
      result.outputs.push({
        destination: `#${fixture.channelName}`,
        embed: channelEmbed,
        reply: !!command.channelEmbedAsReply
      })
      trace.actions.push('Simulated channel embed (external media not loaded)')
    }
    if (hasEmbedContent(command.privateEmbed)) {
      result.outputs.push({
        destination: `DM to ${sender.name}`,
        embed: privateEmbed,
        reply: false
      })
      trace.actions.push('Simulated private embed (external media not loaded)')
    }
    if (command.reaction.trim()) trace.actions.push(`Simulated reaction: ${command.reaction}`)
    if (command.channelMessageTyping || command.channelEmbedTyping)
      trace.actions.push('Typing indicator timing not modeled')
  }
  return result
}
