import { spawn } from 'node:child_process'

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Best-effort graceful Chromium shutdown; the socket closing is NOT process-exit proof.
 * Group/stdio observations below still gate profile deletion. */
export async function requestBrowserClose(socket, milliseconds = 1000) {
  if (!socket || socket.readyState !== 1) return
  await new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      socket.removeEventListener('close', finish)
      socket.removeEventListener('error', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    socket.addEventListener('close', finish, { once: true })
    socket.addEventListener('error', finish, { once: true })
    try {
      socket.send(JSON.stringify({ id: -1, method: 'Browser.close' }))
    } catch {
      finish()
    }
  })
}

export function assertOwnedProcessPlatform(platform = process.platform) {
  if (platform === 'win32')
    throw new Error('Windows browser tree cleanup requires a Job Object; browser was not launched')
}

/** Poll observations, not elapsed time, establish exit. Time limits only establish failure.
 * The caller supplies an exclusively owned tree, never an arbitrary PID/name search. */
export async function stopOwnedTree(tree, { graceMs = 3000, forceMs = 5000, pollMs = 25 } = {}) {
  async function goneWithin(milliseconds) {
    const until = performance.now() + milliseconds
    for (;;) {
      if (!(await tree.alive())) return true
      if (performance.now() >= until) return false
      await pause(pollMs)
    }
  }
  if (await tree.alive()) {
    await tree.signal('SIGTERM')
    if (!(await goneWithin(graceMs))) {
      await tree.signal('SIGKILL')
      if (!(await goneWithin(forceMs)))
        throw new Error('Owned process tree exit unconfirmed; fixture retained')
    }
  }
  let timer
  try {
    await Promise.race([
      tree.closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned process stdio closure unconfirmed; fixture retained')),
          forceMs
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Spawn-time ownership: POSIX descendants inherit a new process group. No shell,
 * executable-name matching, or caller-supplied group ID is accepted. Windows cannot
 * prove orphan-tree completion without a Job Object, so launch fails closed there.
 * These browser harnesses are hosted on Linux; no Windows success is inferred. */
export function spawnOwnedProcess(executable, args, options) {
  assertOwnedProcessPlatform()
  const child = spawn(executable, args, { ...options, detached: true })
  const closed = new Promise((resolve) => {
    child.once('close', resolve)
  })
  // Observe spawn errors immediately; the harness also reports its startup failure.
  child.on('error', () => {})
  const pid = child.pid
  let absent = !pid
  const alive = () => {
    if (absent) return false
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      absent = true // Never signal a subsequently reused process group.
      return false
    }
  }
  const signal = (name) => {
    if (absent) return
    try {
      process.kill(-pid, name)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
      absent = true
    }
  }
  let stopping
  child.stopOwnedTree = () =>
    (stopping ??= (async () => {
      await stopOwnedTree({ alive, signal, closed })
    })())
  return child
}
