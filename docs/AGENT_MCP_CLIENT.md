# Agent MCP client

The built-in Agent connects to trusted installed **stdio** MCP servers or anonymous
**Streamable HTTP** endpoints. This is separate
from **External agent access**, the existing authenticated loopback server that lets other
agents inspect or edit Bot Commander. Its settings and capabilities are unchanged.

## Setup and review

1. Add a server ID, label, transport and protocol compatibility. For stdio, use an absolute
   installed executable and working directory plus an argument array. Optional environment
   selections are safe inherited names only. For HTTP, use an HTTPS endpoint with no credentials,
   query or fragment. Unencrypted HTTP requires explicit opt-in and literal `127.0.0.1` or
   `[::1]` for local testing. Values, credentials and custom headers cannot be configured here.
2. Saving or editing starts nothing. Choose **Review startup**, inspect the exact resolved
   executable, arguments, directory, protocol and inherited values for stdio, or the exact HTTP
   endpoint, anonymous authentication revision and network disclosure, then **Start once**.
   Cancellation, expiry or changed details requires a new review.
3. Inspect captured tools locally. Explicit refresh controls fetch resource and template
   metadata. Stale, quarantined, unsupported or failed categories cannot authorize a call.
4. Send an Agent request. External operations stop for **Approve once** or **Reject**,
   including Auto. Reads use an exact discovered concrete URI or one exact URI expanded
   from a captured available scalar template. Review the template, exact string values,
   expanded URI and resources/read route before approving.
   Local metadata listing makes no server request. Planning permits metadata only.
5. Disconnect stops the owned connection. Restart, reconnection and a new launch need
   fresh explicit startup review. No connection is restored automatically.

Starting a stdio server executes its installed code with your OS permissions before tool
approval. It can access files and the network; this is not a sandbox. Ready metadata is
advertised to the selected model, and approved returned text/structured data enters the
local transcript and selected provider context. Descriptions, annotations, output and
resource contents remain untrusted data. A read-only annotation does not prove effects.
Starting an HTTP connection sends initialization and discovery traffic before tool approval;
the endpoint can observe the client's network address and MCP traffic. Redirects are refused.
HTTP uses the same approval, catalog freshness and unknown-outcome boundaries as stdio.

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
quarantined rather than weakened. Available scalar RFC 6570 Level 1–3 templates can
propose exact reads; prefix/explode modifiers and composite values remain unavailable.
Every named variable is required as a string, with no extras. Expansion is synchronous
and performs no I/O, and the URI is never normalized or directly fetched. Reserved
expansion with malformed percent text is withheld when the expanded URI fails validation. Binary bodies are omitted
and resource links are never followed. OAuth/authentication flows, credential injection,
known package/shell runners, installers, automatic input fulfilment, tasks and subscriptions
are unavailable. Trusted installed server code can still execute arbitrary code internally.
The model cannot start servers or refresh discovery.
HTTP connections in this slice are anonymous only. The session token/revision seam is
main-process-only; there is no credential-entry UI, OAuth flow or auth IPC.

## Implementation and verification

Published `@ayayaq/vivi@0.13.0` supplies shared catalog/schema, immutable proposal and bounded
result projection through `@ayayaq/vivi/extensions/mcp`. Electron main owns the official
MCP client SDK 2.3.1 production dependency, process lifecycle, persistence, privacy, approvals
and actual send. Pinned `url-template@3.1.1` supplies the zero-dependency scalar
expander, behind the shared core’s template/value/URI checks; no local RFC parser is duplicated.
The template identity and expanded wire URI stay separate in approvals and outcomes.
Renderer controls use the trusted, whitelisted preload IPC boundary.

Focused checks use synthetic SDK peers, injected adapters, mocked providers and temporary
state. Headless UI and Windows native process checks are separate verification stages.
These do not establish live-provider, Discord or arbitrary real-server readiness.

Host adapters derive from Apache-2.0
[vivi-cli c748317](https://github.com/ayayaQ/vivi-cli/tree/c748317cb87a72f4e023cc21b96e793ea89e3170).
The HTTP wire guard derives from `mcp-http-transport.ts` in
[vivi-cli 38978a34](https://github.com/ayayaQ/vivi-cli/tree/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c).
Adapted files carry notices; the upstream license and notice are retained in `docs/licenses`.
No SDK source, third-party binaries or dependency tarballs are vendored.
