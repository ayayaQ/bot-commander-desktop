import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function options(argv, names, flags = []) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '')
    assert.ok(argv[i].startsWith('--') && names.includes(key), `Unknown option: ${argv[i]}`)
    assert.ok(!(key in result), `Duplicate option: ${key}`)
    if (flags.includes(key)) result[key] = true
    else {
      assert.ok(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing value: ${key}`)
      result[key] = argv[++i]
    }
  }
  return result
}

export function nativeTarget(platform = process.platform, arch = process.arch) {
  assert.ok(
    (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64'),
    `Unsupported native packaging host: ${platform}/${arch}; use Windows x64 or Mac arm64`
  )
  return { platform, arch, builderPlatform: platform === 'win32' ? 'win' : 'mac' }
}

export function isWithin(parent, target) {
  const relative = path.relative(parent, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

// Resolve existing ancestors too, so an output alias cannot place artifacts in the checkout.
export function canonical(file) {
  const absolute = path.resolve(file)
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute)
  const parent = path.dirname(absolute)
  assert.notEqual(parent, absolute, `No existing ancestor for ${file}`)
  return path.join(canonical(parent), path.basename(absolute))
}

export function externalPath(checkout, file) {
  const target = canonical(file)
  assert.ok(
    !isWithin(canonical(checkout), target),
    'Artifacts and reports must be outside the checkout'
  )
  return target
}

export function builderArgs(target, output, electronDist) {
  return [
    '--dir',
    `--${target.builderPlatform}`,
    `--${target.arch}`,
    '--publish',
    'never',
    `--config.directories.output=${output}`,
    `--config.electronDist=${electronDist}`,
    '--config.forceCodeSigning=false',
    ...(target.platform === 'win32'
      ? ['--config.win.signExecutable=false']
      : ['--config.mac.identity=null', '--config.mac.notarize=false'])
  ]
}

export function isolatedEnvironment(directory, inherited = process.env) {
  const env = {}
  // Tools need the system loader and PATH, never provider keys or signing identities.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT']) {
    if (inherited[key]) env[key] = inherited[key]
  }
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'TEMP',
    'TMP',
    'TMPDIR',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME'
  ]) {
    env[key] = directory
  }
  return env
}

export function runBounded(executable, args, { cwd, env, timeout = 60_000 }) {
  const started = Date.now()
  const child = spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024
  })
  return {
    exitCode: child.status,
    signal: child.signal,
    error: child.error?.message ?? null,
    durationMs: Date.now() - started,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? ''
  }
}

export function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}

export function fileHash(file) {
  const hash = createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.alloc(1024 * 1024)
  try {
    let count
    while ((count = fs.readSync(descriptor, buffer, 0, buffer.length, null))) {
      hash.update(buffer.subarray(0, count))
    }
    return hash.digest('hex')
  } finally {
    fs.closeSync(descriptor)
  }
}

export function inventory(directory) {
  const files = []
  function visit(folder) {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name)
      const stat = fs.lstatSync(file)
      const relative = path.relative(directory, file).split(path.sep).join('/')
      if (stat.isSymbolicLink()) files.push({ path: relative, link: fs.readlinkSync(file) })
      else if (stat.isDirectory()) visit(file)
      else if (stat.isFile())
        files.push({ path: relative, bytes: stat.size, sha256: fileHash(file) })
      else throw new Error(`Unsupported artifact entry: ${relative}`)
    }
  }
  visit(directory)
  return { sha256: sha256(JSON.stringify(files)), files }
}

export function executableArchitecture(file, platform) {
  const descriptor = fs.openSync(file, 'r')
  const header = Buffer.alloc(4096)
  try {
    fs.readSync(descriptor, header, 0, header.length, 0)
    if (platform === 'win32') {
      assert.equal(header.toString('ascii', 0, 2), 'MZ', 'Expected Windows PE executable')
      const offset = header.readUInt32LE(0x3c)
      const pe = Buffer.alloc(6)
      fs.readSync(descriptor, pe, 0, pe.length, offset)
      assert.equal(pe.readUInt32LE(0), 0x00004550, 'Invalid PE signature')
      assert.equal(pe.readUInt16LE(4), 0x8664, 'Expected x64 PE executable')
      return 'x64'
    }
    assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'Expected thin 64-bit Mach-O executable')
    assert.equal(header.readUInt32LE(4), 0x0100000c, 'Expected arm64 Mach-O executable')
    return 'arm64'
  } finally {
    fs.closeSync(descriptor)
  }
}
