import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('headless playground security boundary', () => {
  it('keeps the executable worker graph pure and free of privileged/service/network access', () => {
    const seen = new Set<string>()
    const inspect = (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(
        /^import\s+(?!type\b)[\s\S]*?from\s+['"]([^'"]+)['"]/gm
      )) {
        const specifier = match[1]
        expect(specifier.startsWith('.'), `External runtime import: ${specifier}`).toBe(true)
        const target = resolve(dirname(file), `${specifier}.ts`)
        expect(target).not.toMatch(
          /(?:botService|settingsService|aiProviderService|interpreter|quickJsScriptContext|fileService|virtual)\.ts$/
        )
        inspect(target)
      }
      expect(source).not.toMatch(
        /\b(?:fetch|XMLHttpRequest|WebSocket|eval|Function|importScripts|require)\s*\(/
      )
      expect(source).not.toMatch(/ipcRenderer|localStorage|sessionStorage|process\.env|document\./)
    }
    inspect(resolve('src/renderer/src/utils/playgroundWorker.ts'))
    expect([...seen].some((file) => file.endsWith('/parser.ts'))).toBe(true)
  })

  it('reads saved commands only and keeps embed assets inert in the renderer source', () => {
    const source = readFileSync(resolve('src/renderer/src/components/Playground.svelte'), 'utf8')
    expect(
      [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])
    ).toEqual(['get-commands'])
    expect(source).not.toMatch(/ipcRenderer\.send|<img\b|<iframe\b|<a\b|@html|openExternal|url\(/)
    expect(source).toContain('session.cancel()')
    expect(source).toContain('session.isCurrent(revision)')
    expect(source).toContain('generation !== loadGeneration')
  })
})
