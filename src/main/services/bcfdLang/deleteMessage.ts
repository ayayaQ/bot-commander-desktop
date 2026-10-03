import {
  classifyDeleteMessageError,
  DELETE_MESSAGE_ERRORS,
  validateDeleteMessageArguments
} from '../../../shared/deleteMessage'

type MessageChannel = {
  messages?: { delete: (id: string) => Promise<unknown> }
}

/** Validation stays synchronous so a bare $deleteMessage also reports its arity error. */
export function deleteMessage(args: string[], channel?: MessageChannel): string | Promise<string> {
  const validated = validateDeleteMessageArguments(args)
  if ('error' in validated) return validated.error
  if (typeof channel?.messages?.delete !== 'function') return DELETE_MESSAGE_ERRORS.context
  return deleteFromChannel(channel, validated.id)
}

async function deleteFromChannel(channel: MessageChannel, id: string): Promise<string> {
  try {
    // Delete by ID directly: no prefetch, bulk-delete age limit or caller-permission gate.
    await channel.messages!.delete(id)
    return ''
  } catch (error) {
    return classifyDeleteMessageError(error)
  }
}
