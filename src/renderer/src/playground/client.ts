import type { PlaygroundRequest, PlaygroundResult } from '../../../shared/playground'

export function runPlayground(request: PlaygroundRequest): Promise<PlaygroundResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const finish = () => {
      clearTimeout(timeout)
      worker.terminate()
    }
    const timeout = setTimeout(() => {
      finish()
      reject(new Error('Playground timed out after 2 seconds; try a smaller command'))
    }, 2_000)
    worker.onmessage = (event: MessageEvent<{ result?: PlaygroundResult; error?: string }>) => {
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else if (event.data.result) resolve(event.data.result)
      else reject(new Error('Invalid playground result'))
    }
    worker.onerror = () => {
      finish()
      reject(new Error('Playground worker failed'))
    }
    try {
      worker.postMessage(request)
    } catch (error) {
      finish()
      reject(error)
    }
  })
}
