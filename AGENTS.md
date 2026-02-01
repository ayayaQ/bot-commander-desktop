# AGENTS.md - Agent Instructions for Bot Commander Desktop

This file guides AI agents working on this codebase.

## Build, Lint, and Test Commands

```bash
# Development
npm run dev              # Hot-reload development mode

# Type Checking
npm run typecheck        # Run both Node and Svelte type checks
npm run typecheck:node   # Typecheck main process (src/main)
npm run svelte-check     # Check Svelte components (src/renderer)

# Formatting
npm run format           # Format code with Prettier

# Building
npm run build            # Build (includes typecheck)
npm run build:win        # Build Windows executable
npm run build:mac        # Build macOS executable
npm run build:linux      # Build Linux executable
npm run build:unpack     # Build without packaging
```

**Note:** No test suite is currently configured. Manual testing via `npm run dev` is required.

## Code Style Guidelines

### Formatting

- **Indentation:** 2 spaces (see .editorconfig)
- **Quotes:** Single quotes
- **Semicolons:** Required
- **Line endings:** LF
- **Max line length:** 100 characters
- **Trailing commas:** None

### TypeScript

- Strict mode disabled in tsconfig.json
- Use explicit return types for exported functions
- Type definitions duplicated between `src/main/types/` and `src/renderer/src/types/` - keep them in sync
- Interfaces exported from types files: `BCFDCommand`, `AppSettings`, `BotStatus`

### Naming Conventions

- **Types/Interfaces:** PascalCase (`BCFDCommand`, `AppSettings`)
- **Functions:** camelCase (`getCommands`, `saveSettings`, `setCommands`)
- **Variables:** camelCase (`botService`, `client`)
- **Constants:** SCREAMING_SNAKE_CASE for module-level constants
- **Components:** PascalCase (`CommandEditor.svelte`, `Settings.svelte`)
- **Services:** camelCase ending with `Service` (`botService.ts`, `settingsService.ts`)

### Imports

```typescript
// Node built-ins with node: prefix
import vm from 'node:vm'
import fs from 'fs/promises'

// External libraries
import { BrowserWindow, ipcMain } from 'electron'
import { Client, Events, Message } from 'discord.js'
import OpenAI from 'openai'

// Internal imports
import { getCommands, setCommands } from '../services/botService'
import type { BCFDCommand } from '../types/types'
```

### Error Handling

```typescript
// Try-catch with console.error
try {
  await fs.writeFile(path, data)
} catch (error) {
  console.error('Error saving commands:', error)
}

// IPC handlers: return errors in response object
ipcMain.handle('export-commands', async () => {
  try {
    await fs.writeFile(path, data)
    return { success: true }
  } catch (error) {
    console.error('Error exporting commands:', error)
    return { success: false, error: (error as Error).message }
  }
})
```

### Svelte Components

```svelte
<script lang="ts">
  import { onMount } from 'svelte'
  import { settingsStore } from '../stores/settings'

  let localVar: string
  $: computedValue = derive($settingsStore)

  onMount(() => {
    // Initialize
  })
</script>

<div class="p-4">
  <!-- Use Tailwind/DaisyUI classes -->
</div>
```

### Svelte Stores

```typescript
import { writable, readable } from 'svelte/store'

// Writable store
export const settingsStore = writable<AppSettings>({
  /* defaults */
})

// Load from IPC
export async function loadSettings() {
  const settings = await window.electron.ipcRenderer.invoke('get-settings')
  settingsStore.set(settings)
}

// Save to IPC
export async function saveSettings(newSettings: AppSettings) {
  await window.electron.ipcRenderer.invoke('save-settings', newSettings)
  settingsStore.set(newSettings)
}
```

### IPC Communication

```typescript
// Main process (src/main/handlers/ipcHandlers.ts)
ipcMain.handle('get-commands', () => {
  return getCommands()
})

ipcMain.on('connect', (event, token) => {
  Connect(event, token)
})

ipcMain.handle('save-commands', async (_, newCommands) => {
  setCommands(newCommands)
  await saveCommands()
  return true
})

// Renderer process
await(window as any)
  .electron.ipcRenderer.invoke('get-commands')(window as any)
  .electron.ipcRenderer.send('connect', token)
```

### Discord.js Patterns

```typescript
// Register event handlers
client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return
  // Process message
})

// Check permissions
if (!message.member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
  return
}

// Handle partials
if (message.partial) {
  await message.fetch()
}
```

### BCFD Template Language

Add functions in `src/main/services/bcfdLang/interpreter.ts`:

```typescript
registry.set('myFunction', (args, ctx) => {
  // Return string
  return result
})

// Async function
registry.set('myAsyncFunction', async (args, ctx) => {
  const result = await someAsyncOperation()
  return result
})
```

Variables use `$name` syntax in templates.

## Project Structure

```
src/
├── main/              # Node.js process
│   ├── handlers/      # IPC handlers (ipcHandlers.ts)
│   ├── services/      # Business logic
│   │   ├── botService.ts      # Discord client lifecycle
│   │   ├── bcfdLang/          # Template language
│   │   ├── fileService.ts     # File I/O
│   │   └── settingsService.ts
│   ├── types/         # TypeScript types
│   └── utils/         # Utilities
├── preload/           # Context bridge
└── renderer/          # Svelte UI
    ├── src/
    │   ├── components/   # Svelte components
    │   ├── stores/       # Svelte stores
    │   └── types/        # TypeScript types
```

## Key Gotchas

1. **Type Duplication:** Types exist in both `src/main/types/` and `src/renderer/src/types/`. Keep them synchronized.

2. **Context Isolation Disabled:** Renderer accesses `window.electron` directly (legacy compatibility).

3. **Interpreter Toggle:** Check `settings.useLegacyInterpreter` when modifying template processing.

4. **VM Sandboxing:** Eval blocks in `$eval...$halt` execute in VM with dangerous globals blocked.

5. **Async Template Functions:** Interpreter supports async functions - return Promises.

6. **Data Persistence:** JSON files stored in `app.getPath('userData')` directory.

7. **Command Types:** BCFDCommand.type enum: 0=message, 1=PM, 2=join, 3=leave, 4=ban, 5=reaction.

## Adding Features

- **Discord Event Handler:** Add to `src/main/services/botService.ts` (search `client.on(Events.`)
- **BCFD Function:** Register in `src/main/services/bcfdLang/interpreter.ts`
- **IPC Handler:** Add to `src/main/handlers/ipcHandlers.ts`
- **UI Component:** Create in `src/renderer/src/components/` and import in `App.svelte`
- **Svelte Store:** Create in `src/renderer/src/stores/`
