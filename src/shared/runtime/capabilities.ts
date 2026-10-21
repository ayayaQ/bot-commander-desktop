import { traditionalActionNames, interactionActionNames, actionOrder } from './actions'
import { createFunctionRegistry } from './keywords'
import { commandEvents } from './dispatch'

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
    keywords: [...registry.keys()].sort(),
    events: [...commandEvents, 'slash', 'button'],
    actions: [...traditionalActionNames],
    interactionActions: [...interactionActionNames],
    actionOrder: Object.fromEntries(commandEvents.map((event) => [event, actionOrder(event)])),
    scripts: ['wrapped', 'global', 'startup'],
    externalMocks: ['ai.chat']
  }
}
