import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parse } from 'acorn'
import { build } from 'vite'
import { describe, expect, it } from 'vitest'
import { decodeBCFDCommand } from '../commandCodec'
import { createPlaygroundState } from './types'
import type { PlaygroundMessageRequest, PlaygroundResult } from './types'

// Import trusted, freshly built application code in a headless worker. No host eval or
// Function constructor is used. Browser network APIs fail closed and record any use.
const adapter = `
import { parentPort, workerData } from 'node:worker_threads'
const networkCalls = []
for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts']) {
  Object.defineProperty(globalThis, name, {
    value: function () {
      networkCalls.push(name)
      throw new Error('Network disabled in offline worker test: ' + name)
    },
    writable: false,
    configurable: false
  })
}
globalThis.self = globalThis
globalThis.WorkerGlobalScope = class WorkerGlobalScope {}
globalThis.postMessage = (data) => parentPort.postMessage({ ...data, networkCalls: [...networkCalls] })
await import(workerData.entry)
parentPort.on('message', (data) => globalThis.onmessage({ data }))
parentPort.postMessage({ ready: true, networkCalls: [...networkCalls] })
`

type WorkerReply = {
  ready?: boolean
  result?: PlaygroundResult
  error?: string
  networkCalls: string[]
}

function nextReply(worker: Worker, request?: PlaygroundMessageRequest): Promise<WorkerReply> {
  return new Promise((resolveReply, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      worker.off('message', onMessage)
      worker.off('error', onError)
      worker.off('exit', onExit)
    }
    const onMessage = (reply: WorkerReply) => {
      cleanup()
      resolveReply(reply)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code: number) => {
      cleanup()
      reject(new Error(`Offline playground worker exited before replying (${code})`))
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Offline playground worker did not reply'))
    }, 5000)
    worker.once('message', onMessage)
    worker.once('error', onError)
    worker.once('exit', onExit)
    if (request) worker.postMessage(request)
  })
}

function bundledStringLiterals(source: string): string[] {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const strings: string[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as Record<string, unknown>
    if (node.type === 'Literal' && typeof node.value === 'string') strings.push(node.value)
    if (node.type === 'TemplateElement') {
      const text = node.value as { cooked?: string }
      if (typeof text.cooked === 'string') strings.push(text.cooked)
    }
    Object.values(node).forEach(visit)
  }
  visit(ast)
  return strings
}

describe('bundled offline playground worker (headless)', () => {
  it('executes the bundled WASM and round-trips session state without network access', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'playground-offline-worker-'))
    let worker: Worker | undefined
    try {
      // This builds the production worker graph only, independently of existing out/ files.
      await build({
        configFile: false,
        root: resolve('.'),
        logLevel: 'silent',
        build: {
          target: 'esnext',
          outDir: directory,
          emptyOutDir: false,
          minify: false,
          lib: {
            entry: resolve('src/renderer/src/utils/playgroundWorker.ts'),
            formats: ['es'],
            fileName: () => 'playground-worker.mjs'
          },
          rollupOptions: { output: { inlineDynamicImports: true } }
        }
      })
      const entry = join(directory, 'playground-worker.mjs')
      const source = await readFile(entry, 'utf8')
      const strings = bundledStringLiterals(source)
      const wasm = [
        ...new Set(
          strings.filter((value) =>
            /^data:application\/wasm;base64,[A-Za-z0-9+/=]{100,}$/.test(value)
          )
        )
      ]
      expect(wasm).toHaveLength(1)
      const bytes = Buffer.from(wasm[0].split(',')[1], 'base64')
      expect([...bytes.subarray(0, 8)]).toEqual([0, 97, 115, 109, 1, 0, 0, 0])
      expect(bytes.byteLength).toBeGreaterThan(100_000)
      expect(strings.filter((value) => /^(?:https?:)?\/\/.*\.wasm(?:[?#]|$)/i.test(value))).toEqual(
        []
      )

      const wrapper = join(directory, 'worker-adapter.mjs')
      await writeFile(wrapper, adapter)
      worker = new Worker(pathToFileURL(wrapper), {
        workerData: { entry: pathToFileURL(entry).href }
      })
      const ready = await nextReply(worker)
      expect(ready).toEqual({ ready: true, networkCalls: [] })
      const saved = decodeBCFDCommand({
        id: 'offline',
        command: '!offline',
        commandDescription: 'Offline worker regression',
        type: 0,
        channelMessage:
          '$set(label,local)$eval botState.count = (botState.count || 0) + 1; return botState.count; $halt:$get(label)',
        privateMessage: '',
        channelEmbed: {},
        privateEmbed: {},
        cooldown: 1,
        cooldownType: 'User'
      }).command
      const state = createPlaygroundState()
      const input: PlaygroundMessageRequest = {
        state,
        commands: [saved],
        senderId: state.members[0].id,
        content: '!offline'
      }
      const first = await nextReply(worker, input)
      expect(first.error).toBeUndefined()
      expect(first.networkCalls).toEqual([])
      expect(first.result?.errors).toEqual([])
      expect(first.result?.state.botState).toEqual({ count: 1 })
      expect(first.result?.state.variables).toEqual({ label: 'local' })
      expect(first.result?.state.cooldowns).toEqual({ [`offline:user:${input.senderId}`]: 0 })
      expect(first.result?.state.messages.at(-1)?.content).toBe('1:local')
      expect(state.botState).toEqual({})
      expect(state.variables).toEqual({})

      const nextState = structuredClone(first.result!.state)
      nextState.clockMs = 1000
      const second = await nextReply(worker, {
        ...input,
        state: nextState,
        commands: [
          {
            ...saved,
            channelMessage:
              '$eval botState.count += 1; label += " again"; return botState.count; $halt:$get(label)'
          }
        ]
      })
      expect(second.error).toBeUndefined()
      expect(second.networkCalls).toEqual([])
      expect(second.result?.errors).toEqual([])
      expect(second.result?.state.botState).toEqual({ count: 2 })
      expect(second.result?.state.variables).toEqual({ label: 'local again' })
      expect(second.result?.state.cooldowns).toEqual({ [`offline:user:${input.senderId}`]: 1000 })
      expect(second.result?.state.messages.at(-1)?.content).toBe('2:local again')

      const editedGuild = structuredClone(second.result!.state)
      editedGuild.guildId = '456'
      editedGuild.clockMs = 2000
      const parity = await nextReply(worker, {
        ...input,
        state: editedGuild,
        senderId: editedGuild.members[1].id,
        commands: [
          {
            ...saved,
            requiredRole: editedGuild.guildId,
            channelMessage:
              '$set(label,old)$if(true | $set(label,new))ok$endif:$get(label):$eval return new Date(0); $halt'
          }
        ]
      })
      expect(parity.error).toBeUndefined()
      expect(parity.networkCalls).toEqual([])
      expect(parity.result?.errors).toEqual([])
      expect(parity.result?.state.botState).toEqual({ count: 2 })
      expect(parity.result?.state.variables).toEqual({ label: 'new' })
      expect(parity.result?.state.messages.at(-1)?.content).toBe('ok:new:1970-01-01T00:00:00.000Z')
      expect(editedGuild.variables).toEqual({ label: 'local again' })
    } finally {
      if (worker) await worker.terminate()
      await rm(directory, { recursive: true, force: true })
    }
  }, 20_000)
})
