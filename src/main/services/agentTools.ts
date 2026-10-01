import crypto from 'node:crypto'
import type { BCFDCommand, BCFDInteractionAction, BCFDInteractionCommand } from '../types/types'
import type {
  AgentLintDiagnostic,
  AgentMemory,
  AgentPatchOperation
} from '../../shared/agentTypes'
import { createPlaygroundState } from '../../shared/playground/types'
import { lintBCFD } from '../../shared/bcfdLint'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { getCommands, setCommands } from './botService'
import { getInteractions, setInteractions } from './interactionService'
import { getSettings, setSettings } from './settingsService'
import { saveCommands, saveInteractions, saveSettings } from './fileService'
import {
  readDocumentation,
  searchDocumentation,
  type DocumentationCategory
} from './documentationService'
import {
  readBotState,
  withBotStateTransaction,
  getStartupJs,
  updateStartupJsAndRestart
} from '../utils/virtual'
import {
  getRendererConsoleEntries,
  type ConsoleMessageType
} from '../utils/rendererConsole'
import {
  agentMemoryRevision,
  commitMemoryMutation,
  loadAgentMemories,
  prepareCreateMemory,
  prepareDeleteMemory,
  prepareUpdateMemory
} from './agentMemoryService'
import type { ResourceChangeKind, ResourceChangeSource } from '../../shared/mcpTypes'
import {
  emitResourceChanged,
  resourceRevision,
  withResourceMutationLock
} from './resourceChangeService'

export interface PreparedMutation {
  name: string
  arguments: Record<string, unknown>
  before: unknown
  after: unknown
  target: { type: string; id?: string }
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
})

// Fixtures and expected outcomes are explicit inputs, never inferred from saved/live state.
const validationSchema = objectSchema(
  {
    cases: {
      type: 'array',
      minItems: 1,
      maxItems: 6,
      items: objectSchema(
        {
          name: { type: 'string', maxLength: 80 },
          state: {
            type: 'object',
            description:
              'Complete fake state from read_validation_fixture, with deliberate test changes. No live state is loaded.'
          },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: objectSchema(
              {
                kind: { type: 'string', enum: ['message', 'slash', 'button'] },
                senderId: { type: 'string' },
                content: { type: 'string' },
                options: { type: 'object' },
                customId: { type: 'string' },
                messageId: { type: 'integer' },
                advanceClockMs: { type: 'integer', minimum: 0 },
                assertions: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 8,
                  items: objectSchema({ path: { type: 'string' }, equals: {} }, ['path', 'equals'])
                }
              },
              ['kind', 'senderId', 'assertions']
            )
          }
        },
        ['name', 'state', 'steps']
      )
    }
  },
  ['cases']
)

const patchSchema = {
  type: 'array',
  items: objectSchema(
    {
      op: { type: 'string', enum: ['add', 'replace', 'remove'] },
      path: { type: 'string', description: 'JSON Pointer path such as /channelMessage' },
      value: {}
    },
    ['op', 'path']
  )
}

export const agentToolDefinitions: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_documentation',
      description: 'Search bundled Bot Commander help for commands, fields, BCFD keywords and syntax, tutorials, interactions, setup, and webhooks. Returns the best matching content plus compact alternatives; short exact names or phrases work best.',
      parameters: objectSchema({
        query: { type: 'string' },
        category: {
          type: 'string',
          enum: ['creating', 'commands', 'interactions', 'keywords', 'tutorial', 'webhooks']
        },
        limit: { type: 'integer', minimum: 1, maximum: 5 }
      }, ['query'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_documentation',
      description: 'Read a complete bundled documentation section only when search_documentation marks its best match as truncated or more detail is genuinely required.',
      parameters: objectSchema({ id: { type: 'string' } }, ['id'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_commands',
      description: 'Search commands by name, description, or textual content. Returns compact matches and revision hashes.',
      parameters: objectSchema({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_command',
      description: 'Read a complete command by ID.',
      parameters: objectSchema({ id: { type: 'string' } }, ['id'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_interactions',
      description: 'Search interactions by name, description, or textual content.',
      parameters: objectSchema({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['query'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_interaction',
      description: 'Read a complete interaction by ID.',
      parameters: objectSchema({ id: { type: 'string' } }, ['id'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'keyword_grep',
      description: 'Search all editable text in commands, interactions, startup JS, developer prompt, memories, and bot state.',
      parameters: objectSchema({ query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['query'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_console',
      description: 'Read recent console entries in chronological order, including their type and timestamp. Use the optional types filter to focus on errors, warnings, events, or other message types.',
      parameters: objectSchema({
        limit: { type: 'integer', minimum: 1, maximum: 200 },
        types: {
          type: 'array',
          items: { type: 'string', enum: ['info', 'error', 'warning', 'event', 'success'] },
          uniqueItems: true
        }
      })
    }
  },
  { type: 'function', function: { name: 'read_bot_state', description: 'Read persistent bot state.', parameters: objectSchema({}) } },
  { type: 'function', function: { name: 'read_startup_js', description: 'Read startup JavaScript.', parameters: objectSchema({}) } },
  { type: 'function', function: { name: 'read_developer_prompt', description: 'Read the developer prompt used by bot AI functions.', parameters: objectSchema({}) } },
  { type: 'function', function: { name: 'list_memories', description: 'List persistent user preferences and standing instructions with IDs and current revisions. Read this before editing or deleting a memory.', parameters: objectSchema({}) } },
  {
    type: 'function',
    function: {
      name: 'read_validation_fixture',
      description:
        'Read a fresh, complete offline Playground fake state and assertion guidance. This never reads saved/live bot state. Use it to construct explicit validation cases for unsaved command and interaction drafts.',
      parameters: objectSchema({})
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_command',
      description:
        'Create a command from defaults; the app assigns its ID once. Supply explicit validation fixtures and expected outcome/effect assertions for message commands. Tests run against this exact unsaved normalized draft before approval or auto-save. Failed tests return the report for bounded repair without saving. Event commands are labeled unsupported.',
      parameters: objectSchema({ command: { type: 'object' }, validation: validationSchema }, [
        'command'
      ])
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_command',
      description:
        'Patch a command using its exact read revision. Supply explicit validation cases for the complete resulting message-command draft, including intended replies/state changes and relevant negative gates. No save occurs when validation fails.',
      parameters: objectSchema(
        {
          id: { type: 'string' },
          expectedRevision: { type: 'string' },
          patches: patchSchema,
          validation: validationSchema
        },
        ['id', 'expectedRevision', 'patches']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_interaction',
      description:
        'Create an interaction from defaults; the app assigns its ID once. Supply explicit slash/button validation cases with meaningful outcome, response or state assertions. The exact unsaved draft is tested before approval or auto-save; failed tests return a report without saving.',
      parameters: objectSchema({ interaction: { type: 'object' }, validation: validationSchema }, [
        'interaction'
      ])
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_interaction',
      description:
        'Patch an interaction using its exact read revision. Supply explicit slash/button validation cases for the complete resulting draft, including expected replies and missing-option or permission cases where relevant. No save occurs when validation fails.',
      parameters: objectSchema(
        {
          id: { type: 'string' },
          expectedRevision: { type: 'string' },
          patches: patchSchema,
          validation: validationSchema
        },
        ['id', 'expectedRevision', 'patches']
      )
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_bot_state',
      description: 'Patch persistent bot state using JSON Pointer paths.',
      parameters: objectSchema({ expectedRevision: { type: 'string' }, patches: patchSchema }, ['expectedRevision', 'patches'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_startup_js',
      description: 'Replace startup JavaScript and restart the script engine.',
      parameters: objectSchema({ expectedRevision: { type: 'string' }, content: { type: 'string' } }, ['expectedRevision', 'content'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_developer_prompt',
      description: 'Replace the developer prompt while preserving other settings.',
      parameters: objectSchema({ expectedRevision: { type: 'string' }, content: { type: 'string' } }, ['expectedRevision', 'content'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_memory',
      description: 'Create a concise persistent memory for a clear, durable user preference or standing instruction. Never store secrets, one-off task instructions, or facts already represented by bot resources.',
      parameters: objectSchema({ content: { type: 'string', maxLength: 1000 } }, ['content'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_memory',
      description: 'Replace an existing memory. Use the ID and revision returned by list_memories.',
      parameters: objectSchema({
        id: { type: 'string' },
        expectedRevision: { type: 'string' },
        content: { type: 'string', maxLength: 1000 }
      }, ['id', 'expectedRevision', 'content'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_memory',
      description: 'Delete a persistent memory. Use the ID and revision returned by list_memories.',
      parameters: objectSchema({
        id: { type: 'string' },
        expectedRevision: { type: 'string' }
      }, ['id', 'expectedRevision'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'lint_js',
      description: 'Lint JavaScript source without executing it.',
      parameters: objectSchema({ source: { type: 'string' } }, ['source'])
    }
  },
  {
    type: 'function',
    function: {
      name: 'lint_bcfd',
      description: 'Lint BCFD language source, including JavaScript blocks.',
      parameters: objectSchema({ source: { type: 'string' } }, ['source'])
    }
  },
  { type: 'function', function: { name: 'lint_command', description: 'Lint a complete persisted command.', parameters: objectSchema({ id: { type: 'string' } }, ['id']) } },
  { type: 'function', function: { name: 'lint_interaction', description: 'Lint a complete persisted interaction.', parameters: objectSchema({ id: { type: 'string' } }, ['id']) } }
]

// External MCP clients retain the pre-existing create/edit surface. Offline draft
// validation and the fixture helper belong only to the built-in agent harness.
const MCP_MUTATION_DESCRIPTIONS: Record<string, string> = {
  create_command:
    'Create a command by merging the supplied object with command defaults. The app assigns the ID.',
  edit_command: 'Patch a command. Use the revision returned by read_command.',
  create_interaction:
    'Create an interaction by merging the supplied object with defaults. The app assigns the ID.',
  edit_interaction: 'Patch an interaction. Use the revision returned by read_interaction.'
}
export const mcpAgentToolDefinitions: ToolDefinition[] = agentToolDefinitions
  .filter((tool) => tool.function.name !== 'read_validation_fixture')
  .map((tool) => {
    const description = MCP_MUTATION_DESCRIPTIONS[tool.function.name]
    if (!description) return tool
    const parameters = tool.function.parameters
    const { validation: _validation, ...properties } = parameters.properties as Record<
      string,
      unknown
    >
    return {
      ...tool,
      function: { ...tool.function, description, parameters: { ...parameters, properties } }
    }
  })

export const mutationToolNames = new Set([
  'create_command', 'edit_command', 'create_interaction', 'edit_interaction',
  'edit_bot_state', 'edit_startup_js', 'edit_developer_prompt',
  'create_memory', 'edit_memory', 'delete_memory'
])

const COMMAND_TARGET_TOOLS = new Set([
  'read_command', 'edit_command', 'lint_command'
])

const INTERACTION_TARGET_TOOLS = new Set([
  'read_interaction', 'edit_interaction', 'lint_interaction'
])

function meaningfulText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized || undefined
}

function commandTargetLabel(command: unknown): string | undefined {
  if (!command || typeof command !== 'object') return undefined
  const value = command as Partial<BCFDCommand>
  if (value.type === 2) return 'Member Join'
  if (value.type === 3) return 'Member Leave'
  if (value.type === 4) return 'Member Ban'
  return meaningfulText(value.command) || meaningfulText(value.commandDescription)
}

function interactionTargetLabel(interaction: unknown): string | undefined {
  if (!interaction || typeof interaction !== 'object') return undefined
  const value = interaction as Partial<BCFDInteractionCommand>
  return meaningfulText(value.commandName) || meaningfulText(value.commandDescription)
}

export function agentToolTargetLabel(
  name: string,
  args: Record<string, unknown>
): string | undefined {
  if (name === 'create_command') return commandTargetLabel(args.command)
  if (name === 'create_interaction') return interactionTargetLabel(args.interaction)
  if (name === 'create_memory' || name === 'edit_memory') {
    const content = meaningfulText(args.content)
    return content && content.length > 80 ? `${content.slice(0, 77)}...` : content
  }

  if (COMMAND_TARGET_TOOLS.has(name)) {
    const command = getCommands().bcfdCommands.find((item) => item.id === args.id)
    return commandTargetLabel(command)
  }
  if (INTERACTION_TARGET_TOOLS.has(name)) {
    const interaction = getInteractions().find((item) => item.id === args.id)
    return interactionTargetLabel(interaction)
  }
  return undefined
}

export function revision(value: unknown): string {
  return resourceRevision(value)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function textEntries(value: unknown, path = '', entries: Array<{ path: string; value: string }> = []) {
  if (typeof value === 'string') entries.push({ path: path || '/', value })
  else if (Array.isArray(value)) value.forEach((item, index) => textEntries(item, `${path}/${index}`, entries))
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) textEntries(item, `${path}/${key}`, entries)
  }
  return entries
}

function snippets(value: unknown, query: string): Array<{ path: string; snippet: string }> {
  const needle = query.toLowerCase()
  return textEntries(value)
    .filter((entry) => entry.value.toLowerCase().includes(needle))
    .slice(0, 8)
    .map((entry) => ({ path: entry.path, snippet: entry.value.slice(0, 240) }))
}

function emptyEmbed() {
  return { title: '', description: '', hexColor: '', imageURL: '', thumbnailURL: '', footer: '' }
}

function defaultCommand(): BCFDCommand {
  return {
    id: crypto.randomUUID(), channelMessage: '', command: '', commandDescription: '',
    deleteAfter: false, deleteIfStrings: '', deleteNum: 0,
    ignoreErrorMessage: false, isBan: false, isKick: false, isNSFW: false,
    requiredRole: '', isVoiceMute: false, isAdmin: false, phrase: false, privateMessage: '',
    reaction: '', roleToAssign: '',
    specificChannel: '', specificMessage: '', startsWith: false, type: 0, channelEmbed: emptyEmbed(),
    privateEmbed: emptyEmbed(), channelWhitelist: '', serverWhitelist: ''
  }
}

function defaultAction(): BCFDInteractionAction {
  return {
    sendChannelMessage: false, channelMessage: '', sendPrivateMessage: false, privateMessage: '',
    sendChannelEmbed: false, channelEmbed: emptyEmbed(), sendPrivateEmbed: false, privateEmbed: emptyEmbed(),
    isRoleAssigner: false, roleToAssign: '', isKick: false, isBan: false, isVoiceMute: false,
    targetUserOptionName: '', deleteX: false, deleteNum: 0, ephemeral: false, deferReply: false, buttons: []
  }
}

function defaultInteraction(): BCFDInteractionCommand {
  return { id: crypto.randomUUID(), commandName: '', commandDescription: '', options: [], rootAction: defaultAction(), isRegistered: false }
}

function assertCommand(value: unknown): asserts value is BCFDCommand {
  const command = value as BCFDCommand
  const validEmbed = (embed: any) => embed && ['title', 'description', 'hexColor', 'imageURL', 'thumbnailURL', 'footer']
    .every((field) => typeof embed[field] === 'string')
  if (!command || typeof command !== 'object' || typeof command.command !== 'string' ||
      typeof command.commandDescription !== 'string' ||
      !validEmbed(command.channelEmbed) || !validEmbed(command.privateEmbed) ||
      !Number.isInteger(command.type) || command.type < 0 || command.type > 5) {
    throw new Error('Invalid command structure')
  }
}

function assertInteraction(value: unknown): asserts value is BCFDInteractionCommand {
  const interaction = value as BCFDInteractionCommand
  if (!interaction || typeof interaction !== 'object' || typeof interaction.commandName !== 'string' ||
      typeof interaction.commandDescription !== 'string' || !Array.isArray(interaction.options) || !interaction.rootAction) {
    throw new Error('Invalid interaction structure')
  }
}

function decodePointer(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`Invalid JSON Pointer: ${path}`)
  const parts = path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (parts.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Unsafe patch path')
  return parts
}

function applyPatches<T>(source: T, patches: AgentPatchOperation[]): T {
  const result: any = clone(source)
  for (const patch of patches) {
    const parts = decodePointer(patch.path)
    let parent = result
    for (const part of parts.slice(0, -1)) {
      if (parent?.[part] === undefined) throw new Error(`Patch path does not exist: ${patch.path}`)
      parent = parent[part]
    }
    const key = parts.at(-1)!
    if (patch.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key]
    } else {
      if (patch.op === 'replace' && !(key in parent)) throw new Error(`Patch path does not exist: ${patch.path}`)
      if (Array.isArray(parent) && patch.op === 'add') parent.splice(key === '-' ? parent.length : Number(key), 0, clone(patch.value))
      else parent[key] = clone(patch.value)
    }
  }
  return result
}

function lintSource(source: string, mode: 'bcfd' | 'js', startupJs = ''): AgentLintDiagnostic[] {
  return lintBCFD(source, {
    mode,
    startupJs,
    wrapEvalInIIFE: mode === 'bcfd' ? !getSettings().useLegacyInterpreter : false
  }).map((item) => ({ ...item }))
}

async function lintTextFields(value: unknown): Promise<AgentLintDiagnostic[]> {
  const startup = await getStartupJs()
  return textEntries(value).flatMap((entry) =>
    lintSource(entry.value, 'bcfd', startup).map((diagnostic) => ({ ...diagnostic, path: entry.path }))
  )
}

async function lintCommandResource(command: BCFDCommand): Promise<AgentLintDiagnostic[]> {
  const diagnostics = await lintTextFields(command)
  if (!command.commandDescription.trim()) diagnostics.unshift({ severity: 'error', message: 'Command description is required', path: '/commandDescription' })
  if ([0, 1, 5].includes(command.type) && !command.command.trim()) diagnostics.unshift({ severity: 'error', message: 'Command trigger is required for this command type', path: '/command' })
  return diagnostics
}

async function lintInteractionResource(
  interaction: BCFDInteractionCommand
): Promise<AgentLintDiagnostic[]> {
  const diagnostics = await lintTextFields(interaction)
  if (!/^[a-z0-9_-]{1,32}$/.test(interaction.commandName)) diagnostics.unshift({ severity: 'error', message: 'Interaction name must be 1-32 lowercase characters using letters, numbers, hyphens, or underscores', path: '/commandName' })
  if (!interaction.commandDescription.trim() || interaction.commandDescription.length > 100) diagnostics.unshift({ severity: 'error', message: 'Interaction description must be 1-100 characters', path: '/commandDescription' })
  const names = new Set<string>()
  interaction.options.forEach((option, index) => {
    if (names.has(option.name))
      diagnostics.unshift({
        severity: 'error',
        message: `Duplicate option name: ${option.name}`,
        path: `/options/${index}/name`
      })
    names.add(option.name)
  })
  return diagnostics
}

export async function executeReadTool(name: string, args: Record<string, any>): Promise<unknown> {
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100))
  if (name === 'search_documentation') {
    return searchDocumentation(
      String(args.query || ''),
      args.category as DocumentationCategory | undefined,
      args.limit
    )
  }
  if (name === 'read_documentation') return readDocumentation(String(args.id || ''))
  if (name === 'read_validation_fixture')
    return {
      state: createPlaygroundState(),
      limits: { cases: 6, totalSteps: 12, assertionsPerStep: 8, totalAssertions: 64 },
      guidance:
        'Each step needs /outcome and a meaningful effect assertion; blocked/error expectations additionally need a specific nonempty /reason or /errors/N assertion. Execution outcomes: executed, blocked, error, unmatched, unsupported, not_run. Assertion paths are JSON Pointers into {outcome,reason,errors,state,effects}. Fresh state per case; advanceClockMs advances the fake clock between sequence steps without sleeping. At least one executed candidate step is needed for an overall pass. Expected-negative steps must include a specific nonempty /reason or /errors/N assertion and an effects assertion proving no unintended outputs. AI is mocked; startup scripts, live state, Discord and providers are never loaded.',
      exampleAssertions: [
        { path: '/outcome', equals: 'executed' },
        { path: '/effects/messages/0/content', equals: 'Pong!' }
      ]
    }
  if (name === 'search_commands') {
    const query = String(args.query || '')
    return getCommands().bcfdCommands.filter((item) => snippets(item, query).length).slice(0, limit)
      .map((item) => ({ id: item.id, command: item.command, description: item.commandDescription, type: item.type, revision: revision(item), matches: snippets(item, query) }))
  }
  if (name === 'read_command') {
    const item = getCommands().bcfdCommands.find((command) => command.id === args.id)
    if (!item) throw new Error('Command not found')
    return { resource: item, revision: revision(item) }
  }
  if (name === 'search_interactions') {
    const query = String(args.query || '')
    return getInteractions().filter((item) => snippets(item, query).length).slice(0, limit)
      .map((item) => ({ id: item.id, name: item.commandName, description: item.commandDescription, revision: revision(item), matches: snippets(item, query) }))
  }
  if (name === 'read_interaction') {
    const item = getInteractions().find((interaction) => interaction.id === args.id)
    if (!item) throw new Error('Interaction not found')
    return { resource: item, revision: revision(item) }
  }
  if (name === 'read_console') {
    return getRendererConsoleEntries({
      limit: args.limit,
      types: Array.isArray(args.types) ? (args.types as ConsoleMessageType[]) : undefined
    })
  }
  if (name === 'read_bot_state') {
    const state = await readBotState()
    return { resource: state, revision: revision(state) }
  }
  if (name === 'read_startup_js') {
    const content = await getStartupJs()
    return { content, revision: revision(content) }
  }
  if (name === 'read_developer_prompt') {
    const content = getSettings().developerPrompt || ''
    return { content, revision: revision(content) }
  }
  if (name === 'list_memories') return loadAgentMemories()
  if (name === 'keyword_grep') {
    const query = String(args.query || '').toLowerCase()
    const resources: Array<{ type: string; id?: string; value: unknown }> = [
      ...getCommands().bcfdCommands.map((value) => ({ type: 'command', id: value.id, value })),
      ...getInteractions().map((value) => ({ type: 'interaction', id: value.id, value })),
      { type: 'startup-js', value: await getStartupJs() },
      { type: 'developer-prompt', value: getSettings().developerPrompt || '' },
      ...(await loadAgentMemories()).memories.map((value) => ({
        type: 'memory',
        id: value.id,
        value: value.content
      })),
      { type: 'bot-state', value: await readBotState() }
    ]
    return resources.flatMap((resource) => textEntries(resource.value)
      .filter((entry) => entry.value.toLowerCase().includes(query))
      .map((entry) => ({ type: resource.type, id: resource.id, path: entry.path, snippet: entry.value.slice(0, 240) }))).slice(0, limit)
  }
  if (name === 'lint_js') return lintSource(String(args.source || ''), 'js')
  if (name === 'lint_bcfd') return lintSource(String(args.source || ''), 'bcfd', await getStartupJs())
  if (name === 'lint_command') {
    const item = getCommands().bcfdCommands.find((command) => command.id === args.id)
    if (!item) throw new Error('Command not found')
    return lintCommandResource(item)
  }
  if (name === 'lint_interaction') {
    const item = getInteractions().find((interaction) => interaction.id === args.id)
    if (!item) throw new Error('Interaction not found')
    return lintInteractionResource(item)
  }
  throw new Error(`Unknown read tool: ${name}`)
}

function requireRevision(actual: unknown, expected: unknown) {
  if (revision(actual) !== expected) throw new Error('Stale resource revision; read the resource again before editing')
}

export async function prepareMutation(
  name: string,
  args: Record<string, any>
): Promise<PreparedMutation> {
  if (name === 'create_command') {
    const input = args.command || {}
    const candidate = {
      ...defaultCommand(), ...input,
      channelEmbed: { ...emptyEmbed(), ...(input.channelEmbed || {}) },
      privateEmbed: { ...emptyEmbed(), ...(input.privateEmbed || {}) },
      id: crypto.randomUUID()
    }
    const after = decodeBCFDCommand(candidate, () => crypto.randomUUID()).command
    assertCommand(after)
    return { name, arguments: args, before: null, after, target: { type: 'command', id: after.id } }
  }
  if (name === 'edit_command') {
    const before = getCommands().bcfdCommands.find((item) => item.id === args.id)
    if (!before) throw new Error('Command not found')
    requireRevision(before, args.expectedRevision)
    const candidate = applyPatches(before, args.patches || [])
    const after = decodeBCFDCommand(candidate, () => crypto.randomUUID()).command
    if (after.id !== before.id) throw new Error('Command IDs cannot be edited')
    assertCommand(after)
    return {
      name,
      arguments: args,
      before: clone(before),
      after,
      target: { type: 'command', id: before.id }
    }
  }
  if (name === 'create_interaction') {
    const input = args.interaction || {}
    const after = { ...defaultInteraction(), ...input, rootAction: { ...defaultAction(), ...(input.rootAction || {}) }, id: crypto.randomUUID(), isRegistered: false }
    assertInteraction(after)
    return { name, arguments: args, before: null, after, target: { type: 'interaction', id: after.id } }
  }
  if (name === 'edit_interaction') {
    const before = getInteractions().find((item) => item.id === args.id)
    if (!before) throw new Error('Interaction not found')
    requireRevision(before, args.expectedRevision)
    const after = applyPatches(before, args.patches || [])
    if (after.id !== before.id) throw new Error('Interaction IDs cannot be edited')
    assertInteraction(after)
    return {
      name,
      arguments: args,
      before: clone(before),
      after,
      target: { type: 'interaction', id: before.id }
    }
  }
  if (name === 'edit_bot_state') {
    const before = await readBotState()
    requireRevision(before, args.expectedRevision)
    const after = applyPatches(before, args.patches || [])
    if (!after || typeof after !== 'object' || Array.isArray(after)) throw new Error('Bot state must remain an object')
    return { name, arguments: args, before, after, target: { type: 'bot-state' } }
  }
  if (name === 'edit_startup_js') {
    const before = await getStartupJs()
    requireRevision(before, args.expectedRevision)
    const after = String(args.content ?? '')
    return { name, arguments: args, before, after, target: { type: 'startup-js' } }
  }
  if (name === 'edit_developer_prompt') {
    const before = getSettings().developerPrompt || ''
    requireRevision(before, args.expectedRevision)
    const after = String(args.content ?? '')
    return { name, arguments: args, before, after, target: { type: 'developer-prompt' } }
  }
  if (name === 'create_memory') {
    const mutation = await prepareCreateMemory(String(args.content ?? ''), 'agent')
    return { name, arguments: args, before: mutation.before, after: mutation.after, target: { type: 'memory', id: mutation.after!.id } }
  }
  if (name === 'edit_memory') {
    const mutation = await prepareUpdateMemory(
      String(args.id || ''),
      String(args.expectedRevision || ''),
      String(args.content ?? ''),
      'agent'
    )
    return { name, arguments: args, before: mutation.before, after: mutation.after, target: { type: 'memory', id: String(args.id || '') } }
  }
  if (name === 'delete_memory') {
    const mutation = await prepareDeleteMemory(
      String(args.id || ''),
      String(args.expectedRevision || '')
    )
    return { name, arguments: args, before: mutation.before, after: mutation.after, target: { type: 'memory', id: String(args.id || '') } }
  }
  throw new Error(`Unknown mutation tool: ${name}`)
}

export async function lintPreparedMutation(
  prepared: PreparedMutation
): Promise<AgentLintDiagnostic[]> {
  if (prepared.target.type === 'command') return lintCommandResource(prepared.after as BCFDCommand)
  if (prepared.target.type === 'interaction')
    return lintInteractionResource(prepared.after as BCFDInteractionCommand)
  return []
}

async function commitMutationUnlocked(prepared: PreparedMutation): Promise<unknown> {
  const args = prepared.arguments as Record<string, any>
  if (prepared.name === 'create_command') {
    const current = getCommands()
    const command = prepared.after as BCFDCommand
    const existing = current.bcfdCommands.find((item) => item.id === command.id)
    if (existing && revision(existing) !== revision(command))
      throw new Error('Command id already exists')
    const next = existing
      ? current
      : { ...current, bcfdCommands: [...current.bcfdCommands, command] }
    await saveCommands(next)
    setCommands(next)
  } else if (prepared.name === 'edit_command') {
    const current = getCommands()
    const existing = current.bcfdCommands.find((item) => item.id === args.id)
    if (revision(existing) !== revision(prepared.after))
      requireRevision(existing, args.expectedRevision)
    const next = {
      ...current,
      bcfdCommands: current.bcfdCommands.map((item) =>
        item.id === args.id ? (prepared.after as BCFDCommand) : item
      )
    }
    await saveCommands(next)
    setCommands(next)
  } else if (prepared.name === 'create_interaction') {
    const interaction = prepared.after as BCFDInteractionCommand
    const existing = getInteractions().find((item) => item.id === interaction.id)
    if (existing && revision(existing) !== revision(interaction))
      throw new Error('Interaction id already exists')
    const next = existing ? getInteractions() : [...getInteractions(), interaction]
    await saveInteractions(next)
    setInteractions(next)
  } else if (prepared.name === 'edit_interaction') {
    const existing = getInteractions().find((item) => item.id === args.id)
    if (revision(existing) !== revision(prepared.after))
      requireRevision(existing, args.expectedRevision)
    const next = getInteractions().map((item) =>
      item.id === args.id ? (prepared.after as BCFDInteractionCommand) : item
    )
    await saveInteractions(next)
    setInteractions(next)
  } else if (prepared.name === 'edit_bot_state') {
    await withBotStateTransaction((context) => {
      if (!context.serializeVariable) throw new Error('Bot state revision requires a safe snapshot')
      const existing = JSON.parse(context.serializeVariable('botState'))
      if (revision(existing) !== revision(prepared.after))
        requireRevision(existing, args.expectedRevision)
      context.setVariable('botState', prepared.after)
    })
  } else if (prepared.name === 'edit_startup_js') {
    const existing = await getStartupJs()
    if (existing !== prepared.after) requireRevision(existing, args.expectedRevision)
    await updateStartupJsAndRestart(prepared.after as string)
  } else if (prepared.name === 'edit_developer_prompt') {
    const existing = getSettings().developerPrompt || ''
    if (existing !== prepared.after) requireRevision(existing, args.expectedRevision)
    const next = { ...getSettings(), developerPrompt: prepared.after as string }
    await saveSettings(next)
    setSettings(next)
  } else if (prepared.name === 'create_memory') {
    await commitMemoryMutation({
      kind: 'create',
      before: null,
      after: prepared.after as AgentMemory
    })
  } else if (prepared.name === 'edit_memory') {
    await commitMemoryMutation({
      kind: 'update',
      before: prepared.before as AgentMemory,
      after: prepared.after as AgentMemory,
      expectedRevision: String(args.expectedRevision || '')
    })
  } else if (prepared.name === 'delete_memory') {
    await commitMemoryMutation({
      kind: 'delete',
      before: prepared.before as AgentMemory,
      after: null,
      expectedRevision: String(args.expectedRevision || '')
    })
  }

  let diagnostics: AgentLintDiagnostic[] = []
  if (prepared.target.type === 'command')
    diagnostics = await lintCommandResource(prepared.after as BCFDCommand)
  if (prepared.target.type === 'interaction')
    diagnostics = await lintInteractionResource(prepared.after as BCFDInteractionCommand)
  if (prepared.target.type === 'startup-js')
    diagnostics = lintSource(prepared.after as string, 'js')
  const nextRevision =
    prepared.target.type === 'memory' && prepared.after
      ? agentMemoryRevision(prepared.after as AgentMemory)
      : prepared.after === null
        ? undefined
        : revision(prepared.after)
  return { success: true, target: prepared.target, revision: nextRevision, diagnostics }
}

function mutationResourceKind(prepared: PreparedMutation): ResourceChangeKind {
  if (prepared.target.type === 'command') return 'commands'
  if (prepared.target.type === 'interaction') return 'interactions'
  if (prepared.target.type === 'bot-state') return 'bot-state'
  if (prepared.target.type === 'startup-js') return 'startup-js'
  if (prepared.target.type === 'developer-prompt') return 'settings'
  return 'memories'
}

async function changedResourceValue(kind: ResourceChangeKind): Promise<unknown> {
  if (kind === 'commands') return getCommands()
  if (kind === 'interactions') return getInteractions()
  if (kind === 'bot-state') return await readBotState()
  if (kind === 'startup-js') return getStartupJs()
  if (kind === 'settings') return getSettings()
  return loadAgentMemories()
}

export async function commitMutation(
  prepared: PreparedMutation,
  source: ResourceChangeSource = 'agent'
): Promise<unknown> {
  // Approval/retry objects may be reused by callers while this mutation waits its turn.
  prepared = structuredClone(prepared)
  const kind = mutationResourceKind(prepared)
  return withResourceMutationLock(kind, async () => {
    const result = await commitMutationUnlocked(prepared)
    emitResourceChanged(
      kind,
      source,
      await changedResourceValue(kind),
      prepared.target.id
    )
    return result
  })
}

export async function executeAgentTool(
  name: string,
  args: Record<string, unknown>,
  source: ResourceChangeSource = 'agent'
): Promise<unknown> {
  if (!mutationToolNames.has(name)) return executeReadTool(name, args)
  if (source === 'mcp' && Object.hasOwn(args, 'validation'))
    throw new Error(
      'Draft validation is available only in the built-in agent panel; MCP mutations do not accept validation input'
    )
  return commitMutation(await prepareMutation(name, args), source)
}
