/** Build an offline Settings page for an externally hosted headless browser.
 * No browser, Electron, providers, real profiles or credential storage are opened.
 * Run: node scripts/build-settings-credential-fixture.mjs /absolute/output/directory
 */
import { build } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = process.argv[2]
if (!output) throw new Error('Provide a dedicated fixture output directory')
const fixture = await mkdtemp(join(root, '.settings-credential-fixture-'))
try {
  const entry = join(root, 'scripts/fixtures/settings-credentials.js').replaceAll('\\', '/')
  await writeFile(
    join(fixture, 'index.html'),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fake-only Settings credential fixture</title></head>
<body><main id="app"></main><script type="module" src=${JSON.stringify(entry)}></script></body></html>`
  )
  await build({
    configFile: false,
    root: fixture,
    base: './',
    plugins: [svelte()],
    build: { outDir: resolve(output), emptyOutDir: false },
    logLevel: 'warn'
  })
  console.log(JSON.stringify({ output: resolve(output), built: true, browserExecuted: false }))
} finally {
  await rm(fixture, { recursive: true, force: true })
}
