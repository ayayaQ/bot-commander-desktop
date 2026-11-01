# Native unpacked package validation

These CLI helpers support Windows x64 and macOS arm64 on their native hosts. Use a fresh,
isolated checkout and an exclusive machine lease for install/build/package/probe work. They
create unpacked test artifacts only. They do not publish, make installers, sign, notarize,
change Electron fuses, launch the application, or establish visual acceptance.

## Windows x64

Use `npm.cmd` in PowerShell when the shell's execution policy prevents `npm.ps1`. Do not
change execution policy. Choose a new external output directory and external report directory;
neither may be inside the checkout. The examples assume `$evidence` already exists and points
at an allocated evidence directory, with no ancestor `node_modules` providing app dependencies.

```powershell
node --version
node -p "JSON.stringify({platform:process.platform,arch:process.arch})"
npm.cmd ci --no-audit --no-fund
npm.cmd test -- scripts/native-package-support.test.ts
npm.cmd run build
node scripts/package-native.mjs --output "$evidence/package" --report "$evidence/package.json"
node scripts/verify-native-package.mjs --artifact "$evidence/package/win-unpacked" --report "$evidence/portable.json" --portable-only
```

The Windows helper uses the installed electron-builder's `win.signExecutable=false` option.
It preserves executable resource editing (including ASAR integrity metadata) while disabling
code signing. `forceCodeSigning=false`, `--dir`, and `--publish never` are explicit. No signing
credentials are inherited by the packaging child. Existing outputs are refused, never deleted.

## macOS arm64 coordinator run

Run in a **separate clean checkout of the frozen candidate** on the assigned Mac after its
coordinator grants the heavy lease. Record Node/OS/CPU/toolchain versions independently. A
Windows package or simulated architecture test does not validate Mac packaging. The Mac path
below is a `.app` bundle, not its enclosing `mac-arm64` directory.

```sh
node --version
node -p 'JSON.stringify({platform:process.platform,arch:process.arch})'
npm ci --no-audit --no-fund
npm test -- scripts/native-package-support.test.ts
npm run build
node scripts/package-native.mjs --output "$evidence/package" --report "$evidence/package.json"
node scripts/verify-native-package.mjs --artifact "$evidence/package/mac-arm64/Bot Commander for Discord.app" --report "$evidence/portable.json" --portable-only
```

The helper sets `mac.identity=null`, `mac.notarize=false`, `forceCodeSigning=false`, and
`CSC_IDENTITY_AUTO_DISCOVERY=false`, using a minimal child environment with temporary synthetic
home/config/cache directories. It does not inspect a keychain or adjust Gatekeeper, quarantine,
entitlements, hardened runtime, or fuse configuration. Any host/toolchain/architecture failure
must remain in the report. A local Mac receipt does not establish hosted macOS CI coverage.

## Receipt contract and limits

`package-native.mjs` packages an existing production `out` build with the original installed
Electron distribution. Its JSON records the exact arguments, host architecture, duration,
exit status, stdout/stderr and scratch cleanup. Its child deadline is ten minutes.

`verify-native-package.mjs` records all artifact file hashes (and symlink targets), a deterministic
tree hash, build/resource hashes, the PE/Mach-O CPU header and read-only verification of all
configured fuses. The artifact tree must remain unchanged after the probe. The worker is loaded
from the physical `app.asar.unpacked` location with the production resource limits, empty
environment, and no inherited Node arguments. The worker must execute the committed synthetic
QuickJS arithmetic fixture, return matching assertions and exit zero within twenty seconds.

The probe runs the **original installed Electron** in ASAR-aware Node mode, with a sixty-second
outer deadline. It loads every packaged core public export through both CommonJS and ESM,
checks supporting package resolution, compares every built main/preload/renderer/resource file
to the packaged bytes, validates the inline WASM, and exercises one provider call with an
in-memory fake transport. Network tripwires apply only to this disposable fixture process;
they do not change production behavior or OS policy. Newly loaded CommonJS modules must remain
inside the archive, and development dependencies must not resolve. It inventories `.node`
addons; any addon requires a separately assigned load fixture and fails this probe explicitly.

Portable-only mode exits zero only when those assertions pass. Its receipt still marks
`packagedStartup`, `manualVisual`, and `hostedCI` as `not_run`. Without `--portable-only`, the
same successful artifact checks produce `status: partial` and exit **2** because native startup
acceptance is incomplete. Assertion/process failures exit **1**. Temporary synthetic directories
are removed in `finally`; the package and JSON evidence are retained. No real user profile or
credential store is read or written. The synthetic home is a probe-tool directory, not evidence
that production `app.getPath('userData')` was redirected.

## Missing production startup support

Do not launch the hardened executable using `ELECTRON_RUN_AS_NODE`; its `runAsNode` fuse is
disabled. Do not change that fuse or inject a replacement application. `src/main/index.ts`
currently imports services eagerly, captures `userData` paths during module evaluation, starts
the application and server, creates windows/tray, and exposes no CLI readiness/quit receipt.
Testing the worker's clean exit does not test the application persistence shutdown path.

A separately assigned production change would need an early opt-in entry before those imports
and path captures, a caller-created synthetic `userData` directory, fake-only provider/server
initialization, a supported no-window mode, structured readiness/failure output, and a bounded
request to the real graceful shutdown path with a terminal receipt. It must default off and
retain production security settings. A7 does not implement or approve that change. Native
startup/clean shutdown and human visual/dialog checks remain `not_run` until separately evidenced.

## A5 workflow proposal

A5 owns workflow, manifest and lock changes. After reviewing actual local receipts, consider a
separate `windows-2025` portable artifact job: Node 24, locked install, the single helper test file,
`npm run build`, these two helpers with output under `RUNNER_TEMP`, `--portable-only`, and JSON
upload even on failure. Keep a twenty-minute job limit and one package per job. Preserve existing
Linux and Windows MCP/skills coverage. Do not label this job a native application startup smoke.

Gate an arm64 Mac job on an actual clean arm64 Mac receipt and runner availability/cost. Do not
add a macOS CI claim based on Windows checks or local Mac packaging alone. Measured timings,
artifact sizes, source SHA and hashes belong in the coordinator evidence, not estimated passes.
Rebuild and re-probe the final combined candidate after A4/settings or A5/package changes that
affect startup. No CI job or package script is added by these helpers.
