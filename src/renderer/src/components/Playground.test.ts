import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { compile, parse } from 'svelte/compiler'
import { transpileModule, ScriptTarget } from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  createPlaygroundFixture,
  type PlaygroundRequest,
  type PlaygroundResult
} from '../../../shared/playground'
import { decodeBCFDCommand } from '../../../shared/commandCodec'

const source = readFileSync(new URL('./Playground.svelte', import.meta.url), 'utf8')
const ast = parse(source, { modern: true })

// Exercise the component's actual async handlers without introducing a DOM test
// dependency. Rendering and accessibility are checked by the Svelte compiler;
// this harness provides only their state/worker collaborators, not copied logic.
function createHarness(run: (request: PlaygroundRequest) => Promise<PlaygroundResult>) {
  const fixture = createPlaygroundFixture()
  const context = {
    generation: 1,
    nextTurnId: 0,
    busy: false,
    loading: false,
    message: '!ping',
    validationError: '',
    botStateDraft: '{}',
    turns: [],
    fixture,
    senderId: fixture.members[0].id,
    sender: fixture.members[0],
    selected: [
      decodeBCFDCommand({
        command: '!ping',
        commandDescription: '',
        type: 0,
        channelMessage: 'Pong',
        privateMessage: '',
        channelEmbed: null,
        privateEmbed: null
      }).command
    ],
    selectedInteraction: undefined,
    interactionOptions: {},
    composer: { focus: vi.fn() },
    createPlaygroundFixture,
    $state: { snapshot: (value: unknown) => structuredClone(value) },
    runPlayground: run,
    scrollToLatest: vi.fn(async () => undefined),
    tick: async () => undefined
  }
  const handlers = ast.instance.content.body
    .filter(
      (node) =>
        node.type === 'FunctionDeclaration' && ['reset', 'sendMessage'].includes(node.id.name)
    )
    .map((node) => {
      const ranged = node as typeof node & { start: number; end: number }
      return source.slice(ranged.start, ranged.end)
    })
    .join('\n')
  const compiled = transpileModule(handlers, {
    compilerOptions: { target: ScriptTarget.ES2022 }
  }).outputText
  const controls = runInNewContext(`${compiled}\n({ reset, sendMessage })`, context) as {
    reset: () => void
    sendMessage: () => Promise<void>
  }
  return { context, ...controls }
}

function deferredResult() {
  let resolve: (value: PlaygroundResult) => void
  let reject: (reason: Error) => void
  const promise = new Promise<PlaygroundResult>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve: resolve!, reject: reject! }
}

function result(): PlaygroundResult {
  return {
    fixture: createPlaygroundFixture(),
    outputs: [],
    traces: [],
    stateBefore: {},
    stateAfter: {}
  }
}

describe('playground UI safety and interrupted flows', () => {
  it('compiles the component without compiler or accessibility warnings', () => {
    const compiled = compile(source, { filename: 'Playground.svelte', generate: 'client' })
    expect(compiled.warnings).toEqual([])
  })

  it('uses only the read-only commands IPC and no live service imports or remote media tags', () => {
    const calls = [...source.matchAll(/ipcRenderer\.(\w+)\(\s*['"]([^'"]+)['"]/g)]
    expect(calls.map((match) => [match[1], match[2]])).toEqual([
      ['invoke', 'get-commands'],
      ['invoke', 'get-interactions']
    ])
    const imports = ast.instance.content.body.filter((node) => node.type === 'ImportDeclaration')
    expect(imports.map((node) => node.source.value)).toEqual([
      'svelte',
      '../../../shared/commandCodec',
      '../../../shared/playground',
      '../playground/client',
      '../types/types'
    ])
    expect(source).not.toMatch(/<(img|video|audio|iframe|object|embed)\b/i)
    expect(source).not.toContain('{@html')
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage)\b/)
  })

  it('keeps the core safety and unsupported-feature notices outside collapsed details', () => {
    const beforeDetails = source.slice(source.indexOf('<section'), source.indexOf('<details'))
    expect(beforeDetails).toContain('Simulation only. No real Discord effects.')
    expect(beforeDetails).toContain(
      'Limited offline subset: scripts, AI, botState writes, cooldowns, and message deletion'
    )
  })

  it('keeps the selector usable when only slash commands are loaded', () => {
    expect(source).toContain(
      'disabled={busy || loading || (!commands.length && !interactions.length)}'
    )
  })

  it('snapshots the request and ignores duplicate sends while a run is in flight', async () => {
    const deferred = deferredResult()
    const run = vi.fn((_request: PlaygroundRequest) => deferred.promise)
    const harness = createHarness(run)
    const pending = harness.sendMessage()
    expect(harness.context.busy).toBe(true)
    expect(harness.context.turns).toHaveLength(1)
    harness.context.message = '!ping'
    await harness.sendMessage()
    expect(run).toHaveBeenCalledTimes(1)
    const request = run.mock.calls[0][0] as PlaygroundRequest
    expect(request.fixture).not.toBe(harness.context.fixture)
    expect(request.fixture.members).not.toBe(harness.context.fixture.members)
    expect(request.commands).not.toBe(harness.context.selected)
    deferred.resolve(result())
    await pending
    expect(harness.context.busy).toBe(false)
  })

  it('reset restores fake state and discards a result arriving after reset', async () => {
    const deferred = deferredResult()
    const harness = createHarness(() => deferred.promise)
    const pending = harness.sendMessage()
    harness.context.fixture.members[1].status = 'banned'
    harness.context.fixture.botState = { dirty: true }
    harness.reset()
    expect(harness.context.busy).toBe(false)
    expect(harness.context.turns).toEqual([])
    expect(harness.context.fixture).toEqual(createPlaygroundFixture())
    expect(harness.context.botStateDraft).toBe('{}')
    const old = result()
    old.fixture.members[0].status = 'kicked'
    deferred.resolve(old)
    await pending
    expect(harness.context.fixture).toEqual(createPlaygroundFixture())
    expect(harness.context.turns).toEqual([])
  })

  it('an old rejected run cannot clear a newer run after reset', async () => {
    const first = deferredResult()
    const second = deferredResult()
    const run = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const harness = createHarness(run)
    const old = harness.sendMessage()
    harness.reset()
    harness.context.message = '!ping again'
    const current = harness.sendMessage()
    first.reject(new Error('Late worker failure'))
    await old
    expect(harness.context.busy).toBe(true)
    expect(harness.context.turns).toHaveLength(1)
    second.resolve(result())
    await current
    expect(harness.context.busy).toBe(false)
    expect(harness.context.turns).toHaveLength(1)
  })

  it('rejects invalid fake state before adding a message or starting a worker', async () => {
    const run = vi.fn(async () => result())
    const harness = createHarness(run)
    harness.context.botStateDraft = '[]'
    await harness.sendMessage()
    expect(run).not.toHaveBeenCalled()
    expect(harness.context.turns).toEqual([])
    expect(harness.context.validationError).toContain('JSON object')
  })

  it('falls back to another active sender after a simulated kick', async () => {
    const response = result()
    response.fixture.members[0].status = 'kicked'
    const harness = createHarness(async () => response)
    await harness.sendMessage()
    expect(harness.context.senderId).toBe(response.fixture.members[1].id)
  })
})
