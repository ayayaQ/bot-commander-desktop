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

export function get(variableName: string, context: ScriptContext) {
  return context.getVariable(variableName)
}

export function set(variableName: string, value: unknown, context: ScriptContext) {
  context.setVariable(variableName, value)
}

function run(code: string, context: ScriptContext) {
  context.run(code, { wrapReturn: false })
}

// This function will take in a string that will have a $eval keyword at the start of a codeblock and a $halt keyword at the end of the codeblock.
// It will then run the code in between the $eval and $halt keywords.
// It will return the output of the code.
export function evaluate(code: string, context: ScriptContext) {
  // throw an error if there is no halt keyword
  if (!code.includes('$halt')) {
    throw new Error('Code block must end with $halt')
  }

  const codeBlock = code.slice(code.indexOf('$eval') + 5, code.indexOf('$halt'))
  run(codeBlock, context)

  // return the code string with the all content between $eval and $halt keywords removed
  return code.slice(0, code.indexOf('$eval')) + code.slice(code.indexOf('$halt') + 6)
}

export function evaluateGet(code: string, context: ScriptContext) {
  // there will be a $get keyword in the form $get(variableName), we will take that and run the get function and replace the $get(variableName) with the return value
  const getStartIndex = code.indexOf('$get(')
  const startIndex = getStartIndex + 5
  const endIndex = code.indexOf(')', startIndex)
  const variableName = code.slice(startIndex, endIndex)
  const value = get(variableName, context)
  // Replace using the exact substring we found
  return code.slice(0, getStartIndex) + value + code.slice(endIndex + 1)
}

export function evaluateSet(code: string, context: ScriptContext) {
  // there will be a $set keyword in the form $set(variableName, value), we will take that and run the set function and replace the $set(variableName, value) with nothing
  const setStartIndex = code.indexOf('$set(')
  const startIndex = setStartIndex + 5
  const commaIndex = code.indexOf(',', startIndex)
  const endIndex = code.indexOf(')', commaIndex)
  const variableName = code.slice(startIndex, commaIndex)
  const value = code.slice(commaIndex + 1, endIndex).trim()
  set(variableName, value, context)
  // Replace using the exact substring we found, removing the entire $set(...) call
  return code.slice(0, setStartIndex) + code.slice(endIndex + 1)
}

export function stringInfoAddEval(code: string, context: ScriptContext) {
  if (code.includes('$eval')) {
    code = evaluate(code, context)
  }
  if (code.includes('$set')) {
    code = evaluateSet(code, context)
  }
  if (code.includes('$get')) {
    code = evaluateGet(code, context)
  }
  return code
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
