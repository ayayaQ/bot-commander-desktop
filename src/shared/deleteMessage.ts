/** Pure keyword contract shared by the live interpreter and the offline Playground. */
export const DELETE_MESSAGE_ERRORS = {
  arity: '[BCFD Error: deleteMessage requires exactly one message ID]',
  invalidId: '[BCFD Error: deleteMessage requires a valid message ID]',
  context: '[BCFD Error: deleteMessage requires a message channel context]',
  missingMessage: '[BCFD Error: deleteMessage message not found in the current channel]',
  missingChannel: '[BCFD Error: deleteMessage current channel not found]',
  access: '[BCFD Error: deleteMessage missing access to the current channel]',
  permission: '[BCFD Error: deleteMessage missing permission to delete this message]',
  failed: '[BCFD Error: deleteMessage failed]'
} as const

export function validateDeleteMessageArguments(
  args: readonly string[]
): { id: string } | { error: string } {
  if (args.length !== 1) return { error: DELETE_MESSAGE_ERRORS.arity }
  if (typeof args[0] !== 'string') return { error: DELETE_MESSAGE_ERRORS.invalidId }
  const id = args[0].trim()
  const max = '18446744073709551615'
  if (!/^[1-9][0-9]{0,19}$/.test(id) || (id.length === max.length && id > max))
    return { error: DELETE_MESSAGE_ERRORS.invalidId }
  return { id }
}

export function classifyDeleteMessageError(error: unknown): string {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined
  switch (code) {
    case 10008:
    case '10008':
      return DELETE_MESSAGE_ERRORS.missingMessage
    case 10003:
    case '10003':
      return DELETE_MESSAGE_ERRORS.missingChannel
    case 50001:
    case '50001':
      return DELETE_MESSAGE_ERRORS.access
    case 50013:
    case '50013':
    case 50003:
    case '50003':
      return DELETE_MESSAGE_ERRORS.permission
    default:
      return DELETE_MESSAGE_ERRORS.failed
  }
}
