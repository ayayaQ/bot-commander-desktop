import { traditionalActionNames, interactionActionNames, actionOrder } from './actions'
import { createFunctionRegistry } from './keywords'
import { commandEvents } from './dispatch'
import { TIMED_OPERATIONS } from '../playground/scheduling'
import { SCHEDULER_LIMITS } from '../playground/scheduler'

export { RUNTIME_VERSION } from './version'
import { RUNTIME_VERSION } from './version'

/** Derived from the executable registry, not a second hand-maintained allowlist. */
export function playgroundCapabilities() {
  const registry = createFunctionRegistry({
    now: () => 0,
    random: () => 0,
    commandCount: () => 0,
    chat: async () => '',
    setStatus: () => '',
    mutualGuildCount: () => '',
    deleteMessage: () => '',
    cooldownRemaining: () => 0
  })
  return {
    runtimeVersion: RUNTIME_VERSION,
    fixtureVersions: [2, 3],
    world: {
      normalized: ['users', 'guilds', 'memberships', 'roles', 'channels', 'messages'],
      eventContext: ['guildId (null for DM)', 'channelId', 'senderId'],
      permissions: [
        'guild roles',
        'everyone/role/member overwrites',
        'owner/administrator bypass',
        'role hierarchy',
        'managed/editable restrictions'
      ],
      limitations: [
        'thread inheritance',
        'timeouts',
        '2FA',
        'intents',
        'registrations',
        'live Discord access'
      ],
      messageIds: 'v3 decimal strings; v2 retains safe integer IDs'
    },
    keywords: [...registry.keys()].sort(),
    events: [...commandEvents, 'slash', 'button'],
    actions: [...traditionalActionNames],
    interactionActions: [...interactionActionNames],
    actionOrder: Object.fromEntries(commandEvents.map((event) => [event, actionOrder(event)])),
    scripts: ['wrapped', 'global', 'startup'],
    externalMocks: ['ai.chat'],
    timing: {
      fixture: 'state.timing',
      operations: [...TIMED_OPERATIONS],
      fields: ['delayMs', 'latencyMs', 'failure'],
      limits: { ...SCHEDULER_LIMITS },
      order: 'timestamp then insertion; promise continuations settle before the next task',
      drain: 'Each event drains required work before the next event or clock advance',
      timezone: 'UTC; ISO 8601 date formatting'
    }
  }
}
