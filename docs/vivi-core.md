# vivi shared-runtime integration

The generic sequential provider/tool loop lives in the separate
[ayayaQ/vivi](https://github.com/ayayaQ/vivi) repository. Bot Commander consumes a reviewed,
versioned `@ayayaq/vivi` package snapshot from `vendor/`, with the source commit, tree and archive digest recorded
beside it. The lockfile also verifies npm's package integrity. No npm registry release or runtime
Git authentication/build is required.

This branch integrates the unreleased `0.2.0-dev.0` development snapshot. The published npm
`0.1.0` release contains the original core, without these provider subpaths or progress helpers.

## Responsibilities

vivi owns ordered provider rounds, matched tool-call/result history, immutable callback snapshots,
cancellation-aware waits, usage totals, canonical-history validation/recovery and explicit terminal
outcomes. Its root entry point has no Electron, Discord, UI, filesystem, provider SDK, storage,
authorization or sandbox dependency. Optional provider subpaths own OpenAI Responses/OpenRouter
Chat wire formats, native-history projection and bounded streaming HTTP; the package has no runtime
dependencies.

Bot Commander owns the small settings/session provider bridge, prompts, memories, documentation policy,
manual/auto/planning modes, approval previews, domain tool implementation, persistence, revision
checks and UI events. Planning filters mutation definitions, and the host executor still refuses
mutations in planning mode. Approval is registered before events are published. Preparation and
approval are followed by run-ownership/cancellation checks before commit. A queued mutation
checks cancellation again when its resource lock is admitted; already executing commits are not
rolled back. Existing resource locks and fresh-revision checks remain unchanged.

The app's existing moderation-key configuration guard remains at the full service entry point.
The generic OpenRouter factory requires only its own key. Desktop attribution stays in the bridge.
Legacy reasoning `none` continues to mean provider default; its UI label now says so. Existing
effort controls are an explicit host compatibility assertion rather than discovered model metadata.
Desktop requests have a finite ten-minute timeout and zero automatic retries, with immediate
user cancellation. The generic factory's default timeout remains sixty seconds.

Canonical history is stored separately from display messages. It includes intermediate assistant
text, arguments, native assistant continuation metadata and exact provider-visible tool outputs.
Native metadata is reused only for the same provider and model. Switching provider or model
projects the canonical text/calls/results without incompatible native reasoning.

Streaming text is bounded, run-scoped display state only. Completed provider output is validated
before any tool executes; partial calls cannot run. Display state resets on accepted assistant
output, a new run or terminal status, and stale queued IPC cannot overwrite a newer active run.

Older sessions reconstruct matched exchanges from their stored tool display records; missing
intermediate assistant text/native metadata cannot be recovered. Interrupted checkpoints get
explicit unknown-outcome results without replaying historical tools. New runs must read current
resource state before retrying an interrupted mutation. Cancellation cannot roll back a mutation
already committed or stop a host operation that ignores its signal.

Recovery delegates canonical exchanges to vivi's shared helper. Legacy desktop display-message
migration remains host-specific, as do persistence, result truncation and context/memory policy.

The returned transcript is authoritative on cancellation/errors, including synthetic results for
accepted calls that did not finish. The desktop reconciles it before persisting terminal status.
Tool output truncation produces a marked JSON envelope instead of cutting JSON mid-value.

## Updating the vendored package

1. Review and test the new vivi source revision, then run its complete `npm run check`
2. Build and `npm pack` that exact checkout; copy the archive into `vendor/`
3. Update the package's source revision/tree/digest record and local-file dependency together
4. Regenerate the lockfile without changing unrelated dependency versions
5. Verify a clean `npm ci`, full tests, typecheck, production build and headless package contents

Do not replace the package with an absolute filesystem path or a mutable Git branch. A new vivi
snapshot is a normal reviewed dependency change. The desktop project retains its existing GPL
license; vivi is separately licensed Apache-2.0 by its owner.

PR #12's proposed offline draft validation remains host code. Integrating that PR later should
retain lint/validation binding, bounded repair counts, unsupported-candidate approval and
cancellation checks inside the host executor; it does not require changing vivi's domain-neutral
API.
