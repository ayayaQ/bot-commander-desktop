import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  builderArgs,
  executableArchitecture,
  inventory,
  isolatedEnvironment,
  nativeTarget,
  options,
  runBounded
} from './native-package-support.mjs'
import type { AgentValidationRequest } from '../src/shared/agentValidationTypes'
import { decodeBCFDCommand } from '../src/shared/commandCodec'

const directories: string[] = []
function temporary() {
  const directory = mkdtempSync(path.join(tmpdir(), 'a7-helper-test-'))
  directories.push(directory)
  return directory
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('native package helper contract (ordinary fixtures only)', () => {
  it('selects only the assigned native architectures', () => {
    expect(nativeTarget('win32', 'x64').builderPlatform).toBe('win')
    expect(nativeTarget('darwin', 'arm64').builderPlatform).toBe('mac')
    expect(() => nativeTarget('darwin', 'x64')).toThrow('Unsupported native packaging host')
  })

  it('keeps Windows unpacked, unpublished and unsigned', () => {
    const args = builderArgs(nativeTarget('win32', 'x64'), 'fixture output', 'fixture electron')
    expect(args).toContain('--dir')
    expect(args).toContain('--x64')
    expect(args.slice(args.indexOf('--publish'), args.indexOf('--publish') + 2)).toEqual([
      '--publish',
      'never'
    ])
    expect(args).toContain('--config.win.signExecutable=false')
    expect(args.some((arg: string) => arg.includes('electronFuses'))).toBe(false)
  })

  it('keeps Mac unpacked with signing and notarization disabled', () => {
    const args = builderArgs(nativeTarget('darwin', 'arm64'), 'fixture output', 'fixture electron')
    expect(args).toContain('--arm64')
    expect(args).toContain('--config.mac.identity=null')
    expect(args).toContain('--config.mac.notarize=false')
    expect(args).toContain('--config.forceCodeSigning=false')
  })

  it('parses explicit CLI scope without silently accepting misspelled options', () => {
    expect(
      options(
        ['--report', 'fixture.json', '--portable-only'],
        ['report', 'portable-only'],
        ['portable-only']
      )
    ).toEqual({ report: 'fixture.json', 'portable-only': true })
    expect(() => options(['--report'], ['report'])).toThrow('Missing value')
    expect(() => options(['--typo'], ['report'])).toThrow('Unknown option')
  })

  it('passes only system loader values and synthetic directories to child probes', () => {
    const env = isolatedEnvironment('synthetic', {
      PATH: 'system-bin',
      SystemRoot: 'system-root',
      OPENAI_API_KEY: 'fake-must-not-inherit',
      CSC_LINK: 'fake-must-not-inherit',
      NODE_OPTIONS: '--trace-warnings'
    })
    expect(env.PATH).toBe('system-bin')
    expect(env.SystemRoot).toBe('system-root')
    expect(env.HOME).toBe('synthetic')
    expect(env.USERPROFILE).toBe('synthetic')
    expect(env.APPDATA).toBe('synthetic')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CSC_LINK).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })

  it('hashes every ordinary artifact file and notices changed bytes', () => {
    const directory = temporary()
    mkdirSync(path.join(directory, 'resources'))
    writeFileSync(path.join(directory, 'resources', 'fixture.txt'), 'first')
    const first = inventory(directory)
    expect(first.files).toHaveLength(1)
    expect(first.files[0].path).toBe('resources/fixture.txt')
    expect(inventory(directory)).toEqual(first)
    writeFileSync(path.join(directory, 'resources', 'fixture.txt'), 'second')
    expect(inventory(directory).sha256).not.toBe(first.sha256)
  })

  it('records PE x64 and Mach-O arm64 architecture from headers', () => {
    const directory = temporary()
    const pe = Buffer.alloc(512)
    pe.write('MZ')
    pe.writeUInt32LE(0x80, 0x3c)
    pe.writeUInt32LE(0x4550, 0x80)
    pe.writeUInt16LE(0x8664, 0x84)
    const windows = path.join(directory, 'fixture.exe')
    writeFileSync(windows, pe)
    expect(executableArchitecture(windows, 'win32')).toBe('x64')
    const macho = Buffer.alloc(32)
    macho.writeUInt32LE(0xfeedfacf)
    macho.writeUInt32LE(0x0100000c, 4)
    const mac = path.join(directory, 'fixture-macho')
    writeFileSync(mac, macho)
    expect(executableArchitecture(mac, 'darwin')).toBe('arm64')
  })

  it('captures a bounded shell-free child receipt and clean exit', () => {
    const directory = temporary()
    const result = runBounded(
      process.execPath,
      ['-e', 'console.log(JSON.stringify({status:"passed"}))'],
      { cwd: directory, env: isolatedEnvironment(directory) }
    )
    expect(result.error).toBeNull()
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout).status).toBe('passed')
  })

  it('bounds a child that remains open', () => {
    const directory = temporary()
    const result = runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      cwd: directory,
      env: isolatedEnvironment(directory),
      timeout: 100
    })
    expect(result.error).toContain('ETIMEDOUT')
    expect(result.exitCode).not.toBe(0)
  })

  it('keeps the committed worker fixture canonical and synthetic', () => {
    const fixture: AgentValidationRequest = JSON.parse(
      readFileSync(new URL('./fixtures/native-package-worker.json', import.meta.url), 'utf8')
    )
    expect(decodeBCFDCommand(fixture.candidate).command).toEqual(fixture.candidate)
    expect(fixture.suite.cases).toHaveLength(1)
    expect(fixture.suite.cases[0].steps).toHaveLength(1)
    expect(fixture.suite.cases[0].state.strictMocks).toBe(true)
    expect(fixture.candidate.channelMessage).toBe('$eval return 6 * 7; $halt:offline')
  })
})
