import crypto from 'node:crypto'
import type { BCFDCommand } from '../types/types'
import type { AgentValidationJSON, AgentValidationReport } from '../../shared/agentValidationTypes'
import { AGENT_VALIDATION_LIMITS } from '../../shared/agentValidationTypes'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { hasEmbedContent, hasText } from '../../shared/commandCapabilities'
import {
  copyAgentValidationJSON,
  validateAgentValidationCandidate,
  validateAgentValidationSuite
} from '../../shared/playground/agentValidationFixtures'
import type { PreparedMutation } from './agentTools'
import { Parser } from './bcfdLang/parser'
import { NodeType, type ASTNode, type ConditionNode } from './bcfdLang/types'
import { resourceRevision } from './resourceChangeService'
import { getSettings } from './settingsService'

export const AUTO_ELIGIBILITY_EFFECT_VERSION = 'response-only-bcfd-v1'
export type AutoEligibility = { eligible: boolean; reasonCode: string }

// Audited against createFunctionRegistry in bcfdLang/interpreter.ts. These names
// only format strings/numbers or read the current message's already-loaded context.
// This is deliberately host-owned, not metadata supplied by a model or fixture.
// New registry entries are manual until audited and added here. In particular,
// no eval, persistent variables/state, AI, fetches, random/clock or Discord writes.
const CONTEXT_NAMES = new Set([
  'namePlain',
  'name',
  'discriminator',
  'tag',
  'ID',
  'id',
  'isBot',
  'globalName',
  'memberIsOwner',
  'memberEffectiveName',
  'memberNickname',
  'memberID',
  'memberEffectiveTag',
  'memberEffectiveID',
  'memberColor',
  'memberRoles',
  'memberRoleCount',
  'server',
  'serverDescription',
  'serverID',
  'memberCount',
  'channel',
  'channelID',
  'channelAsMention',
  'channelTopic',
  'channelIsNSFW',
  'mentionedName',
  'mentionedID',
  'mentionedTag',
  'mentionedDiscriminator',
  'mentionedNamePlain',
  'mentionedIsBot',
  'mentionedGlobalName',
  'mentionedMemberIsOwner',
  'mentionedMemberEffectiveName',
  'mentionedMemberNickname',
  'mentionedMemberID',
  'mentionedMemberEffectiveTag',
  'mentionedMemberEffectiveID',
  'mentionedMemberColor',
  'mentionedMemberRoles',
  'mentionedMemberRoleCount',
  'message',
  'messageAfterCommand',
  'argsCount',
  'pi'
])
const PURE_FUNCTION_NAMES = new Set([
  'wordCount',
  'sum',
  'calculate',
  'sub',
  'mul',
  'div',
  'mod',
  'round',
  'floor',
  'ceil',
  'abs',
  'toFixed',
  'min',
  'max',
  'clamp',
  'pow',
  'sqrt',
  'log',
  'isNumber',
  'args',
  'cropText',
  'linesCount',
  'toTitleCase',
  'numberSeparator',
  'isBoolean',
  'isInteger',
  'isValidHex',
  'upper',
  'lower',
  'length',
  'replace',
  'substring',
  'trim',
  'repeat',
  'contains',
  'startsWith',
  'endsWith',
  'channelMention'
])
const SCOPE_FIELDS: (keyof BCFDCommand)[] = [
  'command',
  'type',
  'phrase',
  'startsWith',
  'isAdmin',
  'isNSFW',
  'requiredRole',
  'specificChannel',
  'specificMessage',
  'channelWhitelist',
  'serverWhitelist',
  'ignoreErrorMessage',
  'cooldown',
  'cooldownType'
]
const deny = (reasonCode: string): AutoEligibility => ({ eligible: false, reasonCode })
const allow = (reasonCode: string): AutoEligibility => ({ eligible: true, reasonCode })
const hash = (value: unknown): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex')

function equal(left: AgentValidationJSON, right: AgentValidationJSON): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  )
}

function identifier(char: string | undefined): boolean {
  if (!char) return false
  const code = char.charCodeAt(0)
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    char === '_'
  )
}

/**
 * The existing tokenizer repairs unmatched function delimiters, and its condition
 * lexer cannot advance over a lone '='. Bound/check that syntax before Parser runs.
 * This is a delimiter/grammar check, never a regex-based effect classifier.
 */
function syntaxPreflight(source: string): string | undefined {
  const delimiters: string[] = []
  let ifDepth = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\\' && delimiters.length) {
      index++
      continue
    }
    if (char === '$') {
      if (source[index + 1] === '$') {
        index++
        continue
      }
      let end = index + 1
      while (identifier(source[end])) end++
      const name = source.slice(index + 1, end)
      // The production tokenizer treats even $eval-prefixed identifiers as eval.
      if (name.startsWith('eval')) return 'template_effect'
      if (name === 'if' && source[end] === '(' && ++ifDepth > 32) return 'template_syntax'
      if (name === 'endif') ifDepth--
      if ((name === 'if' || name === 'elseif') && source[end] === '(') {
        if (!validConditionEquals(source, end)) return 'template_syntax'
      }
      if (source[end] === '(' || source[end] === '{') {
        delimiters.push(source[end] === '(' ? ')' : '}')
        if (delimiters.length > 32) return 'template_syntax'
        index = end
        continue
      }
    }
    if (!delimiters.length) continue
    if (char === '(' || char === '{') delimiters.push(char === '(' ? ')' : '}')
    else if (char === ')' || char === '}') {
      if (delimiters.pop() !== char) return 'template_syntax'
    }
    if (delimiters.length > 32) return 'template_syntax'
  }
  return delimiters.length ? 'template_syntax' : undefined
}

function validConditionEquals(source: string, start: number): boolean {
  let depth = 1
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index]
    if (char === '$') {
      if (source[index + 1] === '$') {
        index++
        continue
      }
      let end = index + 1
      while (identifier(source[end])) end++
      // Function argument literals aren't condition operators. The production
      // condition tokenizer consumes the entire balanced BCFD expression.
      if (source[end] === '(' || source[end] === '{') {
        const open = source[end],
          close = open === '(' ? ')' : '}'
        let nested = 1
        for (index = end + 1; index < source.length && nested; index++) {
          if (source[index] === '\\') index++
          else if (source[index] === open) nested++
          else if (source[index] === close) nested--
        }
        if (nested) return false
        index--
        continue
      }
    }
    if (char === '(') depth++
    else if (char === ')' && --depth === 0) return true
    else if (char === '=') {
      if (source[index + 1] === '=') index++
      else if (!['!', '<', '>'].includes(source[index - 1])) return false
    }
  }
  return false
}

function inspectTemplate(source: string, literal = false): string | undefined {
  // Each nested argument parse removes one layer of backslash escapes. Check
  // those possible parser inputs too, before an escaped condition can reach it.
  let syntaxSource = source
  for (let depth = 0; ; depth++) {
    const syntax = syntaxPreflight(syntaxSource)
    if (syntax) return syntax
    let unescaped = ''
    for (let index = 0; index < syntaxSource.length; index++) {
      if (syntaxSource[index] === '\\' && index + 1 < syntaxSource.length) index++
      unescaped += syntaxSource[index]
    }
    if (unescaped === syntaxSource) break
    if (depth >= AGENT_VALIDATION_LIMITS.depth) return 'template_syntax'
    syntaxSource = unescaped
  }
  const parsed = new Parser().parse(source)
  if (parsed.errors.length) return 'template_syntax'
  let visited = 0
  const bounded = (depth: number): boolean =>
    ++visited <= AGENT_VALIDATION_LIMITS.nodes && depth <= AGENT_VALIDATION_LIMITS.depth
  const condition = (node: ConditionNode, depth: number): boolean => {
    if (!bounded(depth)) return false
    switch (node.type) {
      case 'value':
        return nodes(node.nodes, depth + 1)
      case 'group':
        return condition(node.expr, depth + 1)
      case 'unary':
        return condition(node.operand, depth + 1)
      case 'binary':
        return condition(node.left, depth + 1) && condition(node.right, depth + 1)
      default:
        return false
    }
  }
  const nodes = (list: ASTNode[], depth: number): boolean =>
    list.every((node) => {
      if (!bounded(depth)) return false
      if (node.type === NodeType.TEXT) return true
      if (literal) return false
      switch (node.type) {
        case NodeType.PROGRAM:
          return nodes(node.children, depth + 1)
        case NodeType.VARIABLE:
          return CONTEXT_NAMES.has(node.name)
        case NodeType.FUNCTION_CALL:
          return (
            (CONTEXT_NAMES.has(node.name) || PURE_FUNCTION_NAMES.has(node.name)) &&
            node.arguments.every((argument) => nodes(argument, depth + 1))
          )
        case NodeType.IF_BLOCK:
          return (
            node.branches.every(
              (branch) => condition(branch.condition, depth + 1) && nodes(branch.body, depth + 1)
            ) &&
            (!node.elseBranch || nodes(node.elseBranch, depth + 1))
          )
        // EVAL_BLOCK, ERROR and future AST nodes always need manual review.
        default:
          return false
      }
    })
  return nodes(parsed.ast.children, 0) ? undefined : 'template_effect'
}

function readCommand(value: unknown): BCFDCommand {
  const safe = copyAgentValidationJSON(value, AGENT_VALIDATION_LIMITS.candidateChars)
  validateAgentValidationCandidate('command', safe)
  return decodeBCFDCommand(safe).command
}

function commandReason(command: BCFDCommand): string | undefined {
  if (command.type !== 0) return 'command_event'
  if (
    !command.command.trim() ||
    command.command.trim() === '*' ||
    command.phrase ||
    inspectTemplate(command.command, true)
  )
    return 'trigger_scope'
  if (
    command.deleteAfter ||
    command.deleteNum !== 0 ||
    command.deleteIfStrings ||
    command.isBan ||
    command.isKick ||
    command.isVoiceMute ||
    command.roleToAssign ||
    command.reaction ||
    command.specificChannel ||
    command.privateMessage ||
    Object.values(command.privateEmbed).some((field) => field !== '') ||
    (command.cooldown ?? 0) !== 0 ||
    command.channelEmbed.imageURL ||
    command.channelEmbed.thumbnailURL
  )
    return 'command_effect'
  for (const template of [
    command.channelMessage,
    command.channelEmbed.title,
    command.channelEmbed.description,
    command.channelEmbed.hexColor,
    command.channelEmbed.footer,
    command.cooldownMessage ?? ''
  ]) {
    const reason = inspectTemplate(template)
    if (reason) return reason
  }
  if (!hasText(command.channelMessage) && !hasEmbedContent(command.channelEmbed))
    return 'command_effect'
  return undefined
}

function validationReason(
  prepared: PreparedMutation,
  validation: AgentValidationReport | undefined
): string | undefined {
  if (!validation || prepared.arguments.validation === undefined) return 'validation_required'
  const suite = validateAgentValidationSuite(prepared.arguments.validation)
  const report = copyAgentValidationJSON(
    validation,
    AGENT_VALIDATION_LIMITS.reportChars
  ) as unknown as AgentValidationReport
  if (
    report.version !== 1 ||
    report.candidateKind !== 'command' ||
    report.candidateId !== prepared.target.id ||
    report.candidateHash !== hash(prepared.after) ||
    report.baseRevision !== (prepared.before === null ? null : resourceRevision(prepared.before)) ||
    report.fixtureHash !== hash(suite) ||
    report.wrapEvalInIIFE !== !getSettings().useLegacyInterpreter
  )
    return 'validation_stale'
  if (
    report.outcome !== 'passed' ||
    report.timedOut !== false ||
    report.cancelled !== false ||
    report.truncated !== false ||
    !Array.isArray(report.cases) ||
    report.cases.length !== suite.cases.length ||
    report.coverage.executed <= 0 ||
    report.coverage.errors !== 0 ||
    report.coverage.unmatched !== 0 ||
    report.coverage.unsupported !== 0 ||
    report.coverage.notRun !== 0
  )
    return 'validation_incomplete'
  let executed = 0,
    matched = 0,
    blocked = 0
  for (let caseIndex = 0; caseIndex < suite.cases.length; caseIndex++) {
    const fixture = suite.cases[caseIndex],
      result = report.cases[caseIndex]
    if (
      result.name !== fixture.name ||
      result.outcome !== 'passed' ||
      !Array.isArray(result.steps) ||
      result.steps.length !== fixture.steps.length
    )
      return 'validation_incomplete'
    for (let index = 0; index < fixture.steps.length; index++) {
      const step = result.steps[index],
        expected = fixture.steps[index]
      if (
        expected.kind !== 'message' ||
        step.kind !== 'message' ||
        step.index !== index ||
        step.outcome !== 'passed' ||
        step.matched !== true ||
        !Array.isArray(step.errors) ||
        step.errors.length ||
        step.timedOut !== false ||
        step.cancelled !== false ||
        step.truncated !== false ||
        !Array.isArray(step.assertions) ||
        step.assertions.length !== expected.assertions.length ||
        step.assertions.length < 2
      )
        return 'validation_incomplete'
      if (
        step.executionOutcome === 'executed' &&
        step.executed === true &&
        step.expectedNegative === false
      )
        executed++
      else if (
        step.executionOutcome === 'blocked' &&
        step.expectedNegative === true &&
        step.executed === false
      )
        blocked++
      else return 'validation_incomplete'
      matched++
      for (let assertionIndex = 0; assertionIndex < expected.assertions.length; assertionIndex++) {
        const assertion = step.assertions[assertionIndex],
          input = expected.assertions[assertionIndex]
        if (
          assertion.path !== input.path ||
          !equal(assertion.expected, input.equals) ||
          assertion.passed !== true ||
          assertion.actualPresent !== true ||
          !equal(assertion.actual, assertion.expected)
        )
          return 'validation_incomplete'
      }
      const effects = step.effects
      if (
        ![
          effects.deletedMessageIds,
          effects.memberChanges,
          effects.botStateChanges,
          effects.variableChanges,
          effects.cooldownChanges,
          effects.messages
        ].every(Array.isArray) ||
        effects.deletedMessageIds.length ||
        effects.memberChanges.length ||
        effects.botStateChanges.length ||
        effects.variableChanges.length ||
        effects.cooldownChanges.length ||
        effects.messages.some(
          (message) =>
            message.kind !== 'bot' ||
            message.recipient ||
            message.deleted ||
            message.ephemeral ||
            message.buttons?.length ||
            message.embed?.imageURL ||
            message.embed?.thumbnailURL
        )
      )
        return 'validation_incomplete'
    }
  }
  return report.coverage.executed === executed &&
    report.coverage.matched === matched &&
    report.coverage.blocked === blocked
    ? undefined
    : 'validation_incomplete'
}

/** Deterministic eligibility only. Enrollment, privacy and model decisions are separate gates. */
export function checkAutoEligibility(
  prepared: PreparedMutation,
  validation?: AgentValidationReport
): AutoEligibility {
  if (
    prepared.target.type === 'memory' &&
    (prepared.name === 'create_memory' || prepared.name === 'edit_memory')
  )
    return allow('eligible_memory')
  if (
    prepared.target.type !== 'command' ||
    !['create_command', 'edit_command'].includes(prepared.name)
  )
    return deny('manual_mutation')
  try {
    const after = readCommand(prepared.after)
    if (after.id !== prepared.target.id) return deny('invalid_candidate')
    const afterReason = commandReason(after)
    if (afterReason) return deny(afterReason)
    if (prepared.name === 'create_command') {
      if (prepared.before !== null) return deny('invalid_candidate')
      if (after.startsWith) return deny('trigger_scope')
    } else {
      const before = readCommand(prepared.before)
      if (before.id !== after.id) return deny('invalid_candidate')
      const beforeReason = commandReason(before)
      if (beforeReason) return deny(beforeReason)
      // Equality is the conservative deterministic proof of no widened scope.
      if (SCOPE_FIELDS.some((field) => before[field] !== after[field]))
        return deny('changed_command_scope')
    }
    const reason = validationReason(prepared, validation)
    return reason ? deny(reason) : allow('eligible_response_command')
  } catch {
    // Unsupported syntax/shape/evidence never disables reviewed Auto globally.
    return deny('invalid_candidate')
  }
}
