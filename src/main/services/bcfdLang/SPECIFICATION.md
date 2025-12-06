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
- Use `return` to output a value; otherwise the block produces empty string
- These blocks are async-safe

### Variable Storage

```
$set(variableName, value)    → Store a value
$get(variableName)           → Retrieve a stored value
```

Variables persist across the bot session and are saved to disk.

## Built-in Functions

### User Context

| Function         | Description           | Example Output          |
| ---------------- | --------------------- | ----------------------- |
| `$name`          | User as mention       | `<@123456789>`          |
| `$namePlain`     | User's display name   | `JohnDoe`               |
| `$avatar`        | User's avatar URL     | `https://...`           |
| `$discriminator` | User's discriminator  | `1234`                  |
| `$tag`           | User's tag            | `JohnDoe#1234`          |
| `$id`            | User's ID             | `123456789`             |
| `$timeCreated`   | Account creation time | `1/1/2020, 12:00:00 PM` |
| `$defaultavatar` | Default avatar URL    | `https://...`           |

### Member Context

| Function                        | Description                     |
| ------------------------------- | ------------------------------- |
| `$memberIsOwner`                | Is the member the server owner? |
| `$memberEffectiveName`          | Member's display name in server |
| `$memberNickname`               | Member's nickname               |
| `$memberID`                     | Member's ID                     |
| `$memberHasTimeJoined`          | Has join timestamp?             |
| `$memberTimeJoined`             | When member joined              |
| `$memberEffectiveAvatar`        | Member's effective avatar       |
| `$memberEffectiveTag`           | Member's tag                    |
| `$memberEffectiveID`            | Member's ID                     |
| `$memberEffectiveTimeCreated`   | Account creation time           |
| `$memberEffectiveDefaultAvatar` | Default avatar URL              |
| `$memberTimeBoosted`            | When member started boosting    |
| `$memberHasBoosted`             | Is member boosting?             |

### Bot Context

| Function            | Description                 |
| ------------------- | --------------------------- |
| `$ping`             | Bot's websocket ping (ms)   |
| `$inviteURL`        | Bot's invite URL            |
| `$serverCount`      | Number of servers bot is in |
| `$allMemberCount`   | Total cached members        |
| `$botAvatar`        | Bot's avatar URL            |
| `$botName`          | Bot as mention              |
| `$botNamePlain`     | Bot's display name          |
| `$botID`            | Bot's user ID               |
| `$botTimeCreated`   | Bot account creation time   |
| `$botDefaultAvatar` | Bot's default avatar URL    |
| `$botDiscriminator` | Bot's discriminator         |
| `$botTag`           | Bot's tag                   |

### Server Context

| Function             | Description          |
| -------------------- | -------------------- |
| `$server`            | Server name          |
| `$serverIcon`        | Server icon URL      |
| `$serverBanner`      | Server banner URL    |
| `$serverDescription` | Server description   |
| `$serverSplash`      | Server splash URL    |
| `$serverCreateTime`  | Server creation time |
| `$memberCount`       | Server member count  |

### Channel Context

| Function             | Description           |
| -------------------- | --------------------- |
| `$channel`           | Channel name          |
| `$channelID`         | Channel ID            |
| `$channelCreateDate` | Channel creation time |
| `$channelAsMention`  | Channel as mention    |

### Mentioned User Context

| Function                  | Description                       |
| ------------------------- | --------------------------------- |
| `$mentionedName`          | Mentioned user as mention         |
| `$mentionedID`            | Mentioned user's ID               |
| `$mentionedTag`           | Mentioned user's tag              |
| `$mentionedDiscriminator` | Mentioned user's discriminator    |
| `$mentionedAvatar`        | Mentioned user's avatar           |
| `$mentionedTimeCreated`   | Mentioned user's account creation |
| `$mentionedNamePlain`     | Mentioned user's display name     |
| `$mentionedDefaultAvatar` | Mentioned user's default avatar   |
| `$mentionedIsBot`         | Is mentioned user a bot?          |

### Utility Functions

| Function         | Syntax                                | Description                         |
| ---------------- | ------------------------------------- | ----------------------------------- |
| `$random`        | `$random{a\|b\|c}`                    | Random selection from options       |
| `$rollnum`       | `$rollnum(min, max)`                  | Random integer in range (inclusive) |
| `$sum`           | `$sum(n1, n2, ...)` or `$sum{n1\|n2}` | Sum of numbers                      |
| `$args`          | `$args(index)`                        | Get argument at index               |
| `$argsCount`     | `$argsCount`                          | Number of arguments                 |
| `$randomInt`     | `$randomInt`                          | Random 0-99                         |
| `$randomFloat`   | `$randomFloat`                        | Random 0.0-1.0                      |
| `$randomBoolean` | `$randomBoolean`                      | Random true/false                   |

### Date/Time Functions

| Function   | Description            |
| ---------- | ---------------------- |
| `$date`    | Current date/time      |
| `$hours`   | Current hour (00-23)   |
| `$minutes` | Current minute (00-59) |
| `$seconds` | Current second (00-59) |

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

- `$if(condition, then, else)` - Conditional expressions
- `$foreach(list, template)` - Iteration
- `$length(string)` - String length
- `$substring(string, start, end)` - Substring extraction
- `$uppercase(string)` / `$lowercase(string)` - Case conversion
- `$replace(string, search, replacement)` - String replacement
