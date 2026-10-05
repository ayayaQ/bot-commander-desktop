/** In-repository release additions; the externally generated help snapshot stays unchanged. */
const messageDeletionContent = `
$deleteMessage(MessageId) deletes exactly one regular message in the current channel and returns
an empty string on success. It works in message/event, slash-command and button templates in
both current and legacy settings. Arguments are evaluated first: $deleteMessage($args(0)) or
$deleteMessage($option(messageid)). Use a string slash option, since numeric values can lose ID precision.

Exactly one string argument is required. After trimming surrounding whitespace, the ID must
match [1-9][0-9]{0,19} and be no greater than 18446744073709551615. Leading zeroes, zero, signs,
decimals, exponents, mentions, message URLs and blank evaluated values are invalid.
The current message channel is the only target scope. There is no channel-ID argument, GET
prefetch, bulk deletion, 14-day limit or new gateway intent. The single-message DELETE is awaited.
The bot needs channel access and target deletion permissions; its own messages do not require
Manage Messages. No invoking-user Manage Messages gate is imposed. Ephemeral replies cannot
be deleted through the regular channel message endpoint.

Errors are inline BCFD values, never raw Discord/network details:
[BCFD Error: deleteMessage requires exactly one message ID]
[BCFD Error: deleteMessage requires a valid message ID]
[BCFD Error: deleteMessage requires a message channel context]
[BCFD Error: deleteMessage message not found in the current channel] (10008)
[BCFD Error: deleteMessage current channel not found] (10003)
[BCFD Error: deleteMessage missing access to the current channel] (50001)
[BCFD Error: deleteMessage missing permission to delete this message] (50013/50003)
[BCFD Error: deleteMessage failed] (other failures)

Offline Playground uses only visible Fake message IDs, such as $deleteMessage(1). A success
marks one local transcript entry deleted and adds a simulation trace, with no live effect.
Unknown, already-deleted, DM and ephemeral entries are not found in this scope. Validation and
inline results match production. The simulator assumes the bot can delete regular local channel
messages regardless of the fake invoker's permissions; Discord access, permission and network
failures are not simulated. Reset starts local IDs over.
`.trim()

export const supplementalDocumentationRecords = [
  {
    id: 'keywords:delete-message',
    title: '$deleteMessage(MessageId)',
    category: 'keywords' as const,
    breadcrumbs: ['Keywords', 'Message Context'],
    content: messageDeletionContent,
    searchableText: `$deleteMessage(MessageId) single-message deletion ${messageDeletionContent}`,
    sourceUrl:
      'https://github.com/ayayaQ/bot-commander-desktop/blob/main/src/main/services/bcfdLang/SPECIFICATION.md#single-message-deletion'
  }
]
