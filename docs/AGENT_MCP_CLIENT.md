# Agent MCP client

The built-in Agent connects to trusted installed **stdio** MCP servers or **Streamable HTTP**
endpoints with anonymous or explicitly reviewed session OAuth access. This is separate
from **External agent access**, the existing authenticated loopback server that lets other
agents inspect or edit Bot Commander. Its settings and capabilities are unchanged.

## Setup and review

1. For a remote server, enter its ID and HTTPS MCP endpoint. HTTP is the default transport,
   compatibility is automatic, and the label defaults to the ID. Advanced options contain
   label/protocol overrides and the explicit loopback HTTP test option. For stdio, choose
   Installed stdio and use an absolute
   installed executable and working directory plus an argument array. Optional environment
   selections are safe inherited names only. For HTTP, use an HTTPS endpoint with no credentials,
   query or fragment. Unencrypted HTTP requires explicit opt-in and literal `127.0.0.1` or
   `[::1]` for local testing. Values, credentials and custom headers cannot be configured here.
2. Saving or editing starts nothing. HTTPS HTTP entries can optionally configure a launch-only
   public OAuth client or explicitly review public-client registration, then separately review
   browser sign-in. The returned grant still requires a fresh MCP connection review.
3. Choose **Review startup**, inspect the exact resolved
   executable, arguments, directory, protocol and inherited values for stdio, or the exact HTTP
   endpoint, session authentication revision and network disclosure, then **Start once**.
   Cancellation, expiry or changed details requires a new review.
4. Inspect captured tools locally. Explicit refresh controls fetch resource and template
   metadata. Stale, quarantined, unsupported or failed categories cannot authorize a call.
5. Send an Agent request. External operations stop for **Approve once** or **Reject**,
   including Auto. Reads use an exact discovered concrete URI or one exact URI expanded
   from a captured available scalar template. Review the template, exact string values,
   expanded URI and resources/read route before approving.
   Local metadata listing makes no server request. Planning permits metadata only.
6. Disconnect stops the owned connection. Restart, reconnection and a new launch need
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

New HTTP entries negotiate compatibility using the pinned SDK on the approved connection:
modern discovery first, with legacy initialization only for a compatible legacy response.
This does not retry tools or resource reads, follow redirects, or start sign-in automatically.
Authentication failures, transport failures and invalid responses stop setup. Existing explicit
legacy/modern settings are preserved; choose Automatic under Advanced to change an HTTP entry.
Installed stdio servers retain legacy negotiation by default; their exact modern override
remains available under Advanced. Automatic probing is HTTP-only: a legacy stdio server may
exit on a pre-initialization probe, and desktop owns only the explicitly approved process.

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
and resource links are never followed. Credential entry/injection, persistent OAuth storage, automatic sign-in/registration/refresh,
known package/shell runners, installers, automatic input fulfilment, tasks and subscriptions
are unavailable. Trusted installed server code can still execute arbitrary code internally.
The model cannot start servers or refresh discovery.

## Session-only OAuth and explicit public-client registration

Only configured HTTPS HTTP entries expose these controls. Public client settings and bearer
credentials stay in Electron main for this app launch. Saving the server or configuring a
registered public client performs no OAuth or MCP network request. There is no credential-entry
UI, persistent token vault, automatic registration, refresh, 401 recovery or operation replay.
The renderer receives only public review disclosures and status through trusted whitelisted IPC.

- Configure an already registered public client ID, pinned issuer, exact nonzero callback port
  and path, and requested scopes. The URI must exactly match
  `http://127.0.0.1:<port><path>`. Requested scopes default to an empty list
- Alternatively choose **Review registration**. Bounded discovery validates issuer, S256 PKCE,
  public `none` client authentication and an advertised registration endpoint. Review the exact
  endpoint, callback and full native authorization-code public metadata before **Register once**.
  This approves one DCR POST only. Returned authority must match exactly; client secrets, expanded
  scopes/grants and changed callbacks are rejected. Optional OIDC application type may be omitted
  and display names may be normalized by the issuer. Management tokens are discarded
- Choose **Review sign-in**, inspect the endpoint, issuer, public client, callback and scopes,
  then **Open browser once**. The owned callback listener starts before the browser opens.
  The browser URL, state, code, verifier and tokens never enter renderer status or saved data
- The user completes provider consent. Successful exchange presents a separate fresh MCP
  **Review startup** disclosure. **Start once** sends initialization/catalog requests only after
  that approval. Cancelling, expiry, failure or rejection clears the new grant

OAuth discovery and code exchange use reviewed CLI primitives and SDK 2.3.1 with HTTPS origin
bounds, redirects refused, 64 KiB bodies, fixed errors and no hidden recovery branches. The
127.0.0.1 callback has exact Host/path/state/issuer checks, bounded requests and owned sockets.
Late responses after cancellation or a changed configuration cannot install a client or token.
Disconnect, cancelled reviews, navigation, pause and shutdown remove bearer authority and close
owned listeners. A 401/403 clears authority and requires explicit sign-in and a new connection
approval; it never replays the rejected request. Public client settings remain in launch memory
after disconnect, and clear on configuration changes, removal or shutdown. Local disconnect
neither deletes the provider registration nor revokes provider-side grants or API keys.

OpenRouter is the first selected compatibility target. Its
[official MCP documentation](https://openrouter.ai/docs/guides/overview/mcp-server) says consent
creates a dedicated key with seven-day expiry and an editable default $10 spending cap. The
sign-in review discloses this for its exact issuer; the generic protocol policy has no provider
exception. Inspect current provider consent before granting access. A cap does not authorize
paid inference. Real client registration, loopback acceptance and browser consent remain a
user-driven acceptance step. Initial testing should stop at handshake/catalog browsing and
explicit read-only listing, without billable inference or feedback writes.

## Implementation and verification

### Review of vivi-cli setup history

Reviewed the October 11–15, 2026 changes around the supplied compatibility commit, including
the earlier desktop OAuth baseline. The useful pieces span several changes rather than just
the protocol selector:

| Upstream change                                                                                                                                                                                                                    | Desktop application                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Explicit session OAuth, #49](https://github.com/ayayaQ/vivi-cli/commit/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c)                                                                                                                  | Already forms the desktop callback, registration and session baseline.                                                                                                                                                                                                      |
| [URL-first setup, #54](https://github.com/ayayaQ/vivi-cli/commit/b89675ad8e35d754bebe61c46e5dd6b61a946d56)                                                                                                                         | Applied the smaller form: default HTTP, ID and URL, optional label defaulting to ID, technical overrides under Advanced. Upstream also discovers issuer/scopes and prepares a public OAuth client during guided sign-in; desktop still requires manual public-client setup. |
| [Saved sign-in, #55](https://github.com/ayayaQ/vivi-cli/commit/d2bfa1d242b5181958f577768053622b3f5a2bc3)                                                                                                                           | Separate follow-up. Requires Electron secure-storage adaptation, explicit remember/session-only choices, bound credential records and safe refresh/logout behavior. Desktop remains session-only.                                                                           |
| [Reviewed agent setup, #56](https://github.com/ayayaQ/vivi-cli/commit/e23885ae505e7e8934a9c45f3dbfcdd85030aa7e)                                                                                                                    | Applied the startup request recheck needed for negotiated HTTP fallback. Model-driven setup tools and their configuration/turn ownership are a separate feature.                                                                                                            |
| [Registration interoperability, #57](https://github.com/ayayaQ/vivi-cli/commit/e2eef7e9f626fed37003ef1c1b65ca2499d80c6e)                                                                                                           | Applied acceptance of omitted optional OIDC metadata and normalized client names. Exact client authority remains checked. Upstream's richer fixed registration/network diagnostics are not part of this change.                                                             |
| [Automatic compatibility, #59](https://github.com/ayayaQ/vivi-cli/commit/87dbe87b57432eb345eb5c0f74ce58779e32ddc4)                                                                                                                 | Applied HTTP `auto`, SDK connect-time negotiation, preserved explicit overrides, and protocol-aware session-header checks. No dependency upgrade or second connection is needed.                                                                                            |
| [Separate phase deadlines](https://github.com/ayayaQ/vivi-cli/commit/8fe7c555a6eac2ef66ff0d2e03b4159ccd06cb3b) and [cold Windows startup, #67](https://github.com/ayayaQ/vivi-cli/commit/5a4cdb032fb349106b6274c0f6db51c994deea6b) | Follow-up for local-server reliability: separate native bootstrap, handshake and catalog deadlines. Upstream assigns its Windows helper a 45-second bootstrap budget. Desktop still has an overall startup/category deadline; this patch does not change timeout policy.    |

The next setup improvement is guided **Connect / Sign in** from a URL, with issuer, scopes,
callback and public-client details discovered in main and shown in a focused review. Moving
the current manual OAuth fields under another disclosure alone would not provide that flow.
That adaptation needs discovery/network bounds and cancellable registration/sign-in ownership,
followed by the saved-credential lifecycle as a separate step.

Automatic compatibility is covered with real SDK/injected HTTP peers for both generations,
one-shot tools/reads, explicit overrides, session headers, authentication and malformed-response
failures, and cancellation/configuration/authorization/privacy changes while probing. The
Chromium fixture covers the compact form, hidden overrides, optional label, inert save and
preservation of both stdio and HTTP settings when editing.

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
The OAuth callback/network/session/DCR primitives and review ownership derive from
[vivi-cli 38978a34](https://github.com/ayayaQ/vivi-cli/tree/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c).
The HTTP wire guard derives from `mcp-http-transport.ts` in
[vivi-cli 38978a34](https://github.com/ayayaQ/vivi-cli/tree/38978a34adf1ae16ea2e61cbe15f9d8b01e1065c).
Adapted files carry notices; the upstream license and notice are retained in `docs/licenses`.
No SDK source, third-party binaries or dependency tarballs are vendored.
