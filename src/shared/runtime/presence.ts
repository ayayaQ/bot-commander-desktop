/** Presence argument semantics shared by live and simulated adapters. */
export function parsePresence(args: string[]) {
  if (args.length !== 3) return null
  const statusName = args[0].trim().toLowerCase()
  const status: 'idle' | 'dnd' | 'online' =
    statusName === 'idle' || statusName === 'dnd' ? statusName : 'online'
  const activityName = args[1].trim().toLowerCase()
  const text = args[2].trim().slice(0, 128)
  const type = { watching: 3, playing: 0, listening: 2, competing: 5 }[activityName] ?? 0
  return { status, activities: !text || activityName === 'reset' ? [] : [{ name: text, type }] }
}
