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
3. Click **Add Bot** (or **Reset Token** if one already exists) and copy your **bot token** — you'll need this in step 3.
4. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required for reading message content).

### 2. Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2 → URL Generator**.
2. Under **Scopes**, check `bot`.
3. Under **Bot Permissions**, select the permissions your bot needs (at minimum: Send Messages, Read Message History).
4. Copy the generated URL, open it in your browser, and select the server to add the bot to.

### 3. Start the App

1. Launch Bot Commander Desktop.
2. Paste your bot token into the **Settings** panel.
3. Click **Start Bot** — your bot is now online.

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
