import type {
  BCFDEmbedMessageTemplate,
  BCFDInteractionAction,
  BCFDInteractionButton
} from '../../main/types/types'
import {
  AGENT_VALIDATION_LIMITS,
  type AgentValidationSuite,
  type AgentValidationJSON
} from '../agentValidationTypes'
import { validateSessionState } from './sessionState'
import { PLAYGROUND_LIMITS, type PlaygroundState } from './types'
import { PLAYGROUND_OPTION_NAME } from './optionName'

const FAKE_BOT_ID = '900000000000000003'

const ASSERTION_ROOTS = new Set(['outcome', 'reason', 'errors', 'state', 'effects'])

/** RFC 6901 string pointers, limited to the assertion view's supported roots. */
function isSupportedAssertionPointer(path: string): boolean {
  if (path[0] !== '/') return false
  const rootEnd = path.indexOf('/', 1)
  if (!ASSERTION_ROOTS.has(path.slice(1, rootEnd === -1 ? path.length : rootEnd))) return false
  // Every character is examined at most once. Empty tokens and literal slashes
  // are valid; only a tilde must be followed by the RFC's 0 or 1 escape.
  for (let index = rootEnd === -1 ? path.length : rootEnd; index < path.length; index++) {
    if (path[index] !== '~') continue
    const escape = path[++index]
    if (escape !== '0' && escape !== '1') return false
  }
  return true
}

/** Descriptor inspection precedes every field read/serialization. No getters/toJSON run. */
export function copyAgentValidationJSON(value: unknown, maxChars: number): AgentValidationJSON {
  let nodes = 0
  let textChars = 0
  const ancestors = new Set<object>()
  const copy = (item: unknown, depth: number): AgentValidationJSON => {
    if (++nodes > AGENT_VALIDATION_LIMITS.nodes || depth > AGENT_VALIDATION_LIMITS.depth)
      throw new Error('Validation JSON exceeds the nesting/work limit')
    if (item === null || typeof item === 'boolean') return item as null | boolean
    if (typeof item === 'string') {
      textChars += item.length
      if (textChars > maxChars) throw new Error('Validation JSON exceeds the size limit')
      return item
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item
    if (!item || typeof item !== 'object') throw new Error('Validation requires plain JSON values')
    if (ancestors.has(item)) throw new Error('Validation JSON must not contain cycles')
    const array = Array.isArray(item)
    const prototype = Object.getPrototypeOf(item)
    if (
      array
        ? prototype !== Array.prototype && prototype !== null
        : prototype !== Object.prototype && prototype !== null
    )
      throw new Error('Validation requires plain JSON objects')
    const descriptors = Object.getOwnPropertyDescriptors(item)
    const keys = Reflect.ownKeys(descriptors)
    const length = array ? (descriptors.length.value as number) : 0
    if (
      array &&
      (!Number.isSafeInteger(length) ||
        length > AGENT_VALIDATION_LIMITS.nodes ||
        keys.length !== length + 1)
    )
      throw new Error('Validation arrays must be dense and bounded')
    const output: AgentValidationJSON[] | { [key: string]: AgentValidationJSON } = array ? [] : {}
    ancestors.add(item)
    for (const key of keys) {
      if (array && key === 'length') continue
      if (typeof key !== 'string' || (array && (!/^(0|[1-9]\d*)$/.test(key) || +key >= length)))
        throw new Error('Validation JSON requires ordinary string/index keys')
      const entry = descriptors[key]
      if (!Object.hasOwn(entry, 'value') || !entry.enumerable)
        throw new Error('Validation JSON must not contain accessors or hidden properties')
      textChars += key.length
      if (textChars > maxChars) throw new Error('Validation JSON exceeds the size limit')
      Object.defineProperty(output, key, {
        value: copy(entry.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true
      })
    }
    ancestors.delete(item)
    return output
  }
  const result = copy(value, 0)
  if (JSON.stringify(result).length > maxChars)
    throw new Error('Validation JSON exceeds the size limit')
  return result
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${path} must be an object`)
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`${path} contains an unsupported field`)
}
function text(
  value: unknown,
  path: string,
  max: number,
  nonempty = false
): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()))
    throw new Error(`${path} must be bounded${nonempty ? ' nonempty' : ''} text`)
}
function flag(value: unknown, path: string): void {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean`)
}
function integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`${path} must be a bounded integer`)
}
function id(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
    throw new Error(`${path} must be a fake Discord ID`)
}
function array(value: unknown, path: string, max: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${path} must be a bounded array`)
}
function unique(values: unknown[], path: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`${path} contains duplicate IDs/values`)
}
function embed(value: unknown, path: string): void {
  const source = record(value, path)
  const names: (keyof BCFDEmbedMessageTemplate)[] = [
    'title',
    'description',
    'hexColor',
    'imageURL',
    'thumbnailURL',
    'footer'
  ]
  keys(source, names, path)
  for (const name of names) text(source[name], `${path}.${name}`, PLAYGROUND_LIMITS.template)
}

/** Used for fixture buttons too; their actions stay inert, but malformed trees are rejected. */
export function validateAgentValidationAction(value: unknown, path: string, depth = 0): void {
  if (depth > 8) throw new Error('Validation button tree exceeds the nesting limit')
  const source = record(value, path)
  const flags = [
    'sendChannelMessage',
    'sendPrivateMessage',
    'sendChannelEmbed',
    'sendPrivateEmbed',
    'isRoleAssigner',
    'isKick',
    'isBan',
    'isVoiceMute',
    'deleteX',
    'ephemeral',
    'deferReply'
  ]
  const strings = ['channelMessage', 'privateMessage', 'roleToAssign', 'targetUserOptionName']
  keys(source, [...flags, ...strings, 'channelEmbed', 'privateEmbed', 'deleteNum', 'buttons'], path)
  for (const name of flags) flag(source[name], `${path}.${name}`)
  for (const name of strings) text(source[name], `${path}.${name}`, PLAYGROUND_LIMITS.template)
  embed(source.channelEmbed, `${path}.channelEmbed`)
  embed(source.privateEmbed, `${path}.privateEmbed`)
  integer(source.deleteNum, `${path}.deleteNum`, 0, 100)
  array(source.buttons, `${path}.buttons`, 25)
  for (const button of source.buttons) validateButton(button, `${path}.buttons`, depth)
  unique(
    source.buttons.map((button) => (button as BCFDInteractionButton).customId),
    `${path}.buttons`
  )
}
function validateButton(value: unknown, path: string, depth: number): void {
  const source = record(value, path)
  keys(source, ['customId', 'label', 'style', 'emoji', 'url', 'disabled', 'action'], path)
  text(source.customId, `${path}.customId`, 100, true)
  text(source.label, `${path}.label`, PLAYGROUND_LIMITS.template)
  integer(source.style, `${path}.style`, 1, 5)
  flag(source.disabled, `${path}.disabled`)
  if (Object.hasOwn(source, 'emoji')) text(source.emoji, `${path}.emoji`, 100)
  if (Object.hasOwn(source, 'url')) text(source.url, `${path}.url`, PLAYGROUND_LIMITS.template)
  validateAgentValidationAction(source.action as BCFDInteractionAction, `${path}.action`, depth + 1)
}

export function validateAgentValidationState(value: unknown): PlaygroundState {
  const source = record(copyAgentValidationJSON(value, PLAYGROUND_LIMITS.stateBytes), 'state')
  keys(
    source,
    [
      'botState',
      'variables',
      'cooldowns',
      'clockMs',
      'ai',
      'guildId',
      'guildName',
      'channelId',
      'channelName',
      'nsfw',
      'members',
      'roles',
      'messages',
      'nextId'
    ],
    'state'
  )
  id(source.guildId, 'state.guildId')
  id(source.channelId, 'state.channelId')
  if (source.guildId === FAKE_BOT_ID || source.channelId === FAKE_BOT_ID)
    throw new Error('Fake guild/channel ID spoofs the simulated bot')
  if (source.guildId === source.channelId)
    throw new Error('Fake guild/channel IDs must be distinct')
  text(source.guildName, 'state.guildName', 100, true)
  text(source.channelName, 'state.channelName', 100, true)
  flag(source.nsfw, 'state.nsfw')
  const ai = record(source.ai, 'state.ai')
  keys(ai, ['response', 'error'], 'state.ai')
  array(source.members, 'state.members', PLAYGROUND_LIMITS.members)
  if (!source.members.length) throw new Error('Provide at least one explicit fake member')
  array(source.roles, 'state.roles', PLAYGROUND_LIMITS.roles)
  const roles = source.roles.map((value) => {
    const role = record(value, 'state.roles')
    keys(role, ['id', 'name'], 'state.roles')
    id(role.id, 'role.id')
    text(role.name, 'role.name', 100, true)
    if (role.id === source.channelId || role.id === FAKE_BOT_ID)
      throw new Error('Role ID spoofs the fake channel/bot')
    return role.id
  })
  unique(roles, 'state.roles')
  const members = source.members.map((value) => {
    const member = record(value, 'state.members')
    keys(member, ['id', 'name', 'roles', 'permissions', 'kicked', 'banned', 'muted'], 'member')
    id(member.id, 'member.id')
    if ([source.guildId, source.channelId, FAKE_BOT_ID, ...roles].includes(member.id))
      throw new Error('Member ID spoofs a fake role/channel/guild')
    text(member.name, 'member.name', 100, true)
    if (member.name === 'Playground Bot') throw new Error('Fake member name spoofs the bot')
    array(member.roles, 'member.roles', PLAYGROUND_LIMITS.roles)
    unique(member.roles, 'member.roles')
    if (member.roles.some((role) => role !== source.guildId && !roles.includes(role as string)))
      throw new Error('Member references an unknown fake role')
    array(member.permissions, 'member.permissions', 5)
    unique(member.permissions, 'member.permissions')
    if (
      member.permissions.some(
        (permission) =>
          !['admin', 'manageMessages', 'kick', 'ban', 'mute'].includes(permission as string)
      )
    )
      throw new Error('Unknown fake member permission')
    for (const name of ['kicked', 'banned', 'muted']) flag(member[name], `member.${name}`)
    return member
  })
  unique(
    members.map((member) => member.id),
    'state.members'
  )
  unique(
    members.map((member) => member.name),
    'state.members.names'
  )
  array(source.messages, 'state.messages', PLAYGROUND_LIMITS.messages)
  const messageIds: number[] = []
  for (const value of source.messages) {
    const message = record(value, 'message')
    keys(
      message,
      [
        'id',
        'author',
        'content',
        'kind',
        'recipient',
        'replyTo',
        'embed',
        'deleted',
        'ephemeral',
        'deferred',
        'buttons'
      ],
      'message'
    )
    integer(message.id, 'message.id', 1)
    messageIds.push(message.id as number)
    text(message.author, 'message.author', 100, true)
    text(message.content, 'message.content', PLAYGROUND_LIMITS.output)
    if (!['user', 'bot', 'dm'].includes(message.kind as string))
      throw new Error('Invalid fake message kind')
    if (message.kind === 'user' && !members.some((member) => member.name === message.author))
      throw new Error('Fake user message spoofs an unknown member')
    if (message.kind !== 'user' && message.author !== 'Playground Bot')
      throw new Error('Fake bot message must be authored by Playground Bot')
    for (const name of ['deleted', 'ephemeral', 'deferred'])
      if (Object.hasOwn(message, name)) flag(message[name], `message.${name}`)
    if (
      Object.hasOwn(message, 'recipient') &&
      !members.some((member) => member.id === message.recipient)
    )
      throw new Error('Message references an unknown fake recipient')
    if ((message.kind === 'dm' || message.ephemeral) && !Object.hasOwn(message, 'recipient'))
      throw new Error('Private fake messages require a recipient')
    if (
      message.kind === 'user' &&
      (message.recipient || message.ephemeral || message.deferred || message.buttons)
    )
      throw new Error('Fake user messages cannot spoof interaction responses')
    if (Object.hasOwn(message, 'replyTo')) integer(message.replyTo, 'message.replyTo', 1)
    if (Object.hasOwn(message, 'embed')) embed(message.embed, 'message.embed')
    if (Object.hasOwn(message, 'buttons')) {
      array(message.buttons, 'message.buttons', 5)
      for (const button of message.buttons) validateButton(button, 'message.buttons', 0)
      unique(
        message.buttons.map((button) => (button as BCFDInteractionButton).customId),
        'message.buttons'
      )
    }
  }
  unique(messageIds, 'state.messages')
  for (const value of source.messages) {
    const message = value as { id: number; replyTo?: number }
    if (
      message.replyTo !== undefined &&
      (!messageIds.includes(message.replyTo) || message.replyTo === message.id)
    )
      throw new Error('Message reply references an unknown/self fake message')
  }
  integer(source.nextId, 'state.nextId', 1, Number.MAX_SAFE_INTEGER - PLAYGROUND_LIMITS.messages)
  if (messageIds.some((messageId) => messageId >= (source.nextId as number)))
    throw new Error('Fake nextId must exceed every existing message ID')
  const state = source as PlaygroundState
  validateSessionState(state)
  if (JSON.stringify(state).length > PLAYGROUND_LIMITS.stateBytes)
    throw new Error('Fake state exceeds the size limit')
  return state
}

export function validateAgentValidationSuite(value: unknown): AgentValidationSuite {
  const suite = record(
    copyAgentValidationJSON(value, AGENT_VALIDATION_LIMITS.fixtureChars),
    'suite'
  )
  keys(suite, ['cases'], 'suite')
  array(suite.cases, 'suite.cases', AGENT_VALIDATION_LIMITS.cases)
  if (!suite.cases.length) throw new Error('Validation requires at least one explicit fixture case')
  let steps = 0,
    assertions = 0
  const names: string[] = []
  for (const value of suite.cases) {
    const item = record(value, 'case')
    keys(item, ['name', 'state', 'steps'], 'case')
    text(item.name, 'case.name', 100, true)
    names.push(item.name)
    const state = validateAgentValidationState(item.state)
    array(item.steps, 'case.steps', AGENT_VALIDATION_LIMITS.steps)
    if (!item.steps.length) throw new Error('Each validation case requires steps')
    steps += item.steps.length
    if (steps > AGENT_VALIDATION_LIMITS.steps)
      throw new Error('Validation exceeds the total step limit')
    for (const value of item.steps) {
      const step = record(value, 'step')
      keys(
        step,
        [
          'kind',
          'senderId',
          'content',
          'options',
          'customId',
          'messageId',
          'advanceClockMs',
          'assertions'
        ],
        'step'
      )
      if (!['message', 'slash', 'button'].includes(step.kind as string))
        throw new Error('Unsupported validation step kind')
      id(step.senderId, 'step.senderId')
      if (!state.members.some((member) => member.id === step.senderId))
        throw new Error('Step sender references an unknown fake member')
      if (Object.hasOwn(step, 'advanceClockMs'))
        integer(step.advanceClockMs, 'step.advanceClockMs', 0, 86_400_000)
      if (step.kind === 'message') {
        text(step.content, 'step.content', PLAYGROUND_LIMITS.input)
        if (['options', 'customId', 'messageId'].some((key) => Object.hasOwn(step, key)))
          throw new Error('Message step contains interaction fields')
      } else if (step.kind === 'slash') {
        if (['content', 'customId', 'messageId'].some((key) => Object.hasOwn(step, key)))
          throw new Error('Slash step contains unrelated fields')
        if (Object.hasOwn(step, 'options')) {
          const options = record(step.options, 'step.options')
          if (Object.keys(options).length > 25) throw new Error('Too many fixture slash options')
          for (const [name, value] of Object.entries(options)) {
            text(name, 'option.name', 64, true)
            if (!['string', 'number', 'boolean'].includes(typeof value))
              throw new Error('Fixture option must be a scalar')
            if (typeof value === 'string') text(value, 'option.value', 6000)
            if (typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER)
              throw new Error('Fixture option exceeds the number limit')
          }
        }
      } else {
        text(step.customId, 'step.customId', 100, true)
        integer(step.messageId, 'step.messageId', 1)
        if (['content', 'options'].some((key) => Object.hasOwn(step, key)))
          throw new Error('Button step contains unrelated fields')
      }
      array(step.assertions, 'step.assertions', AGENT_VALIDATION_LIMITS.assertionsPerStep)
      if (step.assertions.length < 2)
        throw new Error('Each step requires outcome and meaningful effect/error assertions')
      assertions += step.assertions.length
      if (assertions > AGENT_VALIDATION_LIMITS.assertions)
        throw new Error('Too many validation assertions')
      let outcome = false,
        meaningful = false,
        expectedNegative = false,
        effectAssertion = false,
        intendedDenial = false
      const paths: string[] = []
      for (const value of step.assertions) {
        const assertion = record(value, 'assertion')
        keys(assertion, ['path', 'equals'], 'assertion')
        text(assertion.path, 'assertion.path', 300, true)
        if (!Object.hasOwn(assertion, 'equals')) throw new Error('Assertion requires equals')
        if (!isSupportedAssertionPointer(assertion.path))
          throw new Error('Assertion requires a supported JSON Pointer path')
        paths.push(assertion.path)
        if (JSON.stringify(assertion.equals).length > AGENT_VALIDATION_LIMITS.assertionValueChars)
          throw new Error('Assertion expected value exceeds the size limit')
        if (assertion.path === '/outcome') {
          if (
            !['executed', 'blocked', 'error', 'unmatched', 'unsupported', 'not_run'].includes(
              assertion.equals as string
            )
          )
            throw new Error('Outcome assertion requires an execution outcome')
          outcome = true
          expectedNegative = assertion.equals === 'blocked' || assertion.equals === 'error'
        }
        if (
          assertion.path.startsWith('/effects/') ||
          (assertion.path.startsWith('/errors/') &&
            !(assertion.path === '/errors/length' && assertion.equals === 0))
        )
          meaningful = true
        if (assertion.path.startsWith('/effects/')) effectAssertion = true
        if (
          (assertion.path === '/reason' || /^\/errors\/(0|[1-9]\d*)$/.test(assertion.path)) &&
          typeof assertion.equals === 'string' &&
          assertion.equals.trim().length > 0
        )
          intendedDenial = true
      }
      unique(paths, 'assertion paths')
      if (!outcome || !meaningful)
        throw new Error('Each step requires /outcome and meaningful effect/error assertions')
      if (expectedNegative && (!effectAssertion || !intendedDenial))
        throw new Error(
          'Expected denial/error requires effects and a specific /reason or /errors/N assertion'
        )
    }
  }
  unique(names, 'case names')
  return suite as AgentValidationSuite
}

/** Validate normalized candidate data without reading saved/live resources. */
export function validateAgentValidationCandidate(
  kind: 'command' | 'interaction',
  value: unknown
): void {
  const source = record(
    copyAgentValidationJSON(value, AGENT_VALIDATION_LIMITS.candidateChars),
    'candidate'
  )
  text(source.id, 'candidate.id', 100, true)
  if (Object.hasOwn(source, 'cooldown')) integer(source.cooldown, 'candidate.cooldown', 0, 86_400)
  if (Object.hasOwn(source, 'cooldownType')) {
    text(source.cooldownType, 'candidate.cooldownType', 100)
    if (
      source.cooldownType &&
      !['user', 'server', 'global'].includes((source.cooldownType as string).toLowerCase())
    )
      throw new Error('Invalid candidate cooldown scope')
  }
  if (kind === 'command') {
    keys(
      source,
      [
        'id',
        'channelMessage',
        'command',
        'commandDescription',
        'deleteAfter',
        'deleteIfStrings',
        'deleteNum',
        'ignoreErrorMessage',
        'isBan',
        'isKick',
        'isNSFW',
        'requiredRole',
        'isVoiceMute',
        'isAdmin',
        'phrase',
        'privateMessage',
        'reaction',
        'roleToAssign',
        'specificChannel',
        'specificMessage',
        'startsWith',
        'type',
        'channelEmbed',
        'privateEmbed',
        'cooldown',
        'cooldownType',
        'cooldownMessage',
        'channelMessageAsReply',
        'channelEmbedAsReply',
        'channelMessageTyping',
        'channelEmbedTyping',
        'channelWhitelist',
        'serverWhitelist'
      ],
      'candidate'
    )
    integer(source.type, 'candidate.type', 0, 5)
    integer(source.deleteNum, 'candidate.deleteNum', 0, 100)
    embed(source.channelEmbed, 'candidate.channelEmbed')
    embed(source.privateEmbed, 'candidate.privateEmbed')
  } else {
    keys(
      source,
      [
        'id',
        'commandName',
        'commandDescription',
        'options',
        'rootAction',
        'isRegistered',
        'guildId',
        'cooldown',
        'cooldownType',
        'cooldownMessage'
      ],
      'candidate'
    )
    validateAgentValidationAction(source.rootAction, 'candidate.rootAction')
    array(source.options, 'candidate.options', 25)
    const names: string[] = []
    for (const value of source.options) {
      const option = record(value, 'candidate.option')
      keys(option, ['name', 'description', 'type', 'required', 'choices'], 'candidate.option')
      text(option.name, 'candidate.option.name', 64, true)
      if (!PLAYGROUND_OPTION_NAME.test(option.name))
        throw new Error('Invalid candidate option name')
      names.push(option.name.toLowerCase())
      text(option.description, 'candidate.option.description', 100)
      flag(option.required, 'candidate.option.required')
      if (![3, 4, 5, 6, 7, 8, 10].includes(option.type as number))
        throw new Error('Unsupported candidate option type')
      if (Object.hasOwn(option, 'choices')) {
        array(option.choices, 'candidate.option.choices', 25)
        if (option.choices.length && ![3, 4, 10].includes(option.type as number))
          throw new Error('Candidate option choices require string/integer/number type')
        const choiceNames: string[] = [],
          choiceValues: unknown[] = []
        for (const value of option.choices) {
          const choice = record(value, 'candidate.choice')
          keys(choice, ['name', 'value'], 'candidate.choice')
          text(choice.name, 'candidate.choice.name', 100, true)
          choiceNames.push(choice.name)
          choiceValues.push(choice.value)
          if (option.type === 3) text(choice.value, 'candidate.choice.value', 6000, true)
          else if (option.type === 4)
            integer(choice.value, 'candidate.choice.value', -Number.MAX_SAFE_INTEGER)
          else if (
            typeof choice.value !== 'number' ||
            !Number.isFinite(choice.value) ||
            Math.abs(choice.value) > Number.MAX_SAFE_INTEGER
          )
            throw new Error('Candidate choice requires a bounded number')
        }
        unique(choiceNames, 'candidate.choice.names')
        unique(choiceValues, 'candidate.choice.values')
      }
    }
    unique(names, 'candidate.option.names')
  }
  for (const [name, value] of Object.entries(source))
    if (typeof value === 'string') text(value, `candidate.${name}`, PLAYGROUND_LIMITS.template)
}
