// Harmless owned Node fixture for native Windows CI. No network, providers or credentials.
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const [mode, pidFile, childReady] = process.argv.slice(2)
if (mode === 'child') {
  writeFileSync(childReady, String(process.pid))
  setInterval(() => {}, 1000)
} else {
  const child = spawn(process.execPath, [process.argv[1], 'child', pidFile, childReady], {
    cwd: process.cwd(),
    env: { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT },
    shell: false,
    stdio: 'ignore'
  })
  child.once('spawn', () =>
    writeFileSync(pidFile, JSON.stringify({ root: process.pid, child: child.pid }))
  )
  const input = createInterface({ input: process.stdin })
  input.on('line', (line) => {
    const request = JSON.parse(line)
    if (!('id' in request) || mode === 'silent') return
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'Owned native Windows fixture', version: '1' }
          }
        : request.method === 'tools/list'
          ? { tools: [] }
          : undefined
    if (result)
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  })
  // Keep a descendant alive until the host's Job Object lifecycle terminates this whole tree.
  setInterval(() => {}, 1000)
}
