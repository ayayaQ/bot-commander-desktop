import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runOrdinaryPlayground, selectedFiles, vitestArgs } from './test-playground.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const runner = fileURLToPath(new URL('./test-playground.mjs', import.meta.url))
const files = selectedFiles()

function fixtureRun(transform = (report) => report, childResult = { status: 0 }) {
  const calls = [],
    logs = [],
    summaries = [],
    paths = []
  const status = runOrdinaryPlayground({
    spawn(node, args, options) {
      const selection = files[calls.length]
      calls.push({ node, args, options })
      const path = args.at(-1)
      paths.push(path)
      writeFileSync(
        path,
        JSON.stringify(
          transform({
            testResults: [
              {
                assertionResults: selection.names.map((fullName) => ({
                  fullName,
                  status: 'passed'
                }))
              }
            ]
          })
        )
      )
      return childResult
    },
    log: (line) => logs.push(line),
    summary: (report) => summaries.push(report)
  })
  return { status, calls, logs, summaries, paths }
}

test('locks the ordinary files and escapes exact test names, including punctuation', () => {
  assert.deepEqual(
    files.map(({ file }) => file),
    [
      'src/shared/playground/engine.test.ts',
      'src/shared/playground/execution.test.ts',
      'src/shared/playground/interactions.test.ts',
      'src/shared/playground/runtimeV2.test.ts',
      'src/shared/playground/world.test.ts',
      'src/shared/playground/cascades.test.ts',
      'src/shared/playground/referenceAcceptance.test.ts',
      'src/main/services/agentReferenceWorkflow.test.ts'
    ]
  )
  for (const selection of files) {
    assert.ok(existsSync(new URL(`../${selection.file}`, import.meta.url)))
    assert.equal(new Set(selection.names).size, selection.names.length)
    const args = vitestArgs(selection, '/fixture/report.json')
    assert.deepEqual(args.slice(1, 4), ['run', selection.file, '--testNamePattern'])
    const pattern = new RegExp(args[4])
    for (const name of selection.names) {
      assert.ok(pattern.test(name), name)
      assert.equal(pattern.test(`${name} restricted followup`), false)
      assert.equal(pattern.test(`another suite ${name}`), false)
    }
  }
  const role = files.find(({ file }) => file.endsWith('/world.test.ts'))
  const pattern = new RegExp(vitestArgs(role, '/fixture/report.json')[4])
  assert.equal(
    pattern.test(
      "normalized role creation preserves role flags and accepts the next event: '$createRole(NewRole,#112233)'"
    ),
    true
  )
  assert.equal(
    pattern.test(
      'normalized role creation preserves role flags and accepts the next event: createRoleXNewRole,#112233X'
    ),
    false
  )
})

test('keeps nonordinary and unreviewed cases out of every positive selector', () => {
  const omittedNames = [
    'isolated playground message simulation preserves earlier effects while evaluating the production behavior of $eval while(true){} $halt',
    'isolated playground message simulation bounds inputs, command count, transcript size, templates and amplified outputs',
    'playground command execution state rolls back an attempt to replace the required botState object with a scalar',
    'playground command execution state safely converts script results after an explicit variable shadows the String global',
    'playground eval template resolution preserves an explicit variable whose name resembles an interpolation binding',
    'playground eval template resolution keeps runtime conversion and snapshot helpers out of the script global namespace',
    'saved interaction playground handles legitimate prototype-like option names as inert own values',
    'saved interaction playground honors action flags and does not evaluate inactive stale payloads',
    'saved interaction playground keeps option text inert rather than reparsing it as template code',
    'normalized multi-guild world retains v2 numeric IDs and offers an explicit string migration without rounding',
    'normalized multi-guild world rejects invalid membership references',
    'normalized role creation rejects a non-boolean role hoist flag',
    'offline gateway cascades rejects invalid fixture cascade limits { maxDepth: 0 }',
    'offline gateway cascades fails closed on event/work budget exhaustion even if assertions expect the partial effects',
    'offline gateway cascades terminates a host-driven causal loop with { maxDepth: 3 }'
  ]
  for (const selection of files) {
    const pattern = new RegExp(vitestArgs(selection, '/fixture/report.json')[4])
    for (const name of omittedNames) assert.equal(pattern.test(name), false, name)
  }
})

test('runs only the selected files with Node and reports bounded CI success', () => {
  const result = fixtureRun()
  assert.equal(result.status, 0)
  assert.equal(result.calls.length, files.length)
  result.calls.forEach(({ node, args, options }, index) => {
    assert.equal(node, process.execPath)
    assert.deepEqual(args, vitestArgs(files[index], result.paths[index]))
    assert.deepEqual(options, { cwd: root, stdio: 'inherit' })
  })
  assert.equal(result.summaries.length, 1)
  assert.match(result.summaries[0], /8\/8 selected files passed/)
  assert.match(
    result.summaries[0],
    /No rendered, native, live Discord or provider validation is claimed/
  )
  assert.ok(result.paths.every((path) => !existsSync(path)))
})

for (const [name, transform] of [
  [
    'all skipped',
    (report) => {
      report.testResults[0].assertionResults.forEach((test) => {
        test.status = 'pending'
      })
      return report
    }
  ],
  [
    'missing selected name',
    (report) => {
      report.testResults[0].assertionResults.pop()
      return report
    }
  ],
  [
    'unexpected executed name',
    (report) => {
      report.testResults[0].assertionResults[0].fullName += ' unreviewed'
      return report
    }
  ],
  [
    'duplicate executed name',
    (report) => {
      report.testResults[0].assertionResults[0] = report.testResults[0].assertionResults[1]
      return report
    }
  ],
  [
    'failed assertion despite zero exit',
    (report) => {
      report.testResults[0].assertionResults[0].status = 'failed'
      return report
    }
  ]
]) {
  test(`rejects ${name} and reports failure in the CI summary`, () => {
    const result = fixtureRun(transform)
    assert.equal(result.status, 1)
    assert.match(result.summaries[0], /0\/8 selected files passed/)
    assert.match(result.summaries[0], /FAIL/)
    assert.ok(result.logs.some((line) => /names\/counts differ/.test(line)))
    if (name === 'failed assertion despite zero exit') {
      assert.match(result.summaries[0], /14\/15 tests/)
    }
  })
}

for (const childResult of [
  { status: 1 },
  { status: null, signal: 'SIGTERM' },
  { status: null, error: new Error('fixture launch error') }
]) {
  test(`propagates child failure ${childResult.error?.message ?? childResult.signal ?? childResult.status}`, () => {
    const result = fixtureRun(undefined, childResult)
    assert.equal(result.status, 1)
    assert.equal(result.calls.length, files.length)
    assert.match(result.summaries[0], /0\/8 selected files passed/)
  })
}

test('fails closed on missing or malformed reports', () => {
  for (const write of [() => {}, (path) => writeFileSync(path, 'invalid json')]) {
    const summaries = []
    const status = runOrdinaryPlayground({
      spawn(_node, args) {
        write(args.at(-1))
        return { status: 0 }
      },
      log() {},
      summary: (report) => summaries.push(report)
    })
    assert.equal(status, 1)
    assert.match(summaries[0], /0\/8 selected files passed/)
    assert.match(summaries[0], /results unavailable; 15 selected/)
  }
})

test('reports actual passed counts even when a child exits nonzero', () => {
  const result = fixtureRun(
    (report) => {
      report.testResults[0].assertionResults[0].status = 'failed'
      return report
    },
    { status: 1 }
  )
  assert.equal(result.status, 1)
  assert.match(result.summaries[0], /FAIL: .*engine.test.ts.*14\/15 tests/)
})

test('reports thrown launch errors and cleans up temporary reports', () => {
  const paths = [],
    summaries = []
  const status = runOrdinaryPlayground({
    spawn(_node, args) {
      paths.push(args.at(-1))
      throw new Error('fixture thrown launch error')
    },
    log() {},
    summary: (report) => summaries.push(report)
  })
  assert.equal(status, 1)
  assert.equal(paths.length, files.length)
  assert.ok(paths.every((path) => !existsSync(path)))
  assert.match(summaries[0], /results unavailable; 15 selected/)
})

test('--list is read-only and CLI cannot broaden the selection', () => {
  const listed = spawnSync(process.execPath, [runner, '--list'], { encoding: 'utf8' })
  assert.equal(listed.status, 0)
  assert.deepEqual(JSON.parse(listed.stdout), files)
  for (const extra of [
    ['src/shared/playground/script.test.ts'],
    ['--', '--passWithNoTests'],
    ['--list', '--all']
  ]) {
    const result = spawnSync(process.execPath, [runner, ...extra], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /test overrides are not accepted/)
    assert.doesNotMatch(result.stdout, /Ordinary Playground:/)
  }
})
