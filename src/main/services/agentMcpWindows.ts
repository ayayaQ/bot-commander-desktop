// SPDX-License-Identifier: Apache-2.0
// Licensed owned-process implementation adapted from vivi-cli mcp-windows.ts.
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { win32 } from 'node:path'
import { PassThrough } from 'node:stream'
import { gzipSync } from 'node:zlib'
import type { Readable } from 'node:stream'

// Native contracts: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
// https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
// https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw

export interface WindowsMcpInput {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface WindowsMcpResult {
  readonly exitCode: number | null
  readonly signal?: string
  readonly error?: string
}

export interface WindowsMcpProcess {
  readonly stdout: Readable
  readonly stderr: Readable
  /** Native Job assignment and root resume acknowledged; not a protocol handshake. */
  readonly ready: Promise<void>
  readonly completed: Promise<WindowsMcpResult>
  write(bytes: Buffer): Promise<void>
  stop(): Promise<void>
}

/** Injection is for deterministic tests; callers should use the default runtime. */
export interface WindowsMcpRuntime {
  readonly spawn?: (
    executable: string,
    args: readonly string[],
    options: SpawnOptions
  ) => ChildProcess
  readonly hostEnv?: Readonly<NodeJS.ProcessEnv>
  readonly cleanupTimeoutMs?: number
}

// Every byte of this program is package-authored. Request data is read from stdin,
// never interpolated into PowerShell or C# source, or interpreted as a shell command.
const nativeSource = String.raw`
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ViviMcpJob {
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
  const uint WAIT_OBJECT_0 = 0;
  static readonly IntPtr HANDLE_LIST = new IntPtr(0x00020002);
  static readonly IntPtr JOB_LIST = new IntPtr(0x0002000D);
  static readonly object outputLock = new object();
  static readonly object jobLock = new object();
  static IntPtr activeJob = IntPtr.Zero;
  static bool cancelled = false;
  static Exception pumpError;
  static readonly BlockingCollection<byte[]> inputQueue = new BlockingCollection<byte[]>(4);

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES {
    public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
    public uint cb; public IntPtr reserved; public IntPtr desktop; public IntPtr title;
    public uint x, y, xSize, ySize, xChars, yChars, fill, flags;
    public ushort show, reservedSize; public IntPtr reservedBytes, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX {
    public STARTUPINFO startup; public IntPtr attributes;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION {
    public IntPtr process, thread; public uint processId, threadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
    public long processTime, jobTime; public uint flags;
    public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcessLimit;
    public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS {
    public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public BASIC_LIMITS basic; public IO_COUNTERS io;
    public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long user, kernel, periodUser, periodKernel;
    public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses;
  }

  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMITS limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processAttributes,
    IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd,
    ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(SafeFileHandle handle, byte[] bytes, uint count, out uint written, IntPtr overlapped);

  static void Check(bool ok, string operation) {
    if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static void Close(ref IntPtr handle) {
    if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
  }
  static void Emit(string type, byte[] bytes, int count) {
    lock (outputLock) {
      Console.Out.WriteLine("{\"type\":\"" + type + "\",\"data\":\"" + Convert.ToBase64String(bytes, 0, count) + "\"}");
      Console.Out.Flush();
    }
  }
  static void EmitError(Exception error) {
    byte[] bytes = Encoding.UTF8.GetBytes(error.Message); Emit("error", bytes, bytes.Length);
  }
  static Thread Pump(IntPtr read, string type) {
    Thread thread = new Thread(delegate() {
      try {
        using (FileStream stream = new FileStream(new SafeFileHandle(read, true), FileAccess.Read, 4096, false)) {
          byte[] bytes = new byte[4096]; int count;
          while ((count = stream.Read(bytes, 0, bytes.Length)) > 0) Emit(type, bytes, count);
        }
      } catch (Exception error) { lock (outputLock) { if (pumpError == null) pumpError = error; } }
    });
    thread.IsBackground = true; thread.Start(); return thread;
  }
  // Windows argv serialization for the standard C runtime parser. This is data
  // encoding, never shell syntax. Empty arguments and trailing slashes survive.
  static string Quote(string value) {
    StringBuilder result = new StringBuilder("\""); int slashes = 0;
    foreach (char character in value) {
      if (character == '\\') { slashes++; continue; }
      if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
      else { result.Append('\\', slashes); result.Append(character); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  static void StopOnInputEnd() {
    try {
      string line;
      while ((line = Console.In.ReadLine()) != null) {
        if (line.Length > 87384) throw new IOException("MCP input frame exceeds its limit");
        byte[] bytes = Convert.FromBase64String(line);
        if (bytes.Length > 65536 || !inputQueue.TryAdd(bytes, 0)) throw new IOException("MCP input queue exceeds its limit");
      }
    } catch (Exception error) { lock (outputLock) { if (pumpError == null) pumpError = error; } }
    lock (jobLock) {
      cancelled = true;
      inputQueue.CompleteAdding();
      if (activeJob != IntPtr.Zero) TerminateJobObject(activeJob, 1);
    }
  }
  static Thread InputPump(IntPtr writer) {
    Thread thread = new Thread(delegate() {
      try {
        using (SafeFileHandle handle = new SafeFileHandle(writer, true)) {
          foreach (byte[] bytes in inputQueue.GetConsumingEnumerable()) {
            if (bytes.Length == 0) continue;
            uint written;
            if (!WriteFile(handle, bytes, (uint)bytes.Length, out written, IntPtr.Zero)) {
              int code = Marshal.GetLastWin32Error();
              throw new Win32Exception(code, "MCP stdin WriteFile failed (Win32 " +
                code.ToString(System.Globalization.CultureInfo.InvariantCulture) + ")");
            }
            if (written != (uint)bytes.Length) throw new IOException("MCP stdin WriteFile was incomplete");
          }
        }
      } catch (Exception error) {
        lock (outputLock) { if (!cancelled && pumpError == null) pumpError = error; }
        // A closed target input pipe cannot recover. Stop the owned tree instead
        // of waiting indefinitely for a root that no longer accepts requests.
        lock (jobLock) {
          cancelled = true;
          inputQueue.CompleteAdding();
          if (activeJob != IntPtr.Zero) TerminateJobObject(activeJob, 1);
        }
      }
    });
    thread.IsBackground = true; thread.Start(); return thread;
  }
  static void WaitForEmptyJob(IntPtr job) {
    while (true) {
      ACCOUNTING accounting;
      Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
      if (accounting.activeProcesses == 0) return;
      Thread.Sleep(10);
    }
  }

  public static void Run(string executable, string[] args, string cwd, Dictionary<string,string> env) {
    IntPtr job = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
    IntPtr errRead = IntPtr.Zero, errWrite = IntPtr.Zero, inRead = IntPtr.Zero, inWrite = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, handleMemory = IntPtr.Zero, jobMemory = IntPtr.Zero, environment = IntPtr.Zero;
    bool attributesReady = false, prelaunchCancelled = false, cleanupVerified = false;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    Thread outPump = null, errPump = null, inputPump = null; uint exitCode = 1; Exception failure = null;
    try {
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW");
      EXTENDED_LIMITS limits = new EXTENDED_LIMITS(); limits.basic.flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMITS))), "SetInformationJobObject");
      lock (jobLock) { activeJob = job; }
      Thread control = new Thread(StopOnInputEnd); control.IsBackground = true; control.Start();

      SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES(); security.length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); security.inherit = true;
      Check(CreatePipe(out outRead, out outWrite, ref security, 0), "CreatePipe stdout");
      Check(CreatePipe(out errRead, out errWrite, ref security, 0), "CreatePipe stderr");
      Check(CreatePipe(out inRead, out inWrite, ref security, 0), "CreatePipe stdin");
      Check(SetHandleInformation(outRead, 1, 0), "SetHandleInformation stdout");
      Check(SetHandleInformation(errRead, 1, 0), "SetHandleInformation stderr");
      Check(SetHandleInformation(inWrite, 1, 0), "SetHandleInformation stdin");
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Attribute list size");
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size), "InitializeProcThreadAttributeList");
      attributesReady = true;
      handleMemory = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handleMemory, 0, inRead); Marshal.WriteIntPtr(handleMemory, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handleMemory, IntPtr.Size * 2, errWrite);
      Check(UpdateProcThreadAttribute(attributes, 0, HANDLE_LIST, handleMemory, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "Handle allowlist");
      jobMemory = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobMemory, job);
      // Atomic job assignment prevents stranding even a suspended child if this
      // helper is terminated between CreateProcessW and ResumeThread.
      Check(UpdateProcThreadAttribute(attributes, 0, JOB_LIST, jobMemory, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Atomic job assignment (Windows 10+ required)");
      List<string> keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
      StringBuilder block = new StringBuilder();
      foreach (string key in keys) { block.Append(key); block.Append('='); block.Append(env[key]); block.Append('\0'); }
      block.Append('\0'); if (keys.Count == 0) block.Append('\0');
      environment = Marshal.StringToHGlobalUni(block.ToString());
      StringBuilder command = new StringBuilder(Quote(executable));
      foreach (string argument in args) { command.Append(' '); command.Append(Quote(argument)); }
      if (command.Length >= 32767) throw new ArgumentException("Windows MCP line exceeds 32766 UTF-16 code units");
      STARTUPINFOEX startup = new STARTUPINFOEX(); startup.startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX));
      startup.startup.flags = STARTF_USESTDHANDLES; startup.startup.stdin = inRead; startup.startup.stdout = outWrite; startup.startup.stderr = errWrite; startup.attributes = attributes;
      lock (jobLock) {
        if (cancelled) throw new OperationCanceledException("MCP cancelled before execution");
        Check(CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
          CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
          environment, cwd, ref startup, out process), "CreateProcessW");
        if (ResumeThread(process.thread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      }
      // Flush the fixed readiness frame before starting output pumps. Target
      // output/backpressure cannot delay or spoof this first helper frame.
      lock (outputLock) { Console.Out.WriteLine("{\"type\":\"started\"}"); Console.Out.Flush(); }
      Close(ref inRead); Close(ref outWrite); Close(ref errWrite); Close(ref process.thread);
      outPump = Pump(outRead, "stdout"); outRead = IntPtr.Zero;
      errPump = Pump(errRead, "stderr"); errRead = IntPtr.Zero;
      inputPump = InputPump(inWrite); inWrite = IntPtr.Zero;
      if (WaitForSingleObject(process.process, UInt32.MaxValue) != WAIT_OBJECT_0)
        throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject");
      Check(GetExitCodeProcess(process.process, out exitCode), "GetExitCodeProcess");
    } catch (Exception error) {
      prelaunchCancelled = error is OperationCanceledException && process.process == IntPtr.Zero && cancelled;
      failure = error;
    }
    finally {
      // Root exit does not imply tree exit. Always terminate the job, verify no
      // remaining members, then drain the now-closed pipes before reporting done.
      if (job != IntPtr.Zero) {
        try { Check(TerminateJobObject(job, 1), "TerminateJobObject"); WaitForEmptyJob(job); cleanupVerified = true; }
        catch (Exception error) { failure = error; }
      }
      inputQueue.CompleteAdding();
      Close(ref inRead); Close(ref inWrite); Close(ref outWrite); Close(ref errWrite);
      if (outPump != null) outPump.Join(); if (errPump != null) errPump.Join();
      if (inputPump != null) inputPump.Join();
      if (failure == null && pumpError != null) failure = pumpError;
      Close(ref outRead); Close(ref errRead); Close(ref process.thread); Close(ref process.process);
      lock (jobLock) { activeJob = IntPtr.Zero; Close(ref job); }
      if (attributesReady) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handleMemory != IntPtr.Zero) Marshal.FreeHGlobal(handleMemory);
      if (jobMemory != IntPtr.Zero) Marshal.FreeHGlobal(jobMemory);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
    }
    if (prelaunchCancelled && cleanupVerified && failure is OperationCanceledException && pumpError == null) failure = null;
    if (failure != null) { EmitError(failure); return; }
    string reportedExitCode = prelaunchCancelled ? "null" : exitCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
    lock (outputLock) {
      Console.Out.WriteLine("{\"type\":\"exit\",\"exitCode\":" + reportedExitCode + ",\"stopped\":" + (cancelled ? "true" : "false") + "}");
      Console.Out.Flush();
    }
  }
}
`

// Compress only fixed package source so -EncodedCommand stays below Windows'
// 32767-character command-line limit. Request bytes are never executable source.
const compressedNative = gzipSync(Buffer.from(nativeSource, 'utf8')).toString('base64')
const wrapperSource = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Windows MCP helper requires FullLanguage' }
  $expectedHome = [IO.Path]::GetFullPath([IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0'))
  if (-not [String]::Equals($PSHOME, $expectedHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected system PowerShell installation' }
  $moduleDirectory = [IO.Path]::Combine($expectedHome, 'Modules')
  $manifest = [IO.Path]::Combine($moduleDirectory, 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
  if (-not [IO.File]::Exists($manifest) -or ([IO.File]::GetAttributes($manifest) -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) { throw 'Unexpected built-in Utility manifest' }
  $ancestor = [IO.Path]::GetDirectoryName($manifest)
  while (-not [String]::IsNullOrEmpty($ancestor)) {
    if ([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected built-in Utility ancestor' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
  }
  # Windows PowerShell can add default module directories during startup.
  # Restore the fixed OS-only lookup path before loading the exact component.
  [Environment]::SetEnvironmentVariable('PSModulePath', $moduleDirectory)
  Import-Module -Name $manifest -ErrorAction Stop
  $compressed = '${compressedNative}'
  $memory = [IO.MemoryStream]::new([Convert]::FromBase64String($compressed))
  $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress)
  $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
  $source = $reader.ReadToEnd()
  $reader.Dispose()
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition $source -ErrorAction Stop
  $line = [Console]::ReadLine()
  if ($null -eq $line) { exit 0 }
  $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $line -ErrorAction Stop
  $environment = Microsoft.PowerShell.Utility\New-Object 'System.Collections.Generic.Dictionary[string,string]'
  foreach ($property in $request.env.PSObject.Properties) {
    $environment.Add($property.Name, [string]$property.Value)
  }
  [ViviMcpJob]::Run([string]$request.executable, [string[]]@($request.args), [string]$request.cwd, $environment)
} catch {
  $data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message))
  [Console]::Out.WriteLine('{"type":"error","data":"' + $data + '"}')
  [Console]::Out.Flush()
  exit 1
}
`

const encodedWrapper = Buffer.from(wrapperSource, 'utf16le').toString('base64')
const protocolLineLimit = 24_000
const helperEnvNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR'] as const

function helperEnvironment(host: Readonly<NodeJS.ProcessEnv>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const wanted of helperEnvNames) {
    const entry = Object.entries(host).find(
      ([key, value]) => key.toLowerCase() === wanted.toLowerCase() && value !== undefined
    )
    if (entry?.[1] !== undefined) result[wanted] = entry[1]
  }
  return result
}

function fullyQualified(value: string): boolean {
  // A rooted \path still depends on the current drive; require drive-qualified
  // or UNC/device-qualified paths rather than resolving against helper state.
  return win32.isAbsolute(value) && /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(value)
}

function validateInput(input: WindowsMcpInput): void {
  if (!fullyQualified(input.executable) || !fullyQualified(input.cwd))
    throw new Error('Windows MCP executable and cwd must be absolute')
  if (/^(?:cmd\.exe|command\.com)$/i.test(win32.basename(input.executable)))
    throw new Error('cmd.exe/command.com custom command-string parsing is unsupported')
  if (
    input.executable.includes('\0') ||
    input.cwd.includes('\0') ||
    input.args.some((value) => typeof value !== 'string' || value.includes('\0'))
  )
    throw new Error('Windows MCP paths and arguments cannot contain NUL')
  const names = new Set<string>()
  for (const [key, value] of Object.entries(input.env)) {
    if (
      !key ||
      key.includes('=') ||
      key.includes('\0') ||
      typeof value !== 'string' ||
      value.includes('\0')
    )
      throw new Error('Invalid Windows environment entry')
    if (names.has(key.toLowerCase()))
      throw new Error('Windows environment names must be unique ignoring case')
    names.add(key.toLowerCase())
  }
}

/** Windows 10+/Server 2016+ with built-in Windows PowerShell FullLanguage. */
export async function launchWindowsMcp(
  input: WindowsMcpInput,
  runtime: WindowsMcpRuntime = {}
): Promise<WindowsMcpProcess> {
  validateInput(input)
  const env = helperEnvironment(runtime.hostEnv ?? input.env)
  if (!env.SystemRoot || !fullyQualified(env.SystemRoot))
    throw new Error('Windows SystemRoot is unavailable')
  const executable = win32.join(
    env.SystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  // Helper setup only. The approved MCP target environment remains request data.
  env.PSModulePath = win32.join(win32.dirname(executable), 'Modules')
  const stdout = new PassThrough({ highWaterMark: 16_384 })
  const stderr = new PassThrough({ highWaterMark: 16_384 })
  let resolveReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // A caller may close before awaiting startup. Observe internally without
  // changing the strict promise handed to the transport's startup boundary.
  void ready.catch(() => undefined)
  let resolveCompleted!: (value: WindowsMcpResult) => void
  const completed = new Promise<WindowsMcpResult>((resolve) => {
    resolveCompleted = resolve
  })
  const child = (runtime.spawn ?? nodeSpawn)(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedWrapper],
    {
      shell: false,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let result: WindowsMcpResult | undefined
  let pending = ''
  let wrapperDiagnostics = ''
  let settled = false
  let started = false
  let stopping = false
  let terminalReceived = false
  let closed = false
  let invalidProtocol = false
  let blocked: PassThrough | undefined
  let stopTimer: ReturnType<typeof setTimeout> | undefined
  const pendingInputs = new Set<(failed: boolean) => void>()
  const closeControl = (): void => {
    if (settled) return
    try {
      if (!child.stdin?.writableEnded) child.stdin?.end()
    } catch {
      result = { exitCode: null, error: 'Windows MCP control pipe failed' }
      invalidProtocol = true
      pending = ''
      blocked = undefined
      stdout.resume()
      stderr.resume()
      child.stdout?.resume()
      // Even if end() throws, destroying the pipe signals EOF. The fallback
      // timer below remains responsible for a helper that cannot acknowledge it.
      try {
        child.stdin?.destroy()
      } catch {
        /* bounded helper termination below */
      }
    }
    if (settled || stopTimer !== undefined) return
    stopTimer = setTimeout(() => {
      if (terminalReceived && result?.error === undefined)
        result = {
          exitCode: null,
          error: 'Windows MCP helper did not close after its terminal result'
        }
      child.kill('SIGKILL')
    }, runtime.cleanupTimeoutMs ?? 10_000)
    stopTimer.unref()
  }
  const requestStop = (): void => {
    if (settled || stopping) return
    stopping = true
    if (!started) rejectReady(new Error('Windows MCP startup cancelled before readiness'))
    stdout.resume()
    stderr.resume()
    closeControl()
  }
  const failProtocol = (message: string): void => {
    result = { exitCode: null, error: message }
    invalidProtocol = true
    pending = ''
    blocked = undefined
    if (!started) rejectReady(new Error('Windows MCP startup failed before readiness'))
    requestStop()
    child.stdout?.resume()
  }
  const frame = (line: string): void => {
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object') throw new Error('frame')
      const record = value as Record<string, unknown>
      if (terminalReceived) throw new Error('frame after terminal result')
      if (record.type === 'started') {
        if (started || Object.keys(record).length !== 1) throw new Error('readiness')
        started = true
        // EOF may race the helper's already-resumed Job acknowledgment. Keep
        // draining its legitimate terminal result, without reopening startup.
        if (!stopping) resolveReady()
      } else if (record.type === 'stdout' || record.type === 'stderr' || record.type === 'error') {
        if (!started && record.type !== 'error') throw new Error('output before readiness')
        if (
          typeof record.data !== 'string' ||
          record.data.length > protocolLineLimit ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.data)
        )
          throw new Error('data')
        const bytes = Buffer.from(record.data, 'base64')
        if (record.type === 'stdout' || record.type === 'stderr') {
          const output = record.type === 'stdout' ? stdout : stderr
          if (!output.write(bytes)) {
            blocked = output
            child.stdout?.pause()
          }
        } else {
          result = { exitCode: null, error: bytes.toString('utf8') }
          if (!started) rejectReady(new Error('Windows MCP startup failed before readiness'))
          terminalReceived = true
          closeControl()
        }
      } else if (record.type === 'exit') {
        const validCode =
          Number.isInteger(record.exitCode) &&
          (record.exitCode as number) >= 0 &&
          (record.exitCode as number) <= 0xffffffff
        if (
          typeof record.stopped !== 'boolean' ||
          (!validCode && !(record.exitCode === null && record.stopped)) ||
          (!started && !(record.exitCode === null && record.stopped)) ||
          result !== undefined
        )
          throw new Error('exit')
        const exitCode = record.exitCode as number | null
        result = record.stopped || stopping ? { exitCode, signal: 'SIGTERM' } : { exitCode }
        if (!started) rejectReady(new Error('Windows MCP startup cancelled before readiness'))
        terminalReceived = true
        // Final metadata acknowledges an empty Job Object. Close the control pipe so the helper’s reader can finish.
        closeControl()
      } else throw new Error('type')
    } catch {
      failProtocol('Invalid Windows MCP helper protocol')
    }
  }
  const finish = (): void => {
    if (!closed || settled || blocked) return
    settled = true
    if (!started) rejectReady(new Error('Windows MCP helper closed before readiness'))
    if (stopTimer !== undefined) clearTimeout(stopTimer)
    stdout.end()
    stderr.end()
    if (pending.length !== 0)
      result = { exitCode: null, error: 'Incomplete Windows MCP helper protocol' }
    for (const done of pendingInputs) done(true)
    resolveCompleted(
      result ?? {
        exitCode: null,
        error:
          'Windows MCP helper closed without verified tree cleanup' +
          (wrapperDiagnostics ? ': ' + wrapperDiagnostics : '')
      }
    )
  }
  const processProtocol = (): void => {
    if (invalidProtocol) {
      finish()
      return
    }
    let newline: number
    while (!blocked && (newline = pending.indexOf('\n')) !== -1) {
      if (newline > protocolLineLimit) {
        failProtocol('Windows MCP helper frame exceeded its limit')
        break
      }
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      frame(line)
      if (invalidProtocol) break
    }
    if (blocked && pending.length > 131_072)
      failProtocol('Windows MCP helper output queue exceeded its limit')
    else if (!blocked && pending.length > protocolLineLimit)
      failProtocol('Windows MCP helper frame exceeded its limit')
    finish()
  }
  for (const stream of [stdout, stderr])
    stream.on('drain', () => {
      if (blocked !== stream) return
      blocked = undefined
      processProtocol()
      if (!blocked) child.stdout?.resume()
    })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (settled || invalidProtocol) return
    pending += chunk
    processProtocol()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    wrapperDiagnostics = (wrapperDiagnostics + chunk.toString('utf8')).slice(0, 4096)
  })
  const inputFailed = (): void => {
    // A terminal frame already verifies the empty Job. A late EPIPE while
    // closing that control pipe must not overwrite the authoritative result.
    if (!settled && !terminalReceived) failProtocol('Windows MCP input failed')
  }
  child.stdin?.on('error', inputFailed)
  child.on('error', (error: Error) => {
    result = { exitCode: null, error: error.message }
  })
  child.on('close', () => {
    closed = true
    finish()
  })
  // No credentials or server metadata appear in helper argv/env.
  try {
    if (!child.stdin) inputFailed()
    else
      child.stdin.write(JSON.stringify(input) + '\n', 'utf8', (error) => {
        if (error) inputFailed()
      })
  } catch {
    inputFailed()
  }
  return {
    stdout,
    stderr,
    ready,
    completed,
    async write(bytes) {
      if (
        bytes.length > 65_536 ||
        !started ||
        settled ||
        stopping ||
        terminalReceived ||
        !child.stdin ||
        child.stdin.destroyed ||
        child.stdin.writableEnded
      )
        throw new Error('MCP input is unavailable or exceeds its limit')
      await new Promise<void>((resolve, reject) => {
        let finished = false
        const done = (failed: boolean): void => {
          if (finished) return
          finished = true
          pendingInputs.delete(done)
          if (failed) reject(new Error('Windows MCP input failed'))
          else resolve()
        }
        // Stream callbacks normally run on close, but completion is also an
        // explicit bound for interrupted writes and unusual stream runtimes.
        pendingInputs.add(done)
        try {
          child.stdin!.write(bytes.toString('base64') + '\n', (error) => {
            if (error) inputFailed()
            done(Boolean(error))
          })
        } catch {
          inputFailed()
          done(true)
        }
      })
    },
    async stop() {
      requestStop()
      await completed
    }
  }
}
