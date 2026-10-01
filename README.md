# bot-commander-desktop

A no-code Discord bot builder. Design commands through a GUI and host your bot directly from your desktop - no programming required.

### Download

Want to try a ready-to-use build? See the [releases](https://github.com/ayayaQ/bot-commander-desktop/releases).

### Visual Example

<img width="1417" height="844" alt="bcfd-screenshot" src="https://github.com/user-attachments/assets/978b3e1b-9d7f-47df-8c25-1b81d7c3ecf2" />

---

## Features

- **Visual command builder** — create bot commands through a point-and-click interface
- **Rich response templates** — use the built-in BCFD template language to personalize responses with user info, server info, random choices, dice rolls, conditionals, and more
- **Multiple trigger types**: server messages, DMs, member join/leave, member ban, reaction add
- **Persistent bot state** — store and retrieve variables that survive across command invocations
- **Startup script** — run custom JavaScript when the bot starts to initialize state or register behavior
- **AI responses** — use `$chat(prompt)` to call an AI model from within any command response
- **Channel management** — create, delete, rename, lock, and query channels directly from templates

---

## Getting Started

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Give your application a name, then navigate to the **Bot** tab.
3. Newly created applications already have a bot user. Under **Token**, use **Reset Token** if you need to generate a token, then copy your **bot token** for step 3. Keep it private; resetting a token invalidates the previous one.
4. Under **Privileged Gateway Intents**, enable **Server Members Intent** (for join/leave events) and **Message Content Intent** (for message commands), then save your changes. This app requests both, even if your current commands do not use them. Obtain Discord approval for these intents if required for your application. Presence Intent is not requested by this app.

### 2. Invite the Bot to Your Server

1. In the Developer Portal, open **Installation**, enable **Guild Install**, and choose **Discord Provided Link** under **Install Link**.
2. Under **Default Install Settings → Guild Install**, add the `bot` and `applications.commands` scopes.
3. Select the permissions your bot needs (for message commands: View Channels, Send Messages, Read Message History). For **Member Ban** triggers, also grant **Ban Members** (`BAN_MEMBERS`) **or** **View Audit Log** (`VIEW_AUDIT_LOG`) in each server. View Audit Log allows receiving ban events without granting the ability to ban members.
4. Copy the **Install Link**, open it in your browser, and select **Add to server** and the server to add the bot to. Review and approve the installation permissions.

### 3. Start the App

1. Launch Bot Commander Desktop.
2. Open the **Login** tab and paste your bot token.
3. Click **Login** and wait for the connection to succeed.

### Gateway intents and troubleshooting

The app requests the standard `GuildModeration` (`GUILD_MODERATION`) intent for Member Ban triggers. It is separate from the privileged Server Members and Message Content intents and has no Developer Portal toggle. Receiving ban events also requires one of the server permissions described above; enabling Server Members Intent alone does not enable ban events.

If Login reports **disallowed intents (4014)** or **Used disallowed intents**, open **Developer Portal → your application → Bot → Privileged Gateway Intents**, enable **Server Members Intent** and **Message Content Intent**, save, and try Login again. If Discord requires approval, obtain it first. A **4013 invalid intents** error is a different problem and is not fixed by enabling privileged intents.

See Discord's official [bot setup guide](https://docs.discord.com/developers/quick-start/getting-started), [Gateway intent reference](https://docs.discord.com/developers/events/gateway#gateway-intents), [Guild Ban Add permissions](https://docs.discord.com/developers/events/gateway-events#guild-ban-add), and [Gateway close codes](https://docs.discord.com/developers/topics/opcodes-and-status-codes#gateway-gateway-close-event-codes).

---

## Saving and Recovery

Commands, settings, interactions, startup JavaScript, and bot state use exclusive temporary files,
sync their contents, then atomically replace the saved file. The last valid version is kept in a
`.bak` file. On supported platforms/filesystems the containing directory is also synced after each
backup and primary rename. Windows and filesystems that do not support directory sync show a
warning: atomic replacement still applies, but rename persistence across power loss is not
guaranteed. Sync guarantees depend on the filesystem and storage honoring the sync operation.

If a primary rename succeeds but its directory sync fails, the app keeps the committed live state
and shows a durability error. It does not roll back to a different in-memory version. Saving again
retries the operation; quitting also retries the pending directory sync without rewriting either
file. The app stays open if it still cannot confirm that sync.

If neither `botState.json` nor `botState.json.bak` contains a valid JSON object, the app opens its
shell with recovery instructions and blocks bot-state reads, writes, and scripts. Both files stay
untouched, including on quit. Copy them somewhere safe before repairing a file or restoring a
known-good copy, then use **Restart JS Engine** in the Bot State view. Delete saved state only if
you intentionally want to discard it.

---

## Spam Protection

Add an OpenRouter API key in **Settings**, then enable **Spam Protection** beside the login controls.
The setting is off by default and applies to all servers while this desktop bot is running. The bot
needs Message Content Intent and **Manage Messages** permission in each protected channel. Owners
and members with Administrator, Manage Messages, or Moderate Members permission are exempt.

Protection uses `~typesafe/jev-latest` through OpenRouter's Decisions API, independently of your chat
provider/model. It deletes only the incoming message when the model reports at least 95% spam
probability and prevents that message from triggering commands. It checks scams, phishing,
unsolicited advertising, and repetitive flooding. This threshold is a model judgment, not a
measured accuracy guarantee.

Message text and up to 10 preceding messages from the same author in the same server over 30 seconds
are sent to OpenRouter; API charges apply. History is bounded, kept in memory, and cleared when
protection stops. Message bodies and credentials are not written to moderation logs.

Checks wait at most three seconds, including queue time. API failures, missing permissions, and
queue overload leave messages unchanged; check the **Console** for errors and deletion activity.
Rate limits pause checks temporarily. Invalid credentials or exhausted credits pause checks until
you update Settings or toggle protection. Switching protection off cancels pending checks, but a
Discord deletion already submitted cannot be recalled.

This version checks new text messages only. It skips DMs, bots, webhooks, and attachment-only
messages; edits cancel pending checks and are not reclassified. Earlier messages in a burst are
never deleted. The moving model alias and alpha Decisions endpoint may change upstream.

---

## BCFD Template Language

Command responses use the **BCFD Template Language** — a simple string interpolation syntax that lets you embed dynamic values without writing code.

### Variable Examples

```
$name           → Mentions the triggering user (e.g. @JohnDoe)
$namePlain      → User's display name as plain text
$server         → Server name
$memberCount    → Number of members in the server
$ping           → Bot's websocket ping in ms
$channel        → Current channel name
$date           → Current date and time
$message        → Full message content
$args(0)        → First word after the command trigger
```

### Function Examples

```
$random{heads|tails}              → Randomly picks one option
$rollnum(1, 100)                  → Random number between 1 and 100
$sum(5, 10, 15)                   → Returns 30
$chat(Tell me a joke)             → AI-generated response
$set(score, 10)                   → Store a variable
$get(score)                       → Retrieve a stored variable
```

### Conditionals

```
$if($memberIsOwner)
  Welcome back, boss!
$elseif($args(0) == hello)
  Hey there, $namePlain!
$else
  I don't understand that command.
$endif
```

### JavaScript Eval Blocks

For advanced logic, you can run sandboxed JavaScript:

```
$eval
  botState.count = (botState.count || 0) + 1;
  return "This command has been used " + botState.count + " times.";
$halt
```

`botState` is a persistent object available across all commands. It is saved to disk automatically when the bot shuts down.

### Startup Script

You can write a startup script (JavaScript) that runs once when the bot starts. Use it to initialize `botState` values or set up default variables before any commands are triggered.

For the full language reference, see [`SPECIFICATION.md`](src/main/services/bcfdLang/SPECIFICATION.md).

---

## Library References

- [discord.js](https://discord.js.org/) (Discord API)
- [Svelte](https://svelte.dev/) (Front-end Components)
- [electron-vite](https://electron-vite.org/)
- [electron](https://www.electronjs.org/)
- [TailWind](https://tailwindcss.com/) (CSS)
- [DaisyUI](https://daisyui.com/) (TailWind Component Library)

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode) + [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode) + [Tailwind](https://marketplace.visualstudio.com/items?itemName=bradlc.vscode-tailwindcss)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## External agent access (optional)

Open **Settings → External agent access**, enable the authenticated loopback MCP server, and copy the generated token. The server is disabled by default, binds only to `127.0.0.1`, and stores its token with the operating system's secure credential storage. Keep clients in read-only mode unless you explicitly want an agent to edit the app.

Set `BOT_COMMANDER_MCP_TOKEN` in the environment that launches your MCP client, then use the endpoint shown in Settings (`http://127.0.0.1:43721/mcp` by default). Add the generated snippet to Codex's `config.toml` or Claude Code's `.mcp.json`; Bot Commander does not write client configuration files automatically. Read-write access exposes the same command, interaction, bot-state, startup-JavaScript, developer-prompt, and memory mutations used by the in-app agent, so keep client-side write approvals enabled.
