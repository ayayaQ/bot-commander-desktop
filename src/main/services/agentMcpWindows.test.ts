import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { launchWindowsMcp, type WindowsMcpInput, type WindowsMcpRuntime } from './agentMcpWindows'
const input: WindowsMcpInput = {
  executable: 'C:\\Program Files\\Trusted\\server.exe',
  cwd: 'C:\\approved work',
  args: ['', 'literal whitespace', '"quote"', 'trailing\\', '&|<>^%PATH%', '$(not code)', '中文🙂'],
  env: { SYSTEMROOT: 'C:\\Windows', HOME: 'literal' }
}
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: (_signal: string) => {
      child.emit('close', null)
      return true
    }
  })
  const writes: Buffer[] = [],
    calls: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }> = []
  child.stdin.on('data', (bytes) => writes.push(bytes))
  const runtime: WindowsMcpRuntime = {
    hostEnv: {
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\tmp',
      API_KEY: 'private-fixture',
      PATH: 'unapproved',
      NODE_OPTIONS: 'unapproved'
    },
    spawn: ((executable: string, args: readonly string[], options: SpawnOptions) => {
      calls.push({ executable, args, options })
      return child as unknown as ChildProcess
    }) as WindowsMcpRuntime['spawn'],
    cleanupTimeoutMs: 15
  }
  return { child, writes, calls, runtime }
}
const frame = (value: unknown) => JSON.stringify(value) + '\r\n'
describe('injected Windows native Job Object helper', () => {
  it('passes exact target argv as data with fixed OS helper source and no ambient credential injection', async () => {
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime),
      call = subject.calls[0]
    expect(call.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(call.options.shell).toBe(false)
    expect(call.options.env).toEqual({
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\tmp',
      PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'
    })
    expect(call.args.at(-2)).toBe('-EncodedCommand')
    const source = Buffer.from(call.args.at(-1)!, 'base64').toString('utf16le')
    expect(source).not.toContain('private-fixture')
    expect(source).not.toContain('$(not code)')
    expect(source).toContain('LanguageMode')
    expect(source).toContain('ReparsePoint')
    const native = gunzipSync(
      Buffer.from(source.match(/\$compressed = '([^']+)'/)![1], 'base64')
    ).toString('utf8')
    expect(native).toContain('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE')
    expect(native).toContain('HANDLE_LIST')
    expect(native).toContain('WaitForEmptyJob')
    expect(native.indexOf('Check(CreateProcessW(')).toBeLessThan(
      native.indexOf('if (ResumeThread(')
    )
    expect(
      native.indexOf('Console.Out.WriteLine("{\\\"type\\\":\\\"started\\\"}")')
    ).toBeGreaterThan(native.indexOf('if (ResumeThread('))
    expect(native.indexOf('Console.Out.WriteLine("{\\\"type\\\":\\\"started\\\"}")')).toBeLessThan(
      native.indexOf('outPump = Pump(')
    )
    expect(JSON.parse(Buffer.concat(subject.writes).toString('utf8'))).toEqual(input)
    subject.child.stdout.write(frame({ type: 'started' }))
    await owned.ready
    subject.child.stdout.write(frame({ type: 'exit', exitCode: 0, stopped: false }))
    subject.child.emit('close', 0)
    expect(await owned.completed).toEqual({ exitCode: 0 })
  })
  it('decodes split binary frames but waits for helper close before confirming cleanup', async () => {
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime),
      output: Buffer[] = []
    owned.stdout.on('data', (bytes) => output.push(bytes))
    const bytes = Buffer.from([0, 255, 13, 10, 128]),
      protocol =
        frame({ type: 'started' }) +
        frame({ type: 'stdout', data: bytes.toString('base64') }) +
        frame({ type: 'exit', exitCode: 7, stopped: false })
    for (const character of protocol) subject.child.stdout.write(character)
    let settled = false
    void owned.completed.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await owned.ready
    subject.child.emit('close', 0)
    expect(await owned.completed).toEqual({ exitCode: 7 })
    expect(Buffer.concat(output)).toEqual(bytes)
  })
  it('stops idempotently via EOF and waits for verified empty job', async () => {
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime),
      first = owned.stop(),
      second = owned.stop()
    expect(subject.child.stdin.writableEnded).toBe(true)
    await expect(owned.ready).rejects.toThrow('cancelled before readiness')
    subject.child.stdout.write(frame({ type: 'exit', exitCode: null, stopped: true }))
    subject.child.emit('close', 0)
    await Promise.all([first, second])
    expect(await owned.completed).toEqual({ exitCode: null, signal: 'SIGTERM' })
  })
  it('resolves readiness from one split fixed acknowledgment before output backpressure', async () => {
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime)
    let ready = false
    void owned.ready.then(() => {
      ready = true
    })
    await Promise.resolve()
    expect(ready).toBe(false)
    await expect(owned.write(Buffer.from('not-yet-ready'))).rejects.toThrow('unavailable')
    for (const character of frame({ type: 'started' })) subject.child.stdout.write(character)
    const bytes = Buffer.alloc(17000, 97)
    subject.child.stdout.write(
      frame({ type: 'stdout', data: bytes.toString('base64') }) +
        frame({ type: 'exit', exitCode: 0, stopped: false })
    )
    await owned.ready
    expect(ready).toBe(true)
    // stop drains blocked output so the terminal frame can still be verified.
    const stopped = owned.stop()
    subject.child.emit('close', 0)
    await stopped
    expect((await owned.completed).error).toBeUndefined()
  })
  it('accepts a legitimate late started frame after stop without reopening readiness or writes', async () => {
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime),
      stopped = owned.stop()
    await expect(owned.ready).rejects.toThrow('cancelled before readiness')
    subject.child.stdout.write(frame({ type: 'started' }))
    await expect(owned.ready).rejects.toThrow('cancelled before readiness')
    await expect(owned.write(Buffer.from('never send'))).rejects.toThrow('unavailable')
    subject.child.stdout.write(frame({ type: 'exit', exitCode: 1, stopped: true }))
    subject.child.emit('close', 0)
    await stopped
    expect(await owned.completed).toEqual({ exitCode: 1, signal: 'SIGTERM' })
  })
  it('rejects missing, malformed, duplicate or out-of-order readiness without claiming cleanup', async () => {
    for (const protocol of [
      '',
      frame({ type: 'started', extra: true }),
      frame({ type: 'stdout', data: 'eA==' }),
      frame({ type: 'exit', exitCode: 0, stopped: false })
    ]) {
      const subject = fixture(),
        owned = await launchWindowsMcp(input, subject.runtime)
      if (protocol) subject.child.stdout.write(protocol)
      subject.child.emit('close', null)
      await expect(owned.ready).rejects.toThrow('before readiness')
      expect((await owned.completed).error).toBeTruthy()
    }
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime)
    subject.child.stdout.write(frame({ type: 'started' }))
    await owned.ready
    subject.child.stdout.write(frame({ type: 'started' }))
    subject.child.emit('close', null)
    expect((await owned.completed).error).toContain('Invalid Windows MCP helper protocol')
  })
  it('rejects error or verified prelaunch cancellation before readiness while preserving terminal semantics', async () => {
    const failed = fixture(),
      failure = await launchWindowsMcp(input, failed.runtime)
    failed.child.stdout.write(
      frame({ type: 'error', data: Buffer.from('inert setup failure').toString('base64') })
    )
    await expect(failure.ready).rejects.toThrow('failed before readiness')
    failed.child.emit('close', 1)
    expect((await failure.completed).error).toBe('inert setup failure')
    const cancelled = fixture(),
      cancellation = await launchWindowsMcp(input, cancelled.runtime)
    cancelled.child.stdout.write(frame({ type: 'exit', exitCode: null, stopped: true }))
    await expect(cancellation.ready).rejects.toThrow('cancelled before readiness')
    let completed = false
    void cancellation.completed.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    cancelled.child.emit('close', 0)
    expect(await cancellation.completed).toEqual({ exitCode: null, signal: 'SIGTERM' })
  })
  it('rejects ambiguous relative/shell paths, NULs and duplicate environment names before spawning', async () => {
    const changes: Partial<WindowsMcpInput>[] = [
      { executable: 'server.exe' },
      { executable: '\\server.exe' },
      { executable: 'C:\\Windows\\cmd.exe' },
      { cwd: 'relative' },
      { args: ['bad\0argument'] },
      { env: { PATH: 'one', Path: 'two' } },
      { env: { 'bad=name': 'value' } }
    ]
    for (const change of changes) {
      const subject = fixture()
      await expect(launchWindowsMcp({ ...input, ...change }, subject.runtime)).rejects.toThrow()
      expect(subject.calls).toHaveLength(0)
    }
  })
  it('fails malformed protocol or helper crash without claiming successful cleanup', async () => {
    for (const protocol of [
      'not-json\n',
      frame({ type: 'stdout', data: 'bad base64!!' }),
      'a'.repeat(24001),
      '{partial'
    ]) {
      const subject = fixture(),
        owned = await launchWindowsMcp(input, subject.runtime)
      subject.child.stdout.write(protocol)
      subject.child.emit('close', null)
      expect((await owned.completed).error).toBeTruthy()
    }
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime)
    subject.child.emit('close', null)
    expect((await owned.completed).error).toContain('without verified tree cleanup')
  })
  it('bounds unresponsive stop and explicitly leaves cleanup unverified', async () => {
    const subject = fixture(),
      owned = await launchWindowsMcp(input, subject.runtime),
      stopped = owned.stop()
    await new Promise((resolve) => setTimeout(resolve, 30))
    await stopped
    expect((await owned.completed).error).toContain('without verified tree cleanup')
  })
})
