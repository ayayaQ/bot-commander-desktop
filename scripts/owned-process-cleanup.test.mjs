import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  spawnOwnedProcess,
  stopOwnedTree,
  requestBrowserClose,
  assertOwnedProcessPlatform
} from './owned-process-cleanup.mjs'

const limits = { graceMs: 5, forceMs: 30, pollMs: 1 }
test('graceful browser close requests shutdown but does not infer process completion', async () => {
  const socket = new EventTarget()
  socket.readyState = 1
  let sent
  socket.send = (message) => {
    sent = JSON.parse(message)
    socket.dispatchEvent(new Event('close'))
  }
  await requestBrowserClose(socket)
  assert.deepEqual(sent, { id: -1, method: 'Browser.close' })
  socket.send = () => {} // An unresponsive socket is bounded; tree cleanup still follows.
  await requestBrowserClose(socket, 1)
})

test('Windows fails closed before spawning; POSIX hosts retain owned-group support', () => {
  assert.throws(() => assertOwnedProcessPlatform('win32'), /browser was not launched/)
  assert.doesNotThrow(() => assertOwnedProcessPlatform('linux'))
  assert.doesNotThrow(() => assertOwnedProcessPlatform('darwin'))
})

test('an exited leader does not bypass surviving descendants', async () => {
  let alive = true
  const signals = []
  await stopOwnedTree(
    {
      closed: Promise.resolve(),
      alive: () => alive,
      signal: (name) => {
        signals.push(name)
        alive = false
      }
    },
    limits
  )
  assert.deepEqual(signals, ['SIGTERM'])
})

test('SIGKILL submission is not completion; delayed descendant exit precedes removal', async () => {
  let alive = true,
    release
  const forced = new Promise((resolve) => {
    release = resolve
  })
  const events = []
  const cleanup = stopOwnedTree(
    {
      closed: Promise.resolve(),
      alive: () => alive,
      signal: (name) => {
        events.push(name)
        if (name === 'SIGKILL') release()
      }
    },
    { ...limits, forceMs: 1000 }
  ).then(() => events.push('remove fixture'))
  await forced
  assert.deepEqual(events, ['SIGTERM', 'SIGKILL'])
  // This observation represents a child which can still write after its leader exits.
  events.push('last descendant write')
  alive = false
  await cleanup
  assert.deepEqual(events, ['SIGTERM', 'SIGKILL', 'last descendant write', 'remove fixture'])
})

test('unconfirmed exit fails instead of admitting directory cleanup', async () => {
  let removed = false
  await assert.rejects(
    stopOwnedTree(
      {
        closed: Promise.resolve(),
        alive: () => true,
        signal() {}
      },
      limits
    ).then(() => {
      removed = true
    }),
    /exit unconfirmed/
  )
  assert.equal(removed, false)
})

test('absence still waits for child close and stdio drain', async () => {
  let close,
    finished = false
  const cleanup = stopOwnedTree(
    {
      alive: () => false,
      signal() {
        assert.fail('must not signal an absent group')
      },
      closed: new Promise((resolve) => {
        close = resolve
      })
    },
    { ...limits, forceMs: 1000 }
  ).then(() => {
    finished = true
  })
  await Promise.resolve()
  assert.equal(finished, false)
  close()
  await cleanup
  assert.equal(finished, true)
})

test('unconfirmed stdio closure and permission errors remain failures', async () => {
  await assert.rejects(
    stopOwnedTree(
      {
        alive: () => false,
        signal() {},
        closed: new Promise(() => {})
      },
      limits
    ),
    /stdio closure unconfirmed/
  )
  await assert.rejects(
    stopOwnedTree(
      {
        alive() {
          throw new Error('permission denied')
        },
        signal() {},
        closed: Promise.resolve()
      },
      limits
    ),
    /permission denied/
  )
})

test(
  'owned spawn waits for a harmless child to close and stopping is idempotent',
  {
    skip: process.platform === 'win32' ? 'No Windows Job Object ownership claim' : false
  },
  async () => {
    const child = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    let closed = false
    child.once('close', () => {
      closed = true
    })
    const first = child.stopOwnedTree()
    assert.equal(child.stopOwnedTree(), first)
    await first
    assert.equal(closed, true)
  }
)

test(
  'failed spawn can be cleaned without signaling any group',
  { skip: process.platform === 'win32' },
  async () => {
    const child = spawnOwnedProcess('/nonexistent-owned-fixture-executable', [], {
      stdio: 'ignore'
    })
    await child.stopOwnedTree()
    assert.equal(child.pid, undefined)
  }
)
