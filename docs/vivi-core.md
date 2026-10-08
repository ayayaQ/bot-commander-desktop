# vivi shared-runtime integration

The generic sequential provider/tool loop lives in the separate
[ayayaQ/vivi](https://github.com/ayayaQ/vivi) repository. Bot Commander consumes a reviewed,
exact npm registry release `@ayayaq/vivi@0.8.0`. The published artifact was verified
byte-for-byte against the reviewed release archive; its immutable registry URL and
SHA-512 integrity are recorded in the lockfile. Runtime Git authentication/build is
not required, and npm pack outputs are not committed to this repository.

The `0.2.0` release added the shared provider subpaths and canonical-history helpers;
`0.3.0` added the explicit extension registry and shared calculator. Published `0.4.0`
also includes the pure optional `providers/models` capability normalizer. The earlier
`0.1.0` release contains only the original core.

## Responsibilities

vivi owns ordered provider rounds, matched tool-call/result history, immutable callback snapshots,
cancellation-aware waits, usage totals, canonical-history validation/recovery and explicit terminal
outcomes. Its root entry point has no Electron, Discord, UI, filesystem, provider SDK, storage,
authorization or sandbox dependency. Optional provider subpaths own OpenAI Responses/OpenRouter
Chat wire formats, native-history projection and bounded streaming HTTP; the package has no runtime
dependency outside the optional memory subpath, which uses exact `yaml@2.9.1`.

Bot Commander owns the small settings/session provider bridge, prompts, memories, documentation policy,
manual/auto/planning modes, approval previews, domain tool implementation, persistence, revision
checks and UI events. Planning filters mutation definitions, and the host executor still refuses
mutations in planning mode. Approval is registered before events are published. Preparation and
approval are followed by run-ownership/cancellation checks before commit. A queued mutation
checks cancellation again when its resource lock is admitted; already executing commits are not
rolled back. Existing resource locks and fresh-revision checks remain unchanged.

The app's existing moderation-key configuration guard remains at the full service entry point.
The generic OpenRouter factory requires only its own key. Desktop attribution stays in the bridge.
Legacy reasoning `none` continues to mean provider default; its UI label says so. Explicit
agent disable is a separate selection. Named effort choices now require documented capability
support; unsupported or unknown saved overrides are preserved and produce an actionable error
instead of silently substituting a different request. Provider default remains usable without
asserting whether the model will reason.
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

## Endpoint-aware model capabilities

The optional shared normalizer reports supported, unsupported or unknown for text conversation,
tools, streaming, reasoning, effort selection and explicit disable. It does not fetch catalogs,
prove account access, choose a model or change provider requests. Bot Commander owns catalog
discovery, account isolation, documented host facts, selection and UI policy.

Agent OpenAI requests use Responses. General bot-chat remains on Chat Completions; OpenRouter
uses its existing Chat Completions gateway. Facts for one endpoint do not establish support on
another. Exact custom IDs remain usable with provider default when metadata is absent. Unknown
tool support does not advertise agent tools. Explicitly unsupported streaming selects non-stream
transport; unknown streaming preserves the host's requested setting without claiming support.

The small shared seed enriches the retained documented Responses registry and its exact
task-specific exclusions. Separately reviewed Chat Completions facts and the exact default
`gpt-5.4-nano` alias/snapshot retain endpoint scope and official source dates. No model prefix or
generated snapshot name supplies capability evidence. The sources describe a reviewed snapshot,
not current account visibility or guaranteed request success.

Catalog capability metadata stays in memory and is scoped to provider/account identity. Older
async results cannot replace a newer fetch. Missing, expired or mismatched metadata falls back
to unknown; credentials and raw catalog properties are not persisted with capability snapshots.

An agent disable request maps the separate documented disable fact into the provider factory's
`none` capability sentinel, including optional OpenRouter reasoning with no named effort selector.
General bot-chat does not gain a new disable request. Its existing default omission, valid
request payloads, endpoint selection and moderation behavior remain host-owned and unchanged.

The returned transcript is authoritative on cancellation/errors, including synthetic results for
accepted calls that did not finish. The desktop reconciles it before persisting terminal status.
Tool output truncation produces a marked JSON envelope instead of cutting JSON mid-value.

## Updating the shared package

1. Review and test the new vivi source revision, then run its complete `npm run check`
2. Build and `npm pack` that exact checkout, then publish the compatible shared npm release first
3. Verify the registry-served archive's bytes and integrity against the reviewed release artifact
4. Update the exact registry dependency and regenerate the lockfile, preserving every unrelated
   dependency entry, including locked versions, resolutions, integrity and platform metadata
5. Verify a clean `npm ci`, full tests, typecheck, production build and headless package contents,
   including the shared source, LICENSE, NOTICE and attribution records

Do not commit archive outputs or reintroduce vendor tarballs, absolute filesystem dependencies,
version ranges or mutable Git branches. Historical tracked snapshots remain recoverable from Git.
A new vivi release is a normal reviewed dependency change; it does not release or deploy the
application. The desktop project retains its existing GPL license; vivi is separately licensed
Apache-2.0 by its owner.

PR #12's proposed offline draft validation remains host code. Integrating that PR later should
retain lint/validation binding, bounded repair counts, unsupported-candidate approval and
cancellation checks inside the host executor; it does not require changing vivi's domain-neutral
API.
