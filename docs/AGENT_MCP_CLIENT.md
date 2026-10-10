# Agent MCP client

The built-in Agent connects to trusted installed **stdio** MCP servers. This is separate
from **External agent access**, the existing authenticated loopback server that lets other
agents inspect or edit Bot Commander. Its settings and capabilities are unchanged.

## Setup and review

1. Add a local server ID, label, absolute installed executable and working directory,
   argument array and protocol compatibility. Optional environment selections are safe
   inherited names only. Values and credentials cannot be configured here.
2. Saving or editing starts nothing. Choose **Review startup**, inspect the exact resolved
   executable, arguments, directory, protocol and inherited values, then **Start once**.
   Cancellation, expiry or changed details requires a new review.
3. Inspect captured tools locally. Explicit refresh controls fetch resource and template
   metadata. Stale, quarantined, unsupported or failed categories cannot authorize a call.
4. Send an Agent request. External operations stop for **Approve once** or **Reject**,
   including Auto. Only an exact discovered concrete resource URI can be read.
   Local metadata listing makes no server request. Planning permits metadata only.
5. Disconnect stops the owned connection. Restart, reconnection and a new launch need
   fresh explicit startup review. No connection is restored automatically.

Starting a server executes its installed code with your OS permissions before tool
approval. It can access files and the network; this is not a sandbox. Ready metadata is
advertised to the selected model, and approved returned text/structured data enters the
local transcript and selected provider context. Descriptions, annotations, output and
resource contents remain untrusted data. A read-only annotation does not prove effects.

## Outcomes and limits

Each attempt is bound to the active session/run, exact arguments, approved request,
configuration, launch, connection and captured catalog. The actual transport send consumes
one approval and repeats those checks. Resource reads bypass SDK body caches.

Cancellation cannot undo effects. A known not-attempted result is shown separately from
a possibly sent request whose result is unconfirmed. Unknown outcomes keep **do not retry**
warnings, invalidate the connection and require inspecting the external resource before
another attempt. A bounded host-owned send-intent/outcome record reconciles cancellation
and interrupted history; it contains no reusable approvals and never replays a request.
Unconfirmed checkpointing blocks further calls and preserves recovery evidence.
An older backup cannot prove delivery of newer attempts. Corrupt primary evidence, or a
missing primary with a backup, is retained across restarts and blocks external calls;
the ledger is never automatically replaced with an older backup. Ordinary chat remains available.

Persistence uses the existing atomic file/checkpoint lifecycle, with private owned bounded
file preflight. It does not defend against concurrent same-user replacement of application
files. Unsupported directory-sync platforms provide atomic replacement without a
power-loss rename guarantee. Filesystem/storage support still limits durability.

Catalogs, schemas, arguments and final results are bounded. Unsupported schemas are
quarantined rather than weakened. Templates are metadata-only. Binary bodies are omitted
and resource links are never followed. HTTP, OAuth/authentication, credential injection,
known package/shell runners, installers, automatic input fulfilment, tasks and subscriptions
are unavailable. Trusted installed server code can still execute arbitrary code internally.
The model cannot start servers or refresh discovery.

## Implementation and verification

Published `@ayayaq/vivi@0.9.0` supplies shared catalog/schema, immutable proposal and bounded
result projection through `@ayayaq/vivi/extensions/mcp`. Electron main owns the official
MCP client SDK 2.3.1 production dependency, process lifecycle, persistence, privacy, approvals
and actual send. Renderer controls use the trusted, whitelisted preload IPC boundary.

Focused checks use synthetic SDK peers, injected adapters, mocked providers and temporary
state. Headless UI and Windows native process checks are separate verification stages.
These do not establish live-provider, Discord or arbitrary real-server readiness.

Host adapters derive from Apache-2.0
[vivi-cli c748317](https://github.com/ayayaQ/vivi-cli/tree/c748317cb87a72f4e023cc21b96e793ea89e3170).
Adapted files carry notices; the upstream license and notice are retained in `docs/licenses`.
No SDK source, third-party binaries or dependency tarballs are vendored.
