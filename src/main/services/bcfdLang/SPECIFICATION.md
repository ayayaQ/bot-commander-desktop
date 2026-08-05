# BCFD Template Language Specification

**Version**: 1.0.0  
**Date**: December 2025

## Overview

The BCFD Template Language is a string interpolation language designed for Discord bot command responses. It supports variable substitution, function calls with arguments, nested expressions, JavaScript evaluation, and error reporting.

## Lexical Elements

### Identifiers

Identifiers start with a letter or underscore and may contain letters, digits, and underscores.

```
identifier = (letter | "_") { letter | digit | "_" }
letter     = "a"..."z" | "A"..."Z"
digit      = "0"..."9"
```

### Literals

- **String Literals**: Plain text that is not part of an expression
- **Numeric Literals**: Integers and floating-point numbers (used within function arguments)

## Expressions

### Variable Expressions

Variables are prefixed with `$` and resolve to their corresponding value.

```
$name           → User's display name as mention
$ping           → Bot's websocket ping
$server         → Server name
```

### Function Expressions

Functions use `$functionName` followed by arguments in parentheses or curly braces.

**Parenthesis syntax** (comma-separated):

```
$rollnum(1, 100)       → Random number between 1 and 100
$args(0)               → First argument after command
$sum(1, 2, 3)          → Sum of numbers
```

**Brace syntax** (pipe-separated):

```
$random{option1|option2|option3}   → Random selection
```

Both syntaxes support nested expressions:

```
$random{$name|$botName}            → Randomly pick between user or bot name
$sum($rollnum(1,10), $rollnum(1,10))  → Sum of two random numbers
```

### Escape Sequences

- `$$` → Literal `$` character
- `\{` → Literal `{` in brace arguments
- `\}` → Literal `}` in brace arguments
- `\|` → Literal `|` in brace arguments
- `\(` → Literal `(` in parenthesis arguments
- `\)` → Literal `)` in parenthesis arguments
- `\,` → Literal `,` in parenthesis arguments

### JavaScript Evaluation

For advanced users, raw JavaScript can be executed:

```
$eval
  botState.counter = (botState.counter || 0) + 1;
  return "Count: " + botState.counter;
$halt
```

**Rules**:

- Code between `$eval` and `$halt` is executed in a sandboxed VM
- All `$variable` and `$function(...)` expressions within the eval block are resolved BEFORE JavaScript execution
- The `botState` object is available for persistent storage
- Isolated eval scope is the default: the code is wrapped in a function, `return` inserts a value,
  and declarations remain local to the block
- Global eval scope runs the same resolved code without a function wrapper: top-level `return` is
  invalid, successful blocks always produce an empty string, and top-level variables remain
  available until the JavaScript engine restarts
- These blocks are async-safe

### Variable Storage

```
$set(variableName, value)    → Store a value
$get(variableName)           → Retrieve a stored value
```

Variables persist across the bot session and are saved to disk.

### Control Structures

Conditional blocks using `$if`, `$elseif`, `$else`, and `$endif`:

```
$if($memberIsOwner)
  Welcome, server owner $namePlain!
$elseif($args(0) == hello)
  Hello there!
$else
  You don't have permission.
$endif
```

**Condition Expressions** support the following operators (ordered by precedence, lowest first):

| Operator      | Description               | Example               |
| ------------- | ------------------------- | --------------------- |
| `\|` / `\|\|` | Logical OR                | `$a \| $b`            |
| `&` / `&&`    | Logical AND               | `$a & $b`             |
| `==`          | Equality (case-sensitive) | `$args(0) == hello`   |
| `!=`          | Inequality                | `$args(0) != goodbye` |
| `>`, `<`      | Numeric comparison        | `$rollnum(1,10) > 5`  |
| `>=`, `<=`    | Numeric comparison        | `$memberCount >= 100` |
| `!`           | Logical NOT (unary)       | `!$memberIsOwner`     |
| `(` `)`       | Grouping                  | `($a \| $b) & $c`     |

**Truthiness**: A value is truthy if it is not empty, not `"false"`, and not `"0"`.

**Nesting**: If blocks can be nested inside each other:

```
$if($memberIsOwner)
  $if($args(0) == kick)
    Kicking user...
  $endif
$endif
```

## Built-in Functions

### User Context

| Function                | Description                                | Example Output          |
| ----------------------- | ------------------------------------------ | ----------------------- |
| `$name`                 | User as mention                            | `<@123456789>`          |
| `$namePlain`            | User's display name                        | `JohnDoe`               |
| `$avatar`               | User's avatar URL                          | `https://...`           |
| `$discriminator`        | User's discriminator                       | `1234`                  |
| `$tag`                  | User's tag                                 | `JohnDoe#1234`          |
| `$ID`                   | User's ID                                  | `123456789`             |
| `$timeCreated`          | Account creation time                      | `1/1/2020, 12:00:00 PM` |
| `$timeCreatedDiscord`   | Account creation time as Discord timestamp | `<t:1577880000>`        |
| `$defaultAvatar`        | Default avatar URL                         | `https://...`           |
| `$serversSharedWithBot` | Number of cached mutual servers            | `3`                     |

### Member Context

| Function                             | Description                                       |
| ------------------------------------ | ------------------------------------------------- |
| `$memberIsOwner`                     | Is the member the server owner?                   |
| `$memberEffectiveName`               | Member's display name in server                   |
| `$memberNickname`                    | Member's nickname                                 |
| `$memberID`                          | Member's ID                                       |
| `$memberHasTimeJoined`               | Has join timestamp?                               |
| `$memberTimeJoined`                  | When member joined                                |
| `$memberTimeJoinedDiscord`           | When member joined as Discord timestamp           |
| `$memberEffectiveAvatar`             | Member's effective avatar                         |
| `$memberEffectiveTag`                | Member's tag                                      |
| `$memberEffectiveID`                 | Member's ID                                       |
| `$memberEffectiveTimeCreated`        | Account creation time                             |
| `$memberEffectiveTimeCreatedDiscord` | Account creation time as Discord timestamp        |
| `$memberEffectiveDefaultAvatar`      | Default avatar URL                                |
| `$memberTimeBoosted`                 | When member started boosting                      |
| `$memberTimeBoostedDiscord`          | When member started boosting as Discord timestamp |
| `$memberHasBoosted`                  | Is member boosting?                               |

### Bot Context

| Function                 | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `$ping`                  | Bot's websocket ping (ms)                      |
| `$inviteURL`             | Bot's invite URL                               |
| `$serverCount`           | Number of servers bot is in                    |
| `$allMemberCount`        | Total cached members                           |
| `$botAvatar`             | Bot's avatar URL                               |
| `$botName`               | Bot as mention                                 |
| `$botNamePlain`          | Bot's display name                             |
| `$botID`                 | Bot's user ID                                  |
| `$botTimeCreated`        | Bot account creation time                      |
| `$botTimeCreatedDiscord` | Bot account creation time as Discord timestamp |
| `$botDefaultAvatar`      | Bot's default avatar URL                       |
| `$botDiscriminator`      | Bot's discriminator                            |
| `$botTag`                | Bot's tag                                      |

### Server Context

| Function                   | Description                               |
| -------------------------- | ----------------------------------------- |
| `$server`                  | Server name                               |
| `$serverIcon`              | Server icon URL                           |
| `$serverBanner`            | Server banner URL                         |
| `$serverDescription`       | Server description                        |
| `$serverSplash`            | Server splash URL                         |
| `$serverCreateTime`        | Server creation time                      |
| `$serverCreateTimeDiscord` | Server creation time as Discord timestamp |
| `$memberCount`             | Server member count                       |

### Channel Context

| Function                    | Description                                |
| --------------------------- | ------------------------------------------ |
| `$channel`                  | Channel name                               |
| `$channelID`                | Channel ID                                 |
| `$channelCreateDate`        | Channel creation time                      |
| `$channelCreateDateDiscord` | Channel creation time as Discord timestamp |
| `$channelAsMention`         | Channel as mention                         |
| `$channelTopic`             | Channel topic                              |
| `$channelIsNSFW`            | Is channel NSFW?                           |

### Channel Management

These functions create, modify, and manage Discord channels. The bot requires `ManageChannels` permission for most operations and `ManageRoles` for lock/unlock. All mutating operations are async.

**Channel types**: `"text"`, `"voice"`, `"category"`, `"announcement"`, `"stage"`, `"forum"`

#### Creation

| Function                | Syntax                                     | Description                                                           |
| ----------------------- | ------------------------------------------ | --------------------------------------------------------------------- |
| `$createChannel`        | `$createChannel(name, type)`               | Create a channel (type defaults to "text"). Returns channel ID        |
| `$createPrivateChannel` | `$createPrivateChannel(name, type)`        | Create a channel visible to the caller and admins. Returns channel ID |
| `$createChannelIn`      | `$createChannelIn(name, type, categoryID)` | Create a channel under a category. Returns channel ID                 |
| `$cloneChannel`         | `$cloneChannel(channelID)`                 | Clone a channel (copies all properties). Returns new channel ID       |

#### Deletion

| Function         | Syntax                              | Description                                                      |
| ---------------- | ----------------------------------- | ---------------------------------------------------------------- |
| `$deleteChannel` | `$deleteChannel(channelID, reason)` | Delete a channel. Reason is optional (audit log). Returns "true" |

#### Editing

| Function              | Syntax                                     | Description                                               |
| --------------------- | ------------------------------------------ | --------------------------------------------------------- |
| `$setChannelName`     | `$setChannelName(channelID, name)`         | Rename a channel                                          |
| `$setChannelTopic`    | `$setChannelTopic(channelID, topic)`       | Set channel topic (text channels only)                    |
| `$setChannelNSFW`     | `$setChannelNSFW(channelID, true/false)`   | Toggle NSFW flag                                          |
| `$setChannelSlowmode` | `$setChannelSlowmode(channelID, seconds)`  | Set slowmode (0-21600 seconds, 0 = off)                   |
| `$setChannelPosition` | `$setChannelPosition(channelID, position)` | Set channel position in list                              |
| `$setChannelParent`   | `$setChannelParent(channelID, categoryID)` | Move channel to a category (empty = remove from category) |

#### Lookup & Information

| Function            | Syntax                         | Description                                                    |
| ------------------- | ------------------------------ | -------------------------------------------------------------- |
| `$findChannel`      | `$findChannel(name)`           | Find a channel by name (case-insensitive). Returns ID or empty |
| `$getChannelName`   | `$getChannelName(channelID)`   | Get a channel's name by ID                                     |
| `$getChannelType`   | `$getChannelType(channelID)`   | Get channel type as friendly string                            |
| `$getChannelParent` | `$getChannelParent(channelID)` | Get parent category ID (empty if none)                         |
| `$channelExists`    | `$channelExists(channelID)`    | Whether a channel is present in the client's channel cache     |
| `$channelPosition`  | `$channelPosition(channelID)`  | One-based position of a server channel                         |
| `$getSlowmode`      | `$getSlowmode(channelID)`      | Slowmode delay in seconds                                      |
| `$channelCount`     | `$channelCount`                | Total number of channels in the server                         |

#### Listing

| Function          | Syntax                  | Description                                          |
| ----------------- | ----------------------- | ---------------------------------------------------- |
| `$listChannels`   | `$listChannels(type)`   | Comma-separated channel names (type filter optional) |
| `$listChannelIDs` | `$listChannelIDs(type)` | Comma-separated channel IDs (type filter optional)   |

#### Permissions

| Function         | Syntax                              | Description                                           |
| ---------------- | ----------------------------------- | ----------------------------------------------------- |
| `$lockChannel`   | `$lockChannel(channelID, roleID)`   | Deny SendMessages for a role (defaults to @everyone)  |
| `$unlockChannel` | `$unlockChannel(channelID, roleID)` | Reset SendMessages for a role (defaults to @everyone) |

#### Utility

| Function          | Syntax                       | Description                                        |
| ----------------- | ---------------------------- | -------------------------------------------------- |
| `$channelMention` | `$channelMention(channelID)` | Format a channel ID as a clickable mention `<#ID>` |

#### Examples

```
$createChannel(announcements, text)
Created channel: $channelMention($createChannel(general-chat, text))

$if($getChannelType($channelID) == text)
  $setChannelTopic($channelID, Welcome to $server!)
$endif

$lockChannel($findChannel(general))
$deleteChannel($findChannel(old-channel), Cleanup)

Voice channels: $listChannels(voice)
This server has $channelCount channels.
```

### Role Functions

Role lookup accepts a numeric role ID, a role mention, or a case-insensitive role name. Role
positions are one-based and ordered from highest to lowest. Mutating functions require the bot's
`ManageRoles` permission and Discord's normal role-hierarchy checks.

| Function        | Syntax                                           | Description                                                     |
| --------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `$roleCount`    | `$roleCount`                                     | Number of roles, including `@everyone`                          |
| `$roleExists`   | `$roleExists(role)`                              | Whether the role exists                                         |
| `$findRole`     | `$findRole(role)`                                | Resolve a role and return its ID                                |
| `$roleName`     | `$roleName(role)`                                | Resolve a role and return its name                              |
| `$roleNames`    | `$roleNames`                                     | Role names from highest to lowest                               |
| `$getRoleColor` | `$getRoleColor(role)`                            | Six-character uppercase hexadecimal color                       |
| `$rolePosition` | `$rolePosition(role)`                            | One-based position from highest to lowest                       |
| `$hasRole`      | `$hasRole(userID, role)`                         | Whether a server member has the role                            |
| `$userRoles`    | `$userRoles(userID)`                             | Member role names from highest to lowest, excluding `@everyone` |
| `$roleGrant`    | `$roleGrant(userID, +roleID, -roleID, ...)`      | Add and remove validated roles; returns `true`                  |
| `$createRole`   | `$createRole(name, color, hoisted, mentionable)` | Create a role and return its ID                                 |
| `$deleteRole`   | `$deleteRole(role)`                              | Delete a role; returns `true`                                   |

`$createRole` accepts a six-digit hexadecimal color (with an optional `#`) or a decimal Discord
color value from `0` through `16777215`. The boolean options default to `false`. `$roleGrant`
validates the complete operation before applying it and rejects duplicate IDs, managed roles,
`@everyone`, and roles the bot cannot manage.

### Mentioned User Context

| Function                         | Description                                            |
| -------------------------------- | ------------------------------------------------------ |
| `$mentionedName`                 | Mentioned user as mention                              |
| `$mentionedID`                   | Mentioned user's ID                                    |
| `$mentionedTag`                  | Mentioned user's tag                                   |
| `$mentionedDiscriminator`        | Mentioned user's discriminator                         |
| `$mentionedAvatar`               | Mentioned user's avatar                                |
| `$mentionedTimeCreated`          | Mentioned user's account creation                      |
| `$mentionedTimeCreatedDiscord`   | Mentioned user's account creation as Discord timestamp |
| `$mentionedNamePlain`            | Mentioned user's display name                          |
| `$mentionedDefaultAvatar`        | Mentioned user's default avatar                        |
| `$mentionedIsBot`                | Is mentioned user a bot?                               |
| `$mentionedServersSharedWithBot` | Number of cached mutual servers                        |

### Utility Functions

| Function           | Syntax                                 | Description                                     |
| ------------------ | -------------------------------------- | ----------------------------------------------- |
| `$random`          | `$random{a\|b\|c}`                     | Random selection from options                   |
| `$rollnum`         | `$rollnum(min, max)`                   | Random integer in range (inclusive)             |
| `$sum`             | `$sum(n1, n2, ...)` or `$sum{n1\|n2}`  | Sum of numbers                                  |
| `$args`            | `$args(index)`                         | Get argument at index                           |
| `$argsCount`       | `$argsCount`                           | Number of arguments                             |
| `$randomInt`       | `$randomInt`                           | Random 0-99                                     |
| `$randomFloat`     | `$randomFloat`                         | Random 0.0-1.0                                  |
| `$randomBoolean`   | `$randomBoolean`                       | Random true/false                               |
| `$contains`        | `$contains(text, search)`              | True if text contains search                    |
| `$startsWith`      | `$startsWith(text, prefix)`            | True if text starts with prefix                 |
| `$endsWith`        | `$endsWith(text, suffix)`              | True if text ends with suffix                   |
| `$wordCount`       | `$wordCount(text)`                     | Count whitespace-separated words                |
| `$calculate`       | `$calculate(expression)`               | Evaluate bounded arithmetic safely              |
| `$cropText`        | `$cropText(text, length, suffix)`      | Crop Unicode text; suffix is optional           |
| `$linesCount`      | `$linesCount(text)`                    | Count LF, CRLF, or CR-separated lines           |
| `$numberSeparator` | `$numberSeparator(integer, separator)` | Group integer digits; separator defaults to `,` |
| `$randomString`    | `$randomString(length)`                | Random alphanumeric string (0-10 characters)    |
| `$toTitleCase`     | `$toTitleCase(text)`                   | Capitalize each word and lowercase the rest     |
| `$isBoolean`       | `$isBoolean(value)`                    | Recognize `true` or `false` (case-insensitive)  |
| `$isInteger`       | `$isInteger(value)`                    | Validate a signed base-10 integer               |
| `$isValidHex`      | `$isValidHex(value)`                   | Validate a six-digit hex color                  |

`$calculate` supports parentheses, unary `+`/`-`, `+`, `-`, `*`, `/`, `%`, and right-associative
`**`. It does not execute JavaScript or resolve names, and rejects expressions longer than 512
characters, nesting beyond 64 levels, non-finite results, and division by zero.

### Date/Time Functions

| Function              | Description                                                                     |
| --------------------- | ------------------------------------------------------------------------------- |
| `$date`               | Current date/time                                                               |
| `$dateDiscord`        | Current date/time as Discord timestamp                                          |
| `$day`                | Current local day of month (1-31)                                               |
| `$month`              | Current local month (1-12)                                                      |
| `$year`               | Current local four-digit year                                                   |
| `$getTimestamp(unit)` | Unix time in seconds (`s`, default), milliseconds (`ms`), or nanoseconds (`ns`) |
| `$hour`               | Current hour (00-23)                                                            |
| `$minute`             | Current minute (00-59)                                                          |
| `$second`             | Current second (00-59)                                                          |

### Message Context

| Function               | Description                   |
| ---------------------- | ----------------------------- |
| `$message`             | Full message content          |
| `$messageAfterCommand` | Message content after command |
| `$commandCount`        | Number of registered commands |

### AI Functions

| Function | Syntax          | Description               |
| -------- | --------------- | ------------------------- |
| `$chat`  | `$chat(prompt)` | Get AI response to prompt |

### Variable Functions

| Function | Syntax              | Description         |
| -------- | ------------------- | ------------------- |
| `$set`   | `$set(name, value)` | Store a variable    |
| `$get`   | `$get(name)`        | Retrieve a variable |

### Bot Status Function

`$setStatus{online|playing|Activity text}` updates the bot's online status and activity. Online
status accepts `online`, `idle`, or `dnd`; activity type accepts `playing`, `watching`,
`listening`, `competing`, or `reset`.

## Evaluation Order

The interpreter evaluates expressions **inside-out** (recursive descent):

1. Parse the entire string into an AST
2. For each function call, recursively evaluate its arguments first
3. Then evaluate the function with resolved arguments
4. `$eval...$halt` blocks have all inner expressions resolved before JS execution

This means nesting works correctly:

```
$random{$name|$botName}
```

1. Evaluate `$name` → `<@123>`
2. Evaluate `$botName` → `<@456>`
3. Evaluate `$random{<@123>|<@456>}` → picks one

## Error Handling

Errors include position information:

```
Error at position 15: Unknown function '$foo'
Error at position 8: Unclosed parenthesis in function call
Error at position 0: $eval block missing $halt terminator
```

When an error occurs:

- The error message is returned in place of the expression
- Format: `[BCFD Error: <message>]`
- Execution continues for other parts of the string

## Backward Compatibility

Legacy mode can be enabled in settings to use the old evaluation order (non-recursive). This is provided for existing commands that may rely on the previous behavior.

## Future Extensions

Reserved for future versions:

- `$foreach(list, template)` - Iteration
