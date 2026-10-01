import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { build } from 'vite'
import type { InlineConfig, Plugin } from 'vite'

export const AGENT_VALIDATION_WORKER_FILENAME = 'agentValidationWorker.mjs'

/** The validation entry is built independently; it cannot share privileged main chunks. */
export function agentValidationWorkerBuild(outDir: string): InlineConfig {
  return {
    configFile: false,
    root: resolve('.'),
    logLevel: 'silent',
    publicDir: false,
    // The bundled Emscripten loader receives inline bytes, not Node filesystem loaders.
    define: { 'globalThis.process': 'undefined' },
    build: {
      target: 'esnext',
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: false,
      lib: {
        entry: resolve('src/main/workers/agentValidationWorker.ts'),
        formats: ['es'],
        fileName: () => AGENT_VALIDATION_WORKER_FILENAME
      },
      rollupOptions: {
        external: ['node:worker_threads', 'node:module'],
        output: { inlineDynamicImports: true }
      }
    }
  }
}

function bundleAgentValidationWorker(): Plugin {
  let outDir: string
  return {
    name: 'bundle-disposable-agent-validation-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    // electron-vite dev also builds/watches main before launching Electron. This hook
    // is awaited for the initial build and every rebuild, so the entry exists in both.
    async writeBundle() {
      const mainBuild = this
      const config = agentValidationWorkerBuild(outDir)
      config.plugins = [
        {
          name: 'watch-agent-validation-worker-graph',
          buildEnd() {
            for (const id of this.getModuleIds()) {
              if (!id.startsWith('\0') && !id.startsWith('node:'))
                mainBuild.addWatchFile(id.split('?')[0])
            }
          }
        }
      ]
      await build(config)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), bundleAgentValidationWorker()],
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [svelte()]
  }
})
