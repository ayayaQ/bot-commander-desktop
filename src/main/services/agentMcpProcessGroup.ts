// SPDX-License-Identifier: Apache-2.0
// Licensed owned-process implementation adapted from vivi-cli mcp-process-group.ts.
import { opendir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

/** Bookkeeping for an owned POSIX group. This does not confine trusted code or discover escaped descendants. */
async function liveGroupMembers(group: number): Promise<boolean> {
  try {
    process.kill(-group, 0)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    throw error
  }
  if (process.platform === 'linux') {
    const directory = await opendir('/proc')
    for await (const entry of directory) {
      if (!/^\d+$/.test(entry.name)) continue
      let stat: string
      try {
        stat = await readFile(`/proc/${entry.name}/stat`, 'utf8')
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          ['ENOENT', 'ESRCH'].includes(String(error.code))
        )
          continue
        throw error
      }
      const fields = stat
        .slice(stat.lastIndexOf(') ') + 2)
        .trim()
        .split(/\s+/)
      if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') return true
    }
    return false
  }
  // Fixed system utility, no shell strings or ambient credentials.
  return new Promise<boolean>((resolve, reject) => {
    const query = spawn('/bin/ps', ['-axo', 'pgid=,stat='], {
      shell: false,
      env: { LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let output = '',
      failure: Error | undefined
    const timer = setTimeout(() => {
      failure = new Error('MCP process verification timed out')
      query.kill('SIGKILL')
    }, 1000)
    query.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 256 * 1024) {
        failure = new Error('MCP process verification exceeded its output limit')
        query.kill('SIGKILL')
      }
    })
    query.once('error', (error) => {
      failure = error
    })
    query.once('close', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0) {
        reject(failure ?? new Error('MCP process verification failed'))
        return
      }
      resolve(
        output
          .trim()
          .split('\n')
          .some((line) => {
            const [id, state] = line.trim().split(/\s+/)
            return (
              Number(id) === group &&
              state !== undefined &&
              !state.startsWith('Z') &&
              !state.startsWith('X')
            )
          })
      )
    })
  })
}
export async function verifyMcpGroupDead(group: number): Promise<void> {
  const deadline = performance.now() + 3000
  while (await liveGroupMembers(group)) {
    if (performance.now() >= deadline)
      throw new Error('MCP process group cleanup could not be verified')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
