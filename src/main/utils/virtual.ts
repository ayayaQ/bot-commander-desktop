import fs from 'fs/promises'
import { app } from 'electron'
import { join } from 'path'
import { rendererConsole } from './rendererConsole'
import {
  createQuickJSScriptContext,
  type ScriptContext
} from './quickJsScriptContext'

let botStateContext: ScriptContext
const STARTUP_JS_FILENAME = 'startup.js'

function debug(msg: unknown, level: 'info' | 'error' | 'warning' | 'success' = 'info') {
  const message = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)
  if (level === 'error') {
    rendererConsole.error(message)
  } else if (level === 'warning') {
    rendererConsole.warning(message)
  } else if (level === 'success') {
    rendererConsole.success(message)
  } else {
    rendererConsole.info(message)
  }
}

async function createScriptContext(initialContext: Record<string, unknown>): Promise<ScriptContext> {
  return createQuickJSScriptContext({
    initialContext,
    debug
  })
}

// Get the path to the startup JS file
function getStartupJsPath() {
  return join(app.getPath('userData'), STARTUP_JS_FILENAME)
}

// Get the current startup JS (returns string)
export async function getStartupJs(): Promise<string> {
  const path = getStartupJsPath()
  try {
    return await fs.readFile(path, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return ''
    }
    throw error
  }
}

// Set the startup JS (writes string to file)
export async function setStartupJs(js: string): Promise<void> {
  const path = getStartupJsPath()
  await fs.writeFile(path, js, 'utf-8')
}

// Run the startup JS in the given context
export async function runStartupJs(context: ScriptContext) {
  const js = await getStartupJs()
  if (js && js.trim()) {
    try {
      context.run(js, {
        timeoutMs: 5000,
        wrapReturn: false
      })
    } catch (e) {
      console.error('Error running startup JS:', e)
    }
  }
}

// Restart the JS engine: re-create context, run startup JS, load botState
export async function restartJsEngine() {
  botStateContext?.dispose()
  botStateContext = await createScriptContext({ botState: {} })
  await runStartupJs(botStateContext)
  await loadBotState()
}

export async function initializeBotState() {
  botStateContext = await createScriptContext({ botState: {} })
  await runStartupJs(botStateContext)
  await loadBotState()
}

export async function loadBotState() {
  const botStatePath = join(app.getPath('userData'), 'botState.json')
  try {
    const data = await fs.readFile(botStatePath, 'utf-8')
    const loadedState = JSON.parse(data)
    botStateContext.setVariable('botState', loadedState)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, use default empty object
      botStateContext.setVariable('botState', {})
    } else {
      console.error('Error loading bot state:', error)
    }
  }
}

export async function saveBotState() {
  const botStatePath = join(app.getPath('userData'), 'botState.json')
  try {
    const state = JSON.stringify(botStateContext.getVariable('botState') ?? {})
    await fs.writeFile(botStatePath, state)
  } catch (error) {
    console.error('Error saving bot state:', error)
  }
}

export function getBotStateContext() {
  return botStateContext
}
