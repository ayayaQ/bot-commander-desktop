import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { compile } from 'svelte/compiler'
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

it('renders configured and unconfigured offline Settings credential fixtures without secret values', async () => {
  const source = readFileSync('src/renderer/src/components/SettingsCredentials.svelte', 'utf8')
  const compiled = compile(source, { filename: 'SettingsCredentials.svelte', generate: 'server' })
  const directory = mkdtempSync(resolve('.settings-credential-render-'))
  try {
    const file = join(directory, 'control.mjs')
    writeFileSync(file, compiled.js.code)
    const runner = join(directory, 'render.mjs')
    writeFileSync(
      runner,
      `
      import { render } from 'svelte/server'
      import component from './control.mjs'
      const fixtures = []
      for (const provider of ['openai', 'openrouter']) {
        for (const configured of [false, true]) {
          fixtures.push(render(component, { props: {
            provider, configured, revision: 'fake-public-revision',
            update: async () => { throw new Error('Rendering must not write credentials') }
          } }).body)
        }
      }
      process.stdout.write(JSON.stringify(fixtures))
    `
    )
    const fixtures = JSON.parse(
      execFileSync(process.execPath, [runner], { encoding: 'utf8' })
    ) as string[]
    let index = 0
    for (const provider of ['openai', 'openrouter'] as const) {
      for (const configured of [false, true]) {
        const body = fixtures[index++]
        expect(body).toContain(configured ? 'Key configured' : 'No key configured')
        expect(body).toContain('type="password"')
        expect(body).toContain('Replace key')
        expect(body).toContain('Remove key')
        expect(body).toContain('Cancel')
        expect(body).not.toContain('fake-public-revision')
        expect(body).not.toMatch(/value="[^"]+"/)
        expect(body).toContain(`id="${provider}-key"`)
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
