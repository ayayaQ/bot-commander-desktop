// This intentionally imports only the production parser, never the privileged interpreter.
import { parse } from '../../main/services/bcfdLang/parser'
import { NodeType } from '../../main/services/bcfdLang/types'
import type { ASTNode, ConditionNode } from '../../main/services/bcfdLang/types'
import { PLAYGROUND_LIMITS } from './types'
import type { FakeMember, PlaygroundState } from './types'
import type { ScriptSandbox } from './script'
import { skipScriptExpression } from './scriptExpressions'
import { remainingCooldown } from './sessionState'
import type { CooldownCommand } from './sessionState'

export type TemplateContext = {
  state: PlaygroundState
  sender: FakeMember
  mentioned?: FakeMember
  content: string
  trigger: string
  options?: Record<string, string | number | boolean>
  script?: ScriptSandbox
  setVariable?: (name: string, value: string) => void
  command?: CooldownCommand
  trace?: string[]
}

export function evaluateTemplate(source: string, ctx: TemplateContext): string {
  if (typeof source !== 'string' || source.length > PLAYGROUND_LIMITS.template)
    throw new Error('Template exceeds the playground limit')
  const parsed = parse(source)
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => error.message).join('; '))
  let visited = 0
  const allowed = new Set([
    'name',
    'namePlain',
    'ID',
    'id',
    'globalName',
    'memberID',
    'memberEffectiveID',
    'memberEffectiveName',
    'memberNickname',
    'isBot',
    'server',
    'serverID',
    'channel',
    'channelID',
    'channelAsMention',
    'channelIsNSFW',
    'memberCount',
    'botName',
    'botNamePlain',
    'botID',
    'ping',
    'mentionedID',
    'mentionedName',
    'mentionedNamePlain',
    'mentionedMemberID',
    'memberRoles',
    'memberRoleCount',
    'memberIsOwner',
    'args',
    'option',
    'hasRole',
    'upper',
    'lower',
    'length',
    'replace',
    'random',
    'sum',
    'rollnum',
    'set',
    'get',
    'chat',
    'cooldownRemaining'
  ])
  // Inspect every AST branch before interpreting any value, including inactive branches.
  const preflightCondition = (node: ConditionNode, depth: number): void => {
    if (++visited > PLAYGROUND_LIMITS.nodes || depth > PLAYGROUND_LIMITS.depth)
      throw new Error('Template nesting or work exceeds the playground limit')
    if (node.type === 'value') preflight(node.nodes, depth + 1)
    else if (node.type === 'group') preflightCondition(node.expr, depth + 1)
    else if (node.type === 'unary') preflightCondition(node.operand, depth + 1)
    else {
      preflightCondition(node.left, depth + 1)
      preflightCondition(node.right, depth + 1)
    }
  }
  const preflight = (list: ASTNode[], depth: number): void => {
    if (depth > PLAYGROUND_LIMITS.depth)
      throw new Error('Template nesting exceeds the playground limit')
    for (const node of list) {
      if (++visited > PLAYGROUND_LIMITS.nodes)
        throw new Error('Template work exceeds the playground limit')
      if (node.type === NodeType.EVAL_BLOCK) {
        if (!ctx.script) throw new Error('Script sandbox is unavailable')
        // Match production: literal strings, comment text and template static parts stay literal.
        preflight(
          node.innerNodes.filter(
            (inner) =>
              inner.type !== NodeType.TEXT && !skipScriptExpression(node.code, inner.position)
          ),
          depth + 1
        )
      }
      if (node.type === NodeType.ERROR) throw new Error(node.message)
      if (
        (node.type === NodeType.VARIABLE || node.type === NodeType.FUNCTION_CALL) &&
        !allowed.has(node.name)
      )
        throw new Error(`Unsupported playground expression: $${node.name}. No effect was applied`)
      if (node.type === NodeType.FUNCTION_CALL)
        node.arguments.forEach((argument) => preflight(argument, depth + 1))
      if (node.type === NodeType.PROGRAM) preflight(node.children, depth + 1)
      if (node.type === NodeType.IF_BLOCK) {
        node.branches.forEach((branch) => {
          preflightCondition(branch.condition, depth + 1)
          preflight(branch.body, depth + 1)
        })
        preflight(node.elseBranch ?? [], depth + 1)
      }
    }
  }
  preflight(parsed.ast.children, 0)
  visited = 0
  const bounded = (value: string) => {
    if (value.length > PLAYGROUND_LIMITS.output)
      throw new Error('Output exceeds the playground limit')
    return value
  }
  const fn = (name: string, args: string[]): string => {
    const vars: Record<string, string> = {
      name: `<@${ctx.sender.id}>`,
      namePlain: ctx.sender.name,
      ID: ctx.sender.id,
      id: ctx.sender.id,
      globalName: ctx.sender.name,
      memberID: ctx.sender.id,
      memberEffectiveID: ctx.sender.id,
      memberEffectiveName: ctx.sender.name,
      memberNickname: '',
      isBot: 'false',
      server: ctx.state.guildName,
      serverID: ctx.state.guildId,
      channel: ctx.state.channelName,
      channelID: ctx.state.channelId,
      channelAsMention: `<#${ctx.state.channelId}>`,
      channelIsNSFW: String(ctx.state.nsfw),
      memberCount: String(
        ctx.state.members.filter((member) => !member.kicked && !member.banned).length
      ),
      botName: '<@900000000000000003>',
      botNamePlain: 'Playground Bot',
      botID: '900000000000000003',
      ping: '0',
      mentionedID: ctx.mentioned?.id ?? '',
      mentionedName: `<@${ctx.mentioned?.id ?? ''}>`,
      mentionedNamePlain: ctx.mentioned?.name ?? '',
      mentionedMemberID: ctx.mentioned?.id ?? '',
      memberRoles: ctx.state.roles
        .filter((role) => ctx.sender.roles.includes(role.id))
        .map((role) => role.name)
        .join(', '),
      memberRoleCount: String(ctx.sender.roles.length),
      memberIsOwner: String(ctx.sender.id === ctx.state.members[0]?.id)
    }
    if (Object.hasOwn(vars, name)) return vars[name]
    switch (name) {
      case 'set':
        if (!ctx.script) throw new Error('Script sandbox is unavailable')
        if (args.length >= 2) {
          if (ctx.setVariable) ctx.setVariable(args[0], args[1])
          else ctx.script.set(args[0], args[1])
        }
        return ''
      case 'get':
        if (!ctx.script) throw new Error('Script sandbox is unavailable')
        return args.length ? ctx.script.get(args[0]) : ''
      case 'chat':
        if (!args.length) return ''
        ctx.trace?.push('Simulated AI: configured local response/failure; no provider call')
        if (ctx.state.ai.error) throw new Error(`Simulated AI failure: ${ctx.state.ai.error}`)
        return ctx.state.ai.response
      case 'cooldownRemaining':
        return String(
          ctx.command ? remainingCooldown(ctx.state, ctx.command, ctx.sender.id, args[0]) : 0
        )
      case 'args':
        return (
          ctx.content.substring(ctx.trigger.length).trim().split(' ').filter(Boolean)[
            parseInt(args[0] ?? '0', 10)
          ] ?? ''
        )
      case 'option': {
        const value =
          ctx.options && Object.hasOwn(ctx.options, args[0]) ? ctx.options[args[0]] : undefined
        return value === undefined || value === null ? '' : String(value)
      }
      case 'hasRole': {
        const query = args[1]?.trim() ?? ''
        const roleId = /^<@&(\d+)>$/.exec(query)?.[1] ?? (/^\d+$/.test(query) ? query : '')
        const member = ctx.state.members.find(
          (item) => item.id === args[0]?.trim() && !item.kicked && !item.banned
        )
        if (!member) return 'false'
        if (roleId === ctx.state.guildId || query.toLowerCase() === '@everyone') return 'true'
        const role = ctx.state.roles.find((item) =>
          roleId ? item.id === roleId : item.name.toLowerCase() === query.toLowerCase()
        )
        return String(!!role && member.roles.includes(role.id))
      }
      case 'upper':
        return (args[0] ?? '').toUpperCase()
      case 'lower':
        return (args[0] ?? '').toLowerCase()
      case 'length':
        return String((args[0] ?? '').length)
      case 'replace': {
        const text = args[0] ?? '',
          find = args[1] ?? '',
          replacement = args[2] ?? ''
        if (!find) return text
        let count = 0,
          position = 0
        while ((position = text.indexOf(find, position)) !== -1) {
          count++
          position += find.length
        }
        const length = text.length + count * (replacement.length - find.length)
        if (length > PLAYGROUND_LIMITS.output)
          throw new Error('Output exceeds the playground limit')
        return text.split(find).join(replacement)
      }
      case 'random':
        return args[Math.floor(Math.random() * args.length)] ?? ''
      case 'sum': {
        const numbers = args.map((arg) => parseFloat(arg))
        const result = numbers.reduce((total, value) => total + value, 0)
        if (!Number.isFinite(result)) throw new Error('sum requires finite numbers')
        return String(result)
      }
      case 'rollnum': {
        const min = parseInt(args[0] ?? '0', 10),
          max = parseInt(args[1] ?? '100', 10)
        if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min)
          throw new Error('rollnum requires a bounded valid range')
        return String(Math.floor(Math.random() * (max - min + 1)) + min)
      }
      default:
        throw new Error(`Unsupported playground expression: $${name}. No effect was applied`)
    }
  }
  const nodes = (list: ASTNode[], depth: number): string => {
    if (depth > PLAYGROUND_LIMITS.depth)
      throw new Error('Template nesting exceeds the playground limit')
    let output = ''
    for (const node of list) {
      if (++visited > PLAYGROUND_LIMITS.nodes)
        throw new Error('Template work exceeds the playground limit')
      switch (node.type) {
        case NodeType.TEXT:
          output += node.value
          break
        case NodeType.PROGRAM:
          output += nodes(node.children, depth + 1)
          break
        case NodeType.VARIABLE:
          output += fn(node.name, [])
          break
        case NodeType.FUNCTION_CALL:
          output += bounded(
            fn(
              node.name,
              node.arguments.map((argument) => nodes(argument, depth + 1))
            )
          )
          break
        case NodeType.IF_BLOCK: {
          const branch = node.branches.find((item) => condition(item.condition, depth + 1))
          output += nodes(branch?.body ?? node.elseBranch ?? [], depth + 1)
          break
        }
        case NodeType.EVAL_BLOCK: {
          if (!ctx.script) throw new Error('Script sandbox is unavailable')
          const replacements: { position: number; length: number; name: string }[] = []
          let code = node.code
          let failed = false
          try {
            for (const inner of node.innerNodes) {
              if (inner.type === NodeType.TEXT || skipScriptExpression(node.code, inner.position))
                continue
              const name = ctx.script.temp(nodes([inner], depth + 1))
              replacements.push({ position: inner.position, length: inner.length, name })
            }
            for (const replacement of [...replacements].sort((a, b) => b.position - a.position))
              code =
                code.slice(0, replacement.position) +
                replacement.name +
                code.slice(replacement.position + replacement.length)
            output += bounded(ctx.script.evaluate(code))
          } catch (error) {
            failed = true
            throw error
          } finally {
            // Failed VMs are discarded by the command scope. Further operations on a
            // poisoned VM would mask the primary error with a cleanup error.
            if (!failed) for (const replacement of replacements) ctx.script.delete(replacement.name)
          }
          break
        }
        case NodeType.ERROR:
          throw new Error(node.message)
      }
      bounded(output)
    }
    return output
  }
  const conditionValue = (node: ConditionNode, depth: number): string | boolean => {
    if (++visited > PLAYGROUND_LIMITS.nodes || depth > PLAYGROUND_LIMITS.depth)
      throw new Error('Condition exceeds the playground limit')
    if (node.type === 'value') return nodes(node.nodes, depth + 1)
    if (node.type === 'group') return conditionValue(node.expr, depth + 1)
    if (node.type === 'unary') return !condition(node.operand, depth + 1)
    if (node.op === '&') return condition(node.left, depth + 1) && condition(node.right, depth + 1)
    if (node.op === '|') return condition(node.left, depth + 1) || condition(node.right, depth + 1)
    const left = conditionValue(node.left, depth + 1),
      right = conditionValue(node.right, depth + 1)
    if (node.op === '==') return String(left) === String(right)
    if (node.op === '!=') return String(left) !== String(right)
    if (node.op === '>') return parseFloat(String(left)) > parseFloat(String(right))
    if (node.op === '<') return parseFloat(String(left)) < parseFloat(String(right))
    if (node.op === '>=') return parseFloat(String(left)) >= parseFloat(String(right))
    return parseFloat(String(left)) <= parseFloat(String(right))
  }
  const condition = (node: ConditionNode, depth: number): boolean => {
    const value = conditionValue(node, depth)
    return typeof value === 'boolean' ? value : value !== '' && value !== 'false' && value !== '0'
  }
  return nodes(parsed.ast.children, 0)
}
