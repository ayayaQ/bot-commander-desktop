# Bot Commander Desktop - AI Agent Instructions

## Project Overview

An Electron desktop app for creating and hosting Discord bots without code. Users design bot commands via a GUI; responses use the **BCFD Template Language** (a string interpolation DSL) with variables (`$name`, `$server`), functions (`$random{a|b}`, `$rollnum(1,100)`), and JavaScript evaluation blocks (`$eval...$halt`).

**Stack**: Electron + Vite, TypeScript, Svelte, Tailwind/DaisyUI, discord.js

## Architecture

### Three-Process Electron Model

- **Main** (`src/main/`): Node.js process handling Discord client, IPC handlers, file I/O, VM execution
- **Preload** (`src/preload/`): Bridge exposing `electron.ipcRenderer` to renderer (context isolation disabled for legacy reasons)
- **Renderer** (`src/renderer/`): Svelte UI with stores for state management

### Core Services (`src/main/services/`)

- **botService.ts**: Discord.js client lifecycle, event handlers (message, join, leave, ban, reaction), command execution
- **stringInfo.ts**: BCFD template engine orchestrator - delegates to interpreter or legacy string replacement based on settings
- **fileService.ts**: JSON persistence for commands, settings, bot status in `app.getPath('userData')`
- **virtual.ts**: VM sandbox for `$eval` blocks and persistent `botState` object; startup.js execution
- **bcfdLang/**: Custom interpreter with tokenizer → parser → AST → evaluation pipeline (see `SPECIFICATION.md`)

### Key Data Flow

1. User edits command in `CommandEditor.svelte` → saves via IPC (`save-commands`)
2. Discord event fires → `botService` matches trigger type → executes command actions
3. Response strings pass through `stringInfoAdd()` → bcfdLang interpreter resolves variables/functions/eval blocks
4. Output sent via discord.js (channel message, DM, embed, reaction, moderation action)

## BCFD Template Language

**Location**: `src/main/services/bcfdLang/` (tokenizer, parser, interpreter) + `SPECIFICATION.md`

**Key Concepts**:

- Variables: `$name` (user mention), `$server`, `$ping`, `$args(0)`, `$botState.variableName`
- Functions: `$random{opt1|opt2}`, `$rollnum(1,100)`, `$sum(1,2,3)`, `$get(key)`, `$set(key,val)`
- Eval blocks: `$eval botState.count++; return botState.count; $halt` (executes in VM context)
- Nesting: `$random{$name|$botName}` resolves inner expressions first
- Legacy mode: Toggle `useLegacyInterpreter` in settings to use old regex-based replacement

**Adding New Functions**: Register in `interpreter.ts` function registry with signature `(args: string[], ctx: BCFDContext) => string | Promise<string>`

## Development Workflows

### Running the App

```bash
npm run dev          # Hot-reload development mode
npm run build:win    # Production build for Windows
```

### Type Checking

```bash
npm run typecheck    # Runs both Node and Svelte checks
```

### IPC Communication Pattern

**Main → Renderer**: Use `BrowserWindow.webContents.send('event-name', data)` (one-way)  
**Renderer → Main**:

- Send: `(window as any).electron.ipcRenderer.send('event-name', data)`
- Invoke: `await (window as any).electron.ipcRenderer.invoke('event-name', data)` (request/response)
- Handlers: Registered in `ipcHandlers.ts` with `ipcMain.on()` or `ipcMain.handle()`

**Example**: Saving commands calls `ipcRenderer.invoke('save-commands', commands)` → handled in `ipcHandlers.ts` → calls `setCommands()` + `saveCommands()`

## Project-Specific Conventions

### Command Types (BCFDCommand.type)

- `0`: Message received in server
- `1`: PM received
- `2`: Member join
- `3`: Member leave
- `4`: Member ban
- `5`: Reaction add

**Defined in**: `src/main/types/types.ts` and `src/renderer/src/types/types.ts` (duplicated for type safety across processes)

### State Management

- **Renderer**: Svelte stores in `src/renderer/src/stores/` (writable/readable patterns)
  - `connection.ts`: Bot login state
  - `settings.ts`: App preferences (theme, API keys, interpreter toggle)
  - `console.ts`: Real-time logs from main process via IPC listeners
- **Main**: Singleton services (`getSettings()`, `getBotStatus()`, etc.) load from JSON on startup

### Persistent Bot State

`botState` object in VM context (`virtual.ts`) persists across command executions. Saved to `botState.json` on shutdown. Use `$set(key, value)` and `$get(key)` or access in eval blocks: `botState.myVar = 42`.

### Stats Tracking

`Stats` singleton (`utils/stats.ts`) tracks messages received, commands executed, users/servers. Updated via `stats.increment*()` methods in `botService.ts` event handlers.

### Custom Title Bar

Frameless window (`frame: false` in `main/index.ts`). `TitleBar.svelte` handles minimize/maximize/close via IPC events (`minimize-window`, etc.).

### Localization

Translations in `stores/localisation.ts` with `$t()` function. Supports English/Spanish. Add new keys to both language objects.

## Critical Gotchas

- **Context Isolation Disabled**: Preload sets `contextIsolation: false` for legacy compatibility. Renderer accesses `window.electron` directly.
- **Two Type Files**: `types.ts` exists in both `main/types/` and `renderer/src/types/`. Keep command/settings types synchronized.
- **Interpreter Toggle**: Always check `settings.useLegacyInterpreter` when modifying template processing. New features must work in both modes or gracefully degrade.
- **VM Sandboxing**: Eval blocks block dangerous globals (`require`, `process`, etc.) in `createSafeContext()`. Only `Math`, `Date`, `botState`, and safe built-ins allowed.
- **Async Template Functions**: Interpreter supports `async` functions (e.g., OpenAI calls). Return promises and await in `interpret()`.

## Key Files for Common Tasks

- **Add Discord Event Handler**: `src/main/services/botService.ts` (search for `client.on(Events.`)
- **Add BCFD Function**: `src/main/services/bcfdLang/interpreter.ts` (register in `createFunctionRegistry()`)
- **Modify Command Structure**: Update both `src/main/types/types.ts` and `src/renderer/src/types/types.ts`
- **Add UI Component**: `src/renderer/src/components/` (Svelte) + import in `App.svelte`
- **Add IPC Handler**: `src/main/handlers/ipcHandlers.ts` + call from renderer store
- **Debugging Templates**: Enable dev tools in renderer, check `console.ts` store for interpreter errors

## External Dependencies

- **discord.js v14**: Main API surface for bot operations. Use new intent/partition system.
- **OpenAI**: Optional AI completion feature (configured in settings). Used in some template functions if API key set.
- **electron-vite**: Build system. Config in `electron.vite.config.ts` (separate main/preload/renderer builds).
- **DaisyUI**: Tailwind component classes (e.g., `btn`, `card`, `modal`). Theme set via `data-theme` attribute.
