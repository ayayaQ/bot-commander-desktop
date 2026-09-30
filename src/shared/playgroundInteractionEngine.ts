// Pure interaction simulator: no Discord client, IPC, filesystem, network or production interpreter.
import { parse } from '../main/services/bcfdLang/parser'
import { NodeType, type ASTNode, type ConditionNode } from '../main/services/bcfdLang/types'
import type {
  BCFDInteractionAction,
  BCFDInteractionButton,
  BCFDSlashCommandOption
} from '../main/types/types'
import type { CommandEmbed } from './commandCapabilities'
import type {
  PlaygroundButton,
  PlaygroundInteractionValue,
  PlaygroundRequest,
  PlaygroundResult,
  PlaygroundTrace
} from './playground'

const supported = new Set([
  'name',
  'namePlain',
  'ID',
  'id',
  'isBot',
  'memberID',
  'memberEffectiveName',
  'channel',
  'channelID',
  'channelAsMention',
  'channelIsNSFW',
  'serverID',
  'option',
  'upper',
  'lower',
  'length',
  'contains',
  'wordCount'
])

const truthy = (value: string) => value !== '' && value !== 'false' && value !== '0'

function optionIssue(
  option: BCFDSlashCommandOption,
  value: PlaygroundInteractionValue | undefined
): string | null {
  if (value === undefined || value === '')
    return option.required ? `${option.name} is required` : null
  if (option.type === 3 && typeof value !== 'string') return `${option.name} must be a string`
  if (option.type === 4 && (!Number.isInteger(value) || typeof value !== 'number'))
    return `${option.name} must be an integer`
  if (option.type === 5 && typeof value !== 'boolean') return `${option.name} must be true or false`
  if ([6, 7, 8].includes(option.type) && (typeof value !== 'string' || !/^\d+$/.test(value)))
    return `${option.name} must be a fake Discord ID`
  if (option.type === 10 && (typeof value !== 'number' || !Number.isFinite(value)))
    return `${option.name} must be a number`
  if (option.choices?.length && !option.choices.some((choice) => choice.value === value))
    return `${option.name} must use one of its configured choices`
  return null
}

function findButton(
  action: BCFDInteractionAction,
  path: string[]
): { button: BCFDInteractionButton; action: BCFDInteractionAction } | null {
  let current = action
  let selected: BCFDInteractionButton | undefined
  for (const customId of path) {
    selected = current.buttons?.find((button) => button.customId === customId)
    if (!selected) return null
    current = selected.action
  }
  return selected ? { button: selected, action: current } : null
}

export function runPlaygroundInteractionSimulation(input: PlaygroundRequest): PlaygroundResult {
  const request: PlaygroundRequest = JSON.parse(JSON.stringify(input))
  const invocation = request.interaction
  if (!invocation) throw new Error('Missing fake interaction invocation')
  const command = request.interactions?.find((candidate) => candidate.id === invocation.commandId)
  if (!command) throw new Error('The selected interaction no longer exists')
  const sender = request.fixture.members.find((member) => member.id === request.senderId)
  if (!sender || sender.status !== 'active') throw new Error('Choose an active fake sender')

  const result: PlaygroundResult = {
    fixture: request.fixture,
    outputs: [],
    traces: [],
    stateBefore: JSON.parse(JSON.stringify(request.fixture.botState)),
    stateAfter: JSON.parse(JSON.stringify(request.fixture.botState))
  }
  const trace: PlaygroundTrace = {
    command: `/${command.commandName}`,
    status: 'filtered',
    checks: [],
    conditions: [],
    actions: [],
    issues: []
  }
  result.traces.push(trace)

  const isButton = !!invocation.buttonPath?.length
  let action = command.rootAction
  if (isButton) {
    const found = findButton(action, invocation.buttonPath!)
    if (!found) throw new Error('The selected fake button is no longer available')
    if (found.button.disabled) throw new Error('Disabled buttons cannot be clicked')
    if (found.button.style === 5)
      throw new Error('Link buttons open external URLs and are not executed in the playground')
    action = found.action
    trace.command += ` → ${found.button.label || 'Button'}`
  } else {
    const known = new Set(command.options.map((option) => option.name))
    for (const option of command.options) {
      const issue = optionIssue(option, invocation.options[option.name])
      trace.checks.push({ label: issue ?? `Option ${option.name} is valid`, passed: !issue })
      if (issue) trace.issues.push(issue)
    }
    for (const name of Object.keys(invocation.options)) {
      if (!known.has(name)) trace.issues.push(`Unknown option: ${name}`)
    }
    if (trace.issues.length) return result
  }

  let budget = 20_000
  const tick = (depth: number) => {
    if (--budget < 0 || depth > 64) throw new Error('Template exceeds playground complexity limit')
  }
  const parsed = new Map<string, ASTNode[]>()
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
          node.arguments.forEach((argument) => validateNodes(argument, depth + 1))
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
  const template = (source: string) => {
    if (source.length > 16_000) throw new Error('Template exceeds 16,000 characters')
    const { ast, errors } = parse(source)
    if (errors.length) throw new Error(errors.map((error) => error.message).join('; '))
    validateNodes(ast.children, 0)
    parsed.set(source, ast.children)
  }
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
      case 'channel':
        return request.fixture.channelName
      case 'channelID':
        return request.fixture.channelId
      case 'channelAsMention':
        return `<#${request.fixture.channelId}>`
      case 'channelIsNSFW':
        return String(request.fixture.nsfw)
      case 'serverID':
        return request.fixture.guildId
      case 'option': {
        const option = invocation.options[values[0] ?? '']
        return option === undefined || option === null ? '' : String(option)
      }
      case 'upper':
        return values[0]?.toUpperCase() ?? ''
      case 'lower':
        return values[0]?.toLowerCase() ?? ''
      case 'length':
        return String(values[0]?.length ?? 0)
      case 'contains':
        return String((values[0] ?? '').includes(values[1] ?? ''))
      case 'wordCount':
        return String(values[0]?.trim() ? values[0].trim().split(/\s+/u).length : 0)
      default:
        throw new Error(`Unsupported keyword: ${name}`)
    }
  }
  const condition = (node: ConditionNode, depth: number): string => {
    tick(depth)
    if (node.type === 'value') return evaluate(node.nodes, depth + 1)
    if (node.type === 'group') return condition(node.expr, depth + 1)
    if (node.type === 'unary') return String(!truthy(condition(node.operand, depth + 1)))
    const left = condition(node.left, depth + 1)
    const right = condition(node.right, depth + 1)
    if (node.op === '==') return String(left === right)
    if (node.op === '!=') return String(left !== right)
    if (node.op === '>') return String(parseFloat(left) > parseFloat(right))
    if (node.op === '<') return String(parseFloat(left) < parseFloat(right))
    if (node.op === '>=') return String(parseFloat(left) >= parseFloat(right))
    if (node.op === '<=') return String(parseFloat(left) <= parseFloat(right))
    if (node.op === '&') return String(truthy(left) && truthy(right))
    return String(truthy(left) || truthy(right))
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
          node.arguments.map((argument) => evaluate(argument, depth + 1))
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
  const embed = (source: BCFDInteractionAction['channelEmbed']) =>
    Object.fromEntries(
      Object.entries(source).map(([key, text]) => [key, render(text)])
    ) as CommandEmbed

  try {
    const templates = [
      action.sendChannelMessage ? action.channelMessage : '',
      action.sendPrivateMessage ? action.privateMessage : '',
      action.isRoleAssigner ? action.roleToAssign : '',
      ...(action.sendChannelEmbed ? Object.values(action.channelEmbed) : []),
      ...(action.sendPrivateEmbed ? Object.values(action.privateEmbed) : []),
      ...action.buttons.slice(0, 5).map((button) => button.label || 'Button')
    ]
    templates.forEach(template)
  } catch (error) {
    trace.status = 'unsupported'
    trace.issues.push(error instanceof Error ? error.message : String(error))
    return result
  }

  if (action.deleteX) {
    trace.status = 'unsupported'
    trace.issues.push('Message deletion is unsupported; no interaction effects were applied')
    return result
  }
  let buttons: PlaygroundButton[]
  let channelText: string
  let channelEmbed: CommandEmbed | undefined
  let privateText: string
  let privateEmbed: CommandEmbed | undefined
  let role: string
  try {
    buttons = action.buttons.slice(0, 5).map((button) => ({
      customId: button.customId,
      label: render(button.label || 'Button'),
      style: button.style,
      disabled: button.disabled,
      path: [...(invocation.buttonPath ?? []), button.customId]
    }))
    channelText =
      action.sendChannelMessage && action.channelMessage ? render(action.channelMessage) : ''
    channelEmbed = action.sendChannelEmbed ? embed(action.channelEmbed) : undefined
    privateText =
      action.sendPrivateMessage && action.privateMessage ? render(action.privateMessage) : ''
    privateEmbed = action.sendPrivateEmbed ? embed(action.privateEmbed) : undefined
    role = action.isRoleAssigner && action.roleToAssign ? render(action.roleToAssign) : ''
  } catch (error) {
    trace.status = 'unsupported'
    trace.issues.push(error instanceof Error ? error.message : String(error))
    return result
  }

  if (action.isKick || action.isBan || action.isVoiceMute) {
    if (!sender.admin) {
      trace.status = 'ran'
      trace.actions.push(
        'Moderation denied: fake sender is not an administrator; no reply was sent'
      )
      return result
    }
    const targetId = String(invocation.options[action.targetUserOptionName] ?? '')
    const target = request.fixture.members.find((member) => member.id === targetId)
    if (!action.targetUserOptionName || !target) {
      trace.status = 'ran'
      trace.actions.push('Moderation denied: configured target user option has no fake member')
      return result
    }
    if (action.isKick) target.status = 'kicked'
    if (action.isBan) target.status = 'banned'
    if (action.isVoiceMute) target.muted = true
    trace.actions.push(
      `Simulated moderation on ${target.name}; Discord hierarchy and API failures are not modeled`
    )
  }

  result.outputs.push({
    destination: action.ephemeral ? `Only ${sender.name}` : `#${request.fixture.channelName}`,
    text: channelText || (!channelEmbed ? '\u200B' : undefined),
    embed: channelEmbed,
    reply: true,
    ephemeral: action.ephemeral,
    buttons,
    interactionCommandId: command.id,
    interactionOptions: invocation.options
  })
  trace.actions.push(
    `Simulated ${action.deferReply ? 'deferred ' : ''}${action.ephemeral ? 'ephemeral ' : ''}interaction reply`
  )
  if (privateText) {
    result.outputs.push({ destination: `DM to ${sender.name}`, text: privateText, reply: false })
    trace.actions.push(`Simulated DM to ${sender.name}`)
  }
  if (privateEmbed) {
    result.outputs.push({ destination: `DM to ${sender.name}`, embed: privateEmbed, reply: false })
    trace.actions.push(`Simulated private embed to ${sender.name}`)
  }
  if (role) {
    if (sender.roles.includes(role)) sender.roles = sender.roles.filter((item) => item !== role)
    else sender.roles.push(role)
    trace.actions.push(`Simulated role toggle on ${sender.name}: ${role}`)
  }
  trace.status = 'ran'
  return result
}
