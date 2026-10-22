import type { CommandEvent } from './dispatch'
/** Traditional command dispatch dependencies, shared with live and simulated adapters. */
export const traditionalActionNames = [
  'deleteIf',
  'purge',
  'message',
  'dm',
  'kick',
  'ban',
  'mute',
  'role',
  'embed',
  'dmEmbed',
  'reaction',
  'deleteAfter',
  'cooldown'
] as const
export function actionOrder(event: CommandEvent): readonly TraditionalActionName[] {
  if (event === 'memberJoin') return ['role', 'embed', 'message', 'dmEmbed', 'dm']
  if (event === 'memberLeave' || event === 'memberBan') return ['embed', 'message', 'dmEmbed', 'dm']
  if (event === 'reaction') return ['message', 'dm', 'embed', 'dmEmbed', 'role']
  return traditionalActionNames
}
export type TraditionalActionName = (typeof traditionalActionNames)[number]
export type TraditionalActions = Partial<
  Record<TraditionalActionName, () => Promise<unknown> | unknown>
>

export async function runTraditionalActions(
  actions: TraditionalActions,
  spawn: (task: Promise<unknown>, name: TraditionalActionName) => void,
  event: CommandEvent = 'message'
): Promise<{ blockedBy?: TraditionalActionName }> {
  for (const name of actionOrder(event)) {
    const action = actions[name]
    if (!action) continue
    const result = action()
    if (['purge', 'kick', 'ban', 'mute'].includes(name)) {
      if ((await result) === false) return { blockedBy: name }
    } else spawn(Promise.resolve(result), name)
  }
  return {}
}

export const interactionActionNames = ['response', 'dm', 'dmEmbed', 'role'] as const
/** Slash and button response effects are sequential; later effects stop on failure. */
export async function runInteractionActions(
  actions: Partial<
    Record<(typeof interactionActionNames)[number], () => Promise<unknown> | unknown>
  >
): Promise<void> {
  for (const name of interactionActionNames) await actions[name]?.()
}
