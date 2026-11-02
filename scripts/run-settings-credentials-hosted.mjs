/** Supply the prepared A4 interaction runner with an isolated hosted fixture and browser.
 * Hosted Linux only. Local validation: node --check scripts/run-settings-credentials-hosted.mjs
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

assert(
  process.platform === 'linux' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    process.env.RUNNER_OS === 'Linux',
  'Settings browser orchestration requires the authorized hosted Linux job'
)
assert.equal(process.argv.length, 2, 'No orchestration arguments are supported')
assert(process.env.CHROMIUM_PATH, 'Supply the installed Chromium executable')
assert(process.env.SETTINGS_UI_REPORT, 'Supply a task-owned JSON evidence path')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const report = {
  passed: false,
  browserExecuted: false,
  provenance: {
    sha: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    dirty: git('status', '--porcelain', '--untracked-files=normal') !== ''
  },
  hosted: { runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT },
  teardown: {},
  limitations: ['Actual Settings component with fake in-memory IPC; no native storage or providers']
}
assert.equal(report.provenance.dirty, false, 'Hosted evidence requires an exact clean checkout')

function deadline(promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

const children = []
function start(executable, args, options = {}) {
  const child = spawn(executable, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  })
  const result = { child, stdout: '', stderr: '' }
  // Observe launch errors immediately so a missing executable cannot become an unhandled event.
  result.exited = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error: String(error) }))
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  child.stdout.on('data', (data) => {
    result.stdout = (result.stdout + String(data)).slice(-100000)
  })
  child.stderr.on('data', (data) => {
    result.stderr = (result.stderr + String(data)).slice(-20000)
  })
  children.push(result)
  return result
}

async function runNode(args, milliseconds) {
  const processRun = start(process.execPath, args)
  const exit = await deadline(processRun.exited, milliseconds, args[0])
  if (exit.code !== 0 || exit.error || exit.signal)
    throw new Error(JSON.stringify({ args, exit, stderr: processRun.stderr }))
  return processRun.stdout
}

let directory
let server
let failure
let phase = 'fixture build'
try {
  directory = await mkdtemp(join(tmpdir(), 'settings-credentials-hosted-'))
  const output = join(directory, 'fixture')
  await runNode(['scripts/build-settings-credential-fixture.mjs', output], 60000)
  phase = 'fixture server'
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      const path = resolve(
        output,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      )
      if (!path.startsWith(output + sep)) throw new Error('Outside fixture')
      const content = await readFile(path)
      response.writeHead(200, {
        'Content-Type': types[extname(path)] || 'application/octet-stream'
      })
      response.end(content)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  phase = 'Chromium startup'
  const chromium = start(
    process.env.CHROMIUM_PATH,
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--user-data-dir=' + join(directory, 'profile'),
      'about:blank'
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        LANG: 'C.UTF-8',
        XDG_CONFIG_HOME: join(directory, 'config'),
        XDG_CACHE_HOME: join(directory, 'cache')
      }
    }
  )
  const endpoint = await deadline(
    Promise.race([
      new Promise((resolveEndpoint) => {
        chromium.child.stderr.on('data', () => {
          const match = chromium.stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)
          if (match) resolveEndpoint(match[1])
        })
      }),
      chromium.exited.then((exit) => {
        throw new Error(JSON.stringify({ exit, stderr: chromium.stderr }))
      })
    ]),
    15000,
    'Chromium startup'
  )
  report.browserExecuted = true
  phase = 'Settings credential DOM flow'
  const stdout = await runNode(
    [
      'scripts/test-settings-credentials-ui.mjs',
      '--fixture-url',
      `http://127.0.0.1:${server.address().port}/`,
      '--browser-ws',
      endpoint
    ],
    90000
  )
  report.result = JSON.parse(stdout)
  assert.equal(report.result.passed, true, 'Prepared runner must confirm passed')
} catch (error) {
  failure = error
  report.failure = { phase, error: error.stack || String(error) }
} finally {
  const errors = []
  for (const { child, exited } of children.reverse()) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      try {
        await deadline(exited, 5000, 'Child termination')
      } catch {
        child.kill('SIGKILL')
        try {
          await deadline(exited, 5000, 'Child forced termination')
        } catch (error) {
          errors.push(String(error))
        }
      }
    }
  }
  report.teardown.childrenExited = children.every(
    ({ child }) => !child.pid || child.exitCode !== null || child.signalCode !== null
  )
  if (server) {
    server.closeAllConnections()
    await new Promise((resolveClose) => server.close(resolveClose))
  }
  report.teardown.serverClosed = !server?.listening
  if (directory && report.teardown.childrenExited) {
    try {
      await rm(directory, { recursive: true, force: true })
      report.teardown.fixtureRemoved = true
    } catch (error) {
      errors.push(String(error))
    }
  }
  report.teardown.errors = errors
  if (errors.length || !report.teardown.childrenExited || !report.teardown.serverClosed)
    failure ??= new Error('Settings orchestration teardown failed')
  report.passed = !failure
  const path = resolve(process.env.SETTINGS_UI_REPORT)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
if (failure) throw failure
