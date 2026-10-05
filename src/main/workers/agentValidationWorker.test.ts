import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { parse } from 'acorn'
import { build } from 'vite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import electronViteConfig, {
  AGENT_VALIDATION_WORKER_FILENAME,
  agentValidationWorkerBuild
} from '../../../electron.vite.config'
import type { AgentValidationRequest } from '../../shared/agentValidationTypes'
import { decodeBCFDCommand } from '../../shared/commandCodec'
import { createPlaygroundState } from '../../shared/playground/types'
import {
  AGENT_VALIDATION_WORKER_FILENAME as SERVICE_WORKER_FILENAME,
  createAgentValidationService
} from '../services/agentValidationService'
import type { Plugin, ResolvedConfig } from 'vite'

function inspectBundle(source: string): { strings: string[]; imports: string[] } {
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const strings: string[] = []
  const imports: string[] = []
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
    if (['ImportDeclaration', 'ImportExpression'].includes(node.type as string)) {
      const target = node.source as { value?: unknown }
      imports.push(typeof target?.value === 'string' ? target.value : '<dynamic>')
    }
    if (node.type === 'CallExpression' && (node.callee as { name?: string })?.name === 'require') {
      const target = (node.arguments as { value?: unknown }[])?.[0]?.value
      imports.push(typeof target === 'string' ? target : '<dynamic require>')
    }
    Object.values(node).forEach(visit)
  }
  visit(ast)
  return { strings, imports }
}

function request(template: string): AgentValidationRequest {
  const state = createPlaygroundState()
  return {
    wrapEvalInIIFE: true,
    candidateKind: 'command',
    candidate: decodeBCFDCommand({
      id: 'offline-candidate',
      command: '!offline',
      commandDescription: 'Offline agent validation worker regression',
      type: 0,
      channelMessage: template,
      privateMessage: '',
      channelEmbed: {},
      privateEmbed: {},
      cooldown: 1,
      cooldownType: 'User'
    }).command,
    candidateHash: 'offline-candidate-hash',
    baseRevision: null,
    fixtureHash: 'offline-fixture-hash',
    suite: {
      cases: [
        {
          name: 'isolated candidate',
          state,
          steps: [
            {
              kind: 'message',
              senderId: state.members[0].id,
              content: '!offline',
              assertions: [
                { path: '/outcome', equals: 'executed' },
                { path: '/effects/messages/0/content', equals: '1:local' }
              ]
            }
          ]
        }
      ]
    }
  }
}

describe('production disposable agent validation worker (headless)', () => {
  let directory: string
  let entry: URL
  let source: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-validation-production-worker-'))
    // Use the exact entry and options used by electron-vite build/dev. No Electron,
    // application index, UI, live services, saved resources or credentials are loaded.
    await build(agentValidationWorkerBuild(directory))
    entry = pathToFileURL(join(directory, AGENT_VALIDATION_WORKER_FILENAME))
    source = await readFile(entry, 'utf8')
    // Packaging verification can point these same headless tests at the real
    // app.asar.unpacked artifact, without starting Electron or the application.
    if (process.env.AGENT_VALIDATION_PACKAGED_WORKER) {
      const packagedEntry = pathToFileURL(resolve(process.env.AGENT_VALIDATION_PACKAGED_WORKER))
      expect(await readFile(packagedEntry, 'utf8')).toBe(source)
      entry = packagedEntry
    }
  }, 20_000)

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('keeps the worker entry unpacked when electron-builder creates app.asar', async () => {
    const builderConfig = await readFile(resolve('electron-builder.yml'), 'utf8')
    const unpack = /asarUnpack:\n((?:  - .+\n)+)/.exec(builderConfig)?.[1] ?? ''
    expect(unpack.split('\n')).toContain(`  - out/main/${SERVICE_WORKER_FILENAME}`)
    const packageConfig = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
    expect(packageConfig.main).toBe('./out/main/index.js')
  })

  it('builds the same sibling entry during initial main builds and watch rebuilds', async () => {
    const config = electronViteConfig as { main: { plugins: Plugin[]; build: unknown } }
    expect(config.main.build).toEqual({
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    })
    expect(SERVICE_WORKER_FILENAME).toBe(AGENT_VALIDATION_WORKER_FILENAME)
    const plugin = config.main.plugins.find(
      (item) => item?.name === 'bundle-disposable-agent-validation-worker'
    )!
    const watched: string[] = []
    const output = join(directory, 'main-build-hook')
    const configure = plugin.configResolved as (config: ResolvedConfig) => void
    configure({ root: resolve('.'), build: { outDir: output } } as ResolvedConfig)
    const write = plugin.writeBundle as (...args: unknown[]) => Promise<void>
    const context = { addWatchFile: (file: string) => watched.push(file) }
    await write.call(context)
    const initial = await readFile(join(output, SERVICE_WORKER_FILENAME), 'utf8')
    expect(initial).toBe(source)
    expect(watched).toContain(resolve('src/main/workers/agentValidationWorker.ts'))
    expect(watched).toContain(resolve('src/shared/playground/agentValidation.ts'))
    expect(watched).toContain(resolve('src/shared/playground/script.ts'))
    // The exact hook runs after each main watch build too; stale chunks aren't reused.
    await write.call(context)
    expect(await readFile(join(output, SERVICE_WORKER_FILENAME), 'utf8')).toBe(source)
    await rm(output, { recursive: true, force: true })
  }, 20_000)

  it('bundles one real inline WASM with no external runtime or privileged imports', async () => {
    expect(await readdir(directory)).toEqual([AGENT_VALIDATION_WORKER_FILENAME])
    const { strings, imports } = inspectBundle(source)
    expect(imports).toEqual(['node:worker_threads'])
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
    expect(
      strings.filter((value) =>
        /^node:(?:fs|http|https|net|tls|dns|child_process|module)/.test(value)
      )
    ).toEqual([])
    expect(source).not.toMatch(/(?:from|require\()\s*['"](?:electron|discord\.js|openai)/)
    expect(source).not.toContain('fileService')
    expect(source).not.toContain('aiProviderService')
    expect(source).not.toContain('botService')
    expect(source).not.toContain('startupScript')
  })

  it('runs inline QuickJS/WASM in the production worker, carries state only within its suite', async () => {
    const workers: Worker[] = []
    const validate = createAgentValidationService({
      workerEntry: entry,
      workerFactory(url, options) {
        const worker = new Worker(url, options)
        workers.push(worker)
        return worker
      }
    })
    const input = request(
      '$set(label,local)$eval botState.count = (botState.count || 0) + 1; return botState.count; $halt:$get(label)'
    )
    input.suite.cases[0].steps.push({
      ...input.suite.cases[0].steps[0],
      advanceClockMs: 1000,
      assertions: [
        { path: '/outcome', equals: 'executed' },
        { path: '/effects/messages/0/content', equals: '2:local' }
      ]
    })
    input.suite.cases.push({
      name: 'fresh case fixture',
      state: structuredClone(input.suite.cases[0].state),
      steps: [structuredClone(input.suite.cases[0].steps[0])]
    })
    const original = structuredClone(input)
    const first = await validate(input)
    expect(first.outcome).toBe('passed')
    expect(first.coverage.executed).toBe(3)
    expect(first.cases[0].steps[0].effects.messages[0].content).toBe('1:local')
    expect(first.cases[0].steps[1].effects.messages[0].content).toBe('2:local')
    expect(first.cases[1].steps[0].effects.messages[0].content).toBe('1:local')
    expect(input).toEqual(original)
    expect(workers[0].threadId).toBe(-1)
    const second = await validate(input)
    expect(second.outcome).toBe('passed')
    expect(second.cases[0].steps[0].effects.messages[0].content).toBe('1:local')
    expect(workers).toHaveLength(2)
    expect(workers[1].threadId).toBe(-1)
  }, 15_000)

  it.each(['$definitelyNotARealBCFDFunction(no)', 'Bad $definitelyNotARealVariable'])(
    'reports unknown BCFD expressions as errors rather than unsupported: %s',
    async (template) => {
      const validate = createAgentValidationService({ workerEntry: entry })
      const report = await validate(request(template))
      expect(report.outcome).toBe('failed')
      expect(report.coverage.errors).toBe(1)
      expect(report.coverage.unsupported).toBe(0)
      expect(report.coverage.executed).toBe(0)
      const step = report.cases[0].steps[0]
      expect(step.executionOutcome).toBe('error')
      expect(step.errors.join(' ')).toContain('Unknown BCFD expression')
      expect(step.effects).toEqual({
        messages: [],
        deletedMessageIds: [],
        memberChanges: [],
        botStateChanges: [],
        variableChanges: [],
        cooldownChanges: []
      })
    },
    10_000
  )

  it('keeps known unimplemented BCFD operations structurally unsupported and matched', async () => {
    const validate = createAgentValidationService({ workerEntry: entry })
    const report = await validate(request('$createChannel(no)'))
    expect(report.outcome).toBe('unsupported')
    expect(report.coverage.unsupported).toBe(1)
    expect(report.coverage.executed).toBe(0)
    const step = report.cases[0].steps[0]
    expect(step.executionOutcome).toBe('unsupported')
    expect(step.matched).toBe(true)
    expect(step.effects.messages).toEqual([])
  }, 10_000)

  it('has no host globals available to user JavaScript', async () => {
    const validate = createAgentValidationService({ workerEntry: entry })
    const input = request(
      '$eval return [typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof WebSocket, typeof parentPort].join(":"); $halt'
    )
    input.suite.cases[0].steps[0].assertions = [
      { path: '/outcome', equals: 'executed' },
      {
        path: '/effects/messages/0/content',
        equals: 'undefined:undefined:undefined:undefined:undefined:undefined'
      }
    ]
    const report = await validate(input)
    expect(report.outcome).toBe('passed')
    expect(report.coverage.executed).toBe(1)
  }, 10_000)

  it('keeps the main event loop responsive while interrupting runaway user code', async () => {
    const validate = createAgentValidationService({ workerEntry: entry })
    const input = request('$eval while (true) {} $halt')
    let ticks = 0
    const heartbeat = setInterval(() => ticks++, 10)
    const started = Date.now()
    try {
      const report = await validate(input)
      expect(ticks).toBeGreaterThan(5)
      expect(Date.now() - started).toBeLessThan(3500)
      expect(report.outcome).not.toBe('passed')
      expect(report.coverage.executed).toBe(0)
      expect(report.coverage.errors + report.coverage.notRun).toBeGreaterThan(0)
    } finally {
      clearInterval(heartbeat)
    }
  }, 10_000)

  it('enforces the outer deadline by terminating the actual worker', async () => {
    const workers: Worker[] = []
    const validate = createAgentValidationService({
      workerEntry: entry,
      timeoutMs: 150,
      workerFactory(url, options) {
        const worker = new Worker(url, options)
        workers.push(worker)
        return worker
      }
    })
    const report = await validate(request('$eval while (true) {} $halt'))
    expect(report.outcome).toBe('not_run')
    expect(report.timedOut).toBe(true)
    expect(report.coverage.executed).toBe(0)
    expect(report.coverage.notRun).toBe(1)
    expect(workers[0].threadId).toBe(-1)
  }, 10_000)

  it('terminates the actual worker on cancellation without claiming any passes', async () => {
    const workers: Worker[] = []
    const validate = createAgentValidationService({
      workerEntry: entry,
      workerFactory(url, options) {
        const worker = new Worker(url, options)
        workers.push(worker)
        return worker
      }
    })
    const controller = new AbortController()
    const pending = validate(request('$eval while (true) {} $halt'), controller.signal)
    controller.abort()
    const report = await pending
    expect(report.outcome).toBe('not_run')
    expect(report.cancelled).toBe(true)
    expect(report.coverage.executed).toBe(0)
    expect(workers[0].threadId).toBe(-1)
  }, 10_000)
})
