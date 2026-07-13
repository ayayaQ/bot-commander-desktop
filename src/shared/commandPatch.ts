export type CommandPatchValue =
  | string
  | number
  | boolean
  | Record<string, unknown>
  | unknown[]
  | null

export interface CommandPatchChange {
  field: string
  value: CommandPatchValue
  reason?: string
}

export interface DiffChange {
  field: string
  fieldLabel: string
  oldValue: unknown
  newValue: unknown
  reason?: string
}

export interface CommandDiff<TCommand extends object = any> {
  before: TCommand
  after: TCommand
  changes: DiffChange[]
}

type FieldKind = 'string' | 'number' | 'boolean' | 'embed'

interface FieldDefinition {
  label: string
  kind: FieldKind
}

const embedFields = ['title', 'description', 'hexColor', 'imageURL', 'thumbnailURL', 'footer']

const fieldDefinitions: Record<string, FieldDefinition> = {
  command: { label: 'Command', kind: 'string' },
  commandDescription: { label: 'Description', kind: 'string' },
  type: { label: 'Command Type', kind: 'number' },
  channelMessage: { label: 'Channel Message', kind: 'string' },
  privateMessage: { label: 'Private Message', kind: 'string' },
  channelEmbed: { label: 'Channel Embed', kind: 'embed' },
  privateEmbed: { label: 'Private Embed', kind: 'embed' },
  specificChannel: { label: 'Send in Specific Channel', kind: 'string' },
  channelWhitelist: { label: 'Channel Whitelist', kind: 'string' },
  serverWhitelist: { label: 'Server Whitelist', kind: 'string' },
  reaction: { label: 'Reaction', kind: 'string' },
  deleteIfStrings: { label: 'Delete If Contains', kind: 'string' },
  deleteAfter: { label: 'Delete After', kind: 'boolean' },
  deleteNum: { label: 'Delete Count', kind: 'number' },
  roleToAssign: { label: 'Role to Assign', kind: 'string' },
  requiredRole: { label: 'Required Role', kind: 'string' },
  specificMessage: { label: 'Specific Message', kind: 'string' },
  ignoreErrorMessage: { label: 'Ignore Error Message', kind: 'boolean' },
  isKick: { label: 'Is Kick', kind: 'boolean' },
  isBan: { label: 'Is Ban', kind: 'boolean' },
  isVoiceMute: { label: 'Is Voice Mute', kind: 'boolean' },
  isAdmin: { label: 'Admin Only', kind: 'boolean' },
  phrase: { label: 'Phrase', kind: 'boolean' },
  startsWith: { label: 'Starts With', kind: 'boolean' },
  isNSFW: { label: 'NSFW Only', kind: 'boolean' },
  channelMessageAsReply: { label: 'Channel Message as Reply', kind: 'boolean' },
  channelEmbedAsReply: { label: 'Channel Embed as Reply', kind: 'boolean' },
  channelMessageTyping: { label: 'Channel Message Typing', kind: 'boolean' },
  channelEmbedTyping: { label: 'Channel Embed Typing', kind: 'boolean' },
  cooldown: { label: 'Cooldown', kind: 'number' },
  cooldownType: { label: 'Cooldown Type', kind: 'string' },
  cooldownMessage: { label: 'Cooldown Message', kind: 'string' }
}

for (const embedType of ['channelEmbed', 'privateEmbed']) {
  for (const field of embedFields) {
    fieldDefinitions[`${embedType}.${field}`] = {
      label: `${fieldDefinitions[embedType].label} ${field}`,
      kind: 'string'
    }
  }
}

export const editableCommandFields = Object.freeze(Object.keys(fieldDefinitions))

export function getCommandFieldLabel(field: string): string {
  return fieldDefinitions[field]?.label || field
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as T
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function validateValue(field: string, value: CommandPatchValue): string | null {
  const definition = fieldDefinitions[field]
  if (!definition) return `Unknown command field "${field}"`
  if (value === null) return `Field "${field}" cannot be null`

  if (definition.kind === 'embed') {
    if (!isPlainObject(value)) return `Field "${field}" must be an object`
    const invalidEmbedField = Object.keys(value).find((key) => !embedFields.includes(key))
    if (invalidEmbedField) return `Unknown embed field "${field}.${invalidEmbedField}"`
    return null
  }

  if (typeof value !== definition.kind) {
    return `Field "${field}" must be a ${definition.kind}`
  }
  return null
}

function setField(command: Record<string, unknown>, field: string, value: CommandPatchValue): void {
  if (field.includes('.')) {
    const [parent, child] = field.split('.')
    command[parent] = {
      ...((isPlainObject(command[parent]) ? command[parent] : {}) as Record<string, unknown>),
      [child]: value
    }
    return
  }

  if ((field === 'channelEmbed' || field === 'privateEmbed') && isPlainObject(value)) {
    command[field] = {
      ...((isPlainObject(command[field]) ? command[field] : {}) as Record<string, unknown>),
      ...value
    }
    return
  }

  command[field] = cloneValue(value)
}

function normalizeDerivedFields(
  command: Record<string, unknown>,
  touchedFields: Set<string>
): void {
  if (touchedFields.has('cooldown')) {
    const cooldown = typeof command.cooldown === 'number' ? command.cooldown : 0
    if (cooldown <= 0) {
      command.cooldown = 0
      command.cooldownType = ''
      command.cooldownMessage = ''
    } else if (!String(command.cooldownType || '').trim()) {
      command.cooldownType = 'User'
    }
  }
}

export function applyCommandPatch<TCommand extends object>(
  before: TCommand,
  changes: CommandPatchChange[] = []
): { command: TCommand; diff: CommandDiff<TCommand>; warnings: string[] } {
  const command = cloneValue(before)
  const warnings: string[] = []
  const touchedFields = new Set<string>()
  const reasons = new Map<string, string>()

  for (const change of changes) {
    const field = String(change.field || '')
    const warning = validateValue(field, change.value)
    if (warning) {
      warnings.push(warning)
      continue
    }
    setField(command as Record<string, unknown>, field, change.value)
    touchedFields.add(field)
    if (change.reason) reasons.set(field, change.reason)
  }

  normalizeDerivedFields(command as Record<string, unknown>, touchedFields)

  return {
    command,
    diff: generateCommandDiff(before, command, reasons),
    warnings
  }
}

export function generateCommandDiff<TCommand extends object>(
  before: TCommand,
  after: TCommand,
  reasons: Map<string, string> = new Map()
): CommandDiff<TCommand> {
  const changes: DiffChange[] = []

  for (const field of editableCommandFields) {
    const beforeValue = getFieldValue(before as Record<string, unknown>, field)
    const afterValue = getFieldValue(after as Record<string, unknown>, field)
    if (!valuesEqual(beforeValue, afterValue)) {
      changes.push({
        field,
        fieldLabel: getCommandFieldLabel(field),
        oldValue: beforeValue,
        newValue: afterValue,
        reason: reasons.get(field)
      })
    }
  }

  return { before, after, changes }
}

function getFieldValue(command: Record<string, unknown>, field: string): unknown {
  if (!field.includes('.')) return command[field]
  const [parent, child] = field.split('.')
  const parentValue = command[parent]
  return isPlainObject(parentValue) ? parentValue[child] : undefined
}
