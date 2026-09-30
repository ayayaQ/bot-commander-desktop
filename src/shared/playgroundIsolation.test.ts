import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('playground runtime dependency boundary', () => {
  it('has only pure local parser/evaluator dependencies, never live services', () => {
    const visited = new Set<string>()
    const inspect = (file: string) => {
      if (visited.has(file)) return
      visited.add(file)
      const source = readFileSync(file, 'utf8')
      // These source-level guards supplement behavior tests. Type-only imports
      // are allowed; runtime imports must remain in the reviewed pure graph.
      for (const match of source.matchAll(
        /^import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]/gm
      )) {
        const name = match[1]
        expect(name.startsWith('.'), `External runtime import: ${name}`).toBe(true)
        const target = resolve(dirname(file), `${name}.ts`)
        expect(target).not.toMatch(
          /(?:botService|settingsService|aiProviderService|interpreter|quickJsScriptContext|fileService)\.ts$/
        )
        inspect(target)
      }
      expect(source).not.toMatch(
        /\b(?:fetch|XMLHttpRequest|WebSocket|eval|Function|importScripts)\s*\(/
      )
      expect(source).not.toMatch(/ipcRenderer|localStorage|sessionStorage/)
    }
    inspect(resolve('src/renderer/src/playground/worker.ts'))
    expect([...visited].some((path) => path.endsWith('/parser.ts'))).toBe(true)
  })
})
