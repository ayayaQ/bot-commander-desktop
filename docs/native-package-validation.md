# Native unpacked package validation

These CLI helpers support Windows x64 and macOS arm64 on their native hosts. Use a fresh,
isolated checkout and an exclusive machine lease for install/build/package/probe work. They
create unpacked test artifacts only. They do not publish, make installers, sign, notarize,
change Electron fuses, or establish visual acceptance. The full probe launches only the explicit
synthetic no-window bootstrap in the actual packaged executable.

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
node scripts/verify-native-package.mjs --artifact "$evidence/package/win-unpacked" --report "$evidence/native.json"
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
npm test -- src/main/index.test.ts src/main/nativeStartupRoute.test.ts src/main/nativeStartupDispatch.test.ts src/main/nativePackageProbe.test.ts
npm run build
node scripts/package-native.mjs --output "$evidence/package" --report "$evidence/package.json"
node scripts/verify-native-package.mjs --artifact "$evidence/package/mac-arm64/Bot Commander for Discord.app" --report "$evidence/portable.json" --portable-only
node scripts/verify-native-package.mjs --artifact "$evidence/package/mac-arm64/Bot Commander for Discord.app" --report "$evidence/native.json"
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
`packagedStartup`, `normalStartup`, `manualVisual`, and `hostedCI` as `not_run`. Without
`--portable-only`, it additionally launches the **actual hardened packaged executable** with
`--bcfd-native-probe=<owned control.json>`, without Node-mode, debugging or security overrides.
It requires bound ready/quit receipts, observed native quit events, matching process ID,
source/ASAR hashes, a single fake provider call, zero window events, default module absence
from the module cache, and exit zero within thirty seconds. Only both selected stages passing
produce exit **0**. Assertion/process failures exit **1**, retaining the failing stage and error.
Temporary synthetic directories are removed in `finally`; packages and JSON evidence remain.
Normal startup/persistence, manual visual interaction and hosted CI remain `not_run` in both modes.

## Opt-in synthetic bootstrap

Do not launch the hardened executable using `ELECTRON_RUN_AS_NODE`; its `runAsNode` fuse is
disabled. Do not change that fuse or inject a replacement application. Following an explicit
coordinator startup assignment, `src/main/index.ts` now dispatches before profile-dependent
imports. With no probe flag it dynamically loads `normalStartup.ts`, which retains the original
startup body byte-for-byte and is emitted at `out/main/normalStartup.js` beside the dispatcher.
Its existing icon/preload/renderer/worker paths retain the same directory base. The existing
portable MCP verifier checks both emitted entries and keeps its original default-startup assertions.

Probe mode accepts a fresh test-owned directory with matching `control.json` and `owner.json`.
It creates synthetic `userData`/session/log directories before Electron readiness, validates the
ASAR identity with raw filesystem bytes, and loads only the public core fake-transport provider.
It imports no desktop settings, auth, persistence or provider service graph. Invalid probe flags
exit nonzero without loading normal startup. The native probe emits ready output, calls
`app.quit()`, observes `before-quit`/`will-quit`/`quit`, and records its terminal receipt. It has a
fifteen-second internal deadline. It never creates a window, tray or server, calls safeStorage,
opens an external URL, or shows native credential dialogs. The caller supplies a minimal synthetic
home environment as well as the explicit fresh `userData` root.

This synthetic Electron lifecycle does **not** exercise normal persistence draining, real provider
setup, window rendering, native dialogs or manual interaction. The unchanged normal startup
recovery/shutdown behavior remains covered by its existing ordinary unit assertions. If macOS
refuses to run the unsigned bundle, retain the actual failure; do not sign (including ad hoc),
change security settings or claim native lifecycle success from the stock-runtime portable probe.

## Hosted Windows coverage and remaining platform limits

The `native-package-windows-synthetic` job in `.github/workflows/ci.yml` uses `windows-2025`,
Node 24, a locked install, the helper and four startup test files, and `npm run build`. It runs
both helpers with output under `RUNNER_TEMP`, checks portable artifacts and the synthetic native
lifecycle, and retains only the package/native JSON receipts, including failure receipts when
available. The job has a twenty-minute limit and creates one unsigned unpacked test package.
Existing Linux and Windows MCP/skills coverage is retained. This stage does not establish
normal startup/persistence or visual acceptance.

Gate an arm64 Mac job on an actual clean arm64 Mac receipt and runner availability/cost. Do not
add a macOS CI claim based on Windows checks or local Mac packaging alone. Measured timings,
artifact sizes, source SHA and hashes belong in the coordinator evidence, not estimated passes.
Rebuild and re-probe the final combined candidate after A4/settings or A5/package changes that
affect startup. macOS native lifecycle success remains unestablished until an actual successful
receipt is obtained; portable verification or Windows CI cannot substitute for that result.
