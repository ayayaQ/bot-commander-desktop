import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  builderArgs,
  externalPath,
  isolatedEnvironment,
  nativeTarget,
  options,
  runBounded,
  writeReport
} from './native-package-support.mjs'

const checkout = fileURLToPath(new URL('../', import.meta.url))
const input = options(process.argv.slice(2), ['output', 'report'])
assert.ok(
  input.output && input.report,
  'Usage: node scripts/package-native.mjs --output <new external directory> --report <external JSON>'
)
const output = externalPath(checkout, input.output)
const reportFile = externalPath(checkout, input.report)
assert.ok(
  !fs.existsSync(output),
  'Use a fresh output directory; this helper never deletes artifacts'
)
const target = nativeTarget()
assert.ok(fs.existsSync(path.join(checkout, 'out/main/index.js')), 'Run npm run build first')
fs.mkdirSync(path.dirname(output), { recursive: true })
const scratch = fs.mkdtempSync(path.join(path.dirname(output), 'a7-package-'))
const args = builderArgs(target, output, path.join(checkout, 'node_modules/electron/dist'))
let report
try {
  const child = runBounded(
    process.execPath,
    [path.join(checkout, 'node_modules/electron-builder/out/cli/cli.js'), ...args],
    {
      cwd: checkout,
      env: { ...isolatedEnvironment(scratch), CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      timeout: 10 * 60_000
    }
  )
  report = {
    schemaVersion: 1,
    stage: 'unpacked-package',
    status: child.exitCode === 0 && !child.error ? 'passed' : 'failed',
    host: { ...target, node: process.versions.node },
    command: [process.execPath, 'node_modules/electron-builder/out/cli/cli.js', ...args],
    output,
    distribution: 'not_run',
    signing: 'disabled',
    notarization: 'disabled',
    ...child
  }
} finally {
  // Only remove the exact unique scratch directory created by this invocation.
  fs.rmSync(scratch, { recursive: true, force: true })
}
report.scratchCleanup = !fs.existsSync(scratch)
writeReport(reportFile, report)
process.exitCode = report.status === 'passed' ? 0 : 1
