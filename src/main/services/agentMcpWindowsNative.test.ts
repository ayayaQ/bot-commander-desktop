import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentMcpService } from './agentMcpService'
import { McpConfigStore } from './agentMcpConfig'
import { reopenAtomicWrites } from './atomicPersistence'
import { resumeAgentPersistence } from './agentPersistenceLifecycle'

vi.mock('electron', () => ({ app: { getPath: () => '/unreferenced-native-test-state' } }))
const fixtureFile = fileURLToPath(new URL('./fixtures/agentMcpNativeServer.mjs', import.meta.url))
const subjects: Array<{ directory: string; service: AgentMcpService }> = []
beforeEach(() => {
  reopenAtomicWrites()
  resumeAgentPersistence()
})
afterEach(async () => {
  for (const { service, directory } of subjects.splice(0)) {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
})
async function subject(mode: 'normal' | 'silent') {
  const directory = await mkdtemp(join(tmpdir(), 'desktop-mcp-native-windows-'))
  const root = Object.entries(process.env).find(
    ([name]) => name.toUpperCase() === 'SYSTEMROOT'
  )?.[1]
  if (!root) throw new Error('Native Windows fixture requires the installed OS SystemRoot')
  const pidFile = join(directory, 'owned-pids.json'),
    childReady = join(directory, 'child-ready')
  const service = new AgentMcpService({
    store: new McpConfigStore(join(directory, 'private')),
    env: { SYSTEMROOT: root }
  })
  subjects.push({ directory, service })
  await service.configure({
    id: 'native',
    label: 'Owned native offline fixture',
    executable: process.execPath,
    args: [fixtureFile, mode, pidFile, childReady],
    cwd: directory,
    protocol: 'legacy',
    environment: ['SYSTEMROOT']
  })
  return { directory, service, pidFile, childReady }
}
async function liveTree(
  peer: Awaited<ReturnType<typeof subject>>
): Promise<{ root: number; child: number }> {
  let pids: { root: number; child: number } | undefined
  await vi.waitFor(
    async () => {
      pids = JSON.parse(await readFile(peer.pidFile, 'utf8'))
      expect(pids).toMatchObject({ root: expect.any(Number), child: expect.any(Number) })
      expect(Number(await readFile(peer.childReady, 'utf8'))).toBe(pids!.child)
      expect(process.kill(pids!.root, 0)).toBe(true)
      expect(process.kill(pids!.child, 0)).toBe(true)
    },
    { timeout: 10000, interval: 50 }
  )
  return pids!
}
async function deadTree(pids: { root: number; child: number }): Promise<void> {
  await vi.waitFor(
    () => {
      for (const pid of [pids.root, pids.child]) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      }
    },
    { timeout: 5000, interval: 50 }
  )
}
// This file must run explicitly on official native Windows CI; non-Windows skips are not native proof.
describe.skipIf(process.platform !== 'win32')(
  'native Windows MCP installed Node and owned descendant lifecycle',
  () => {
    it('completes the stdio handshake/discovery then disconnects the entire owned tree', async () => {
      const peer = await subject('normal')
      const result = await peer.service.start((await peer.service.prepareLaunch('native')).token)
      expect(result.started).toBe(true)
      expect(result.status.servers[0].catalog?.tools.state).toBe('ready')
      const pids = await liveTree(peer)
      await peer.service.disconnect('native')
      await deadTree(pids)
      expect((await peer.service.list()).servers[0].state).toBe('disabled')
      expect(await peer.service.captureCatalogs(new AbortController().signal)).toEqual([])
    }, 30000)
    it('cancels delayed startup and verifies owned root plus descendant death', async () => {
      const peer = await subject('silent'),
        launch = await peer.service.prepareLaunch('native')
      const startup = peer.service.start(launch.token),
        pids = await liveTree(peer)
      peer.service.cancelLaunch(launch.token)
      expect((await startup).started).toBe(false)
      await deadTree(pids)
      expect((await peer.service.list()).servers[0].state).toBe('disabled')
    }, 30000)
  }
)
