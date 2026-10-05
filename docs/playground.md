# Offline Playground

The bottom-toolbar Playground tab reads saved commands through `get-commands` and runs
message-received commands in a disposable renderer Web Worker. It never invokes bot execution,
persistence, settings, credentials, AI providers or Discord/network services. User templates are
parsed as data with the production parser, then interpreted by a small allowlist. `$eval` scripts
execute only in an isolated QuickJS WASM VM; host JavaScript never evaluates user source. WASM
is embedded locally in the worker bundle with explicit bytes and no network-loading fallback. A worker is terminated on completion, failure, reset, navigation or its 1.5-second
deadline. Request, input, template, output, AST work/depth, command, member, role and transcript
limits are enforced. Aggregate transcript growth is bounded before each message commit, and string replacement expansion is checked before allocation. Reset and navigation invalidate both pending worker results and saved-data
loads. The fake server is local to this tab and is discarded when navigating away.

## What is simulated

- Production message matching: exact, prefix, case-insensitive phrase, wildcard and two-word
  moderation triggers, including production spacing/case behavior
- Required fake roles, administrator and individual moderation/manage-message permissions,
  channel/server whitelists, and configurable fake channel NSFW status
- Fake channel text, replies, DM destinations, text-only embeds, role toggles, kicks, bans, mutes
  and deletion of fake channel transcript entries
- Identity, channel/server, mention/member/role reads, arguments, nested allowlisted functions
  and conditional templates

Role toggles address the invoking member. Traditional moderation addresses a mentioned fake
member only for exactly `trigger mention`. Fake DMs are visible in the transcript, labeled with
the recipient. Embed image/thumbnail URLs and colors are displayed as inert text: no media loads,
links or HTML rendering. Fake IDs are visible beside the member and role controls. Add local fake role IDs and adjust fake server/channel IDs to exercise saved role and whitelist settings without changing saved commands.

## Limits and differences

This is a bounded simulator, not certification of real Discord behavior. Discord hierarchy,
voice connection state, API/permission failures, intent availability, full embed validation,
network ordering, delivery latency and typing duration are not reproduced. The simulator applies
command effects atomically on a cloned fixture; live runtime operations can partially succeed.
Missing roles are explained in the trace rather than generating the production error reply.

Reactions, unknown channels and unlisted BCFD expressions fail closed. Every branch of an evaluated template
is inspected, including inactive conditional branches; JavaScript strings, comments and template
literal static parts remain literal, matching production expression pre-resolution. A failed command leaves no command outputs
or fake mutations; the user's input remains, and other matching commands may run. Completed earlier matching commands remain in the pending turn, but a worker failure, timeout,
reset, navigation or stale completion prevents the entire pending turn from reaching the renderer.

### Delete a specific fake message

`$deleteMessage(MessageId)` targets one regular message in the current fake channel only. Each
transcript entry shows its **Fake message ID**; use that local positive integer as a string,
for example `$deleteMessage(1)` or `$deleteMessage($args(0))` with an input such as `!delete 1`.
Real Discord snowflakes do not identify these fake entries. Reset starts the local IDs over.

The keyword evaluates exactly one argument, trims whitespace, then requires a canonical positive
decimal ID no greater than `18446744073709551615`. A successful simulation marks just that entry
deleted, adds a `Simulated deleteMessage` trace entry and contributes no response text. Repeating
the deletion, targeting a fake DM/ephemeral entry, or targeting an unknown local ID returns
`[BCFD Error: deleteMessage message not found in the current channel]`. Invalid IDs and argument
counts use the same inline BCFD errors as production. These keyword errors are response text;
they do not change the simulator's existing atomic rollback behavior for execution failures.

This local simulation assumes the bot can delete regular fake channel messages, independently
of the invoking member's permissions. It cannot reproduce Discord access, permission or network
failures. No live messages, saved data, credentials or Discord APIs are used.

## Verification

Headless unit tests cover matching, filters, invoker/target distinctions, moderation permissions,
DM/reply/embed data, input immutability, failure rollback, hidden unsupported branches and
resource bounds. Session tests cover disposable-worker termination, deadline, reset/navigation
cancellation and stale completion rejection. Source-graph security tests forbid live services,
network/native dynamic evaluation and renderer embed-loading elements. `npm test`, `npm run typecheck`,
`npm run build` and `git diff --check` are the verification commands. No UI tests, automation,
application launches or walkthroughs were performed for this redo.

## Saved slash commands and buttons

Saved interactions enter through read-only `get-interactions`. Saved snapshots are sanitized with template, total-size, option/choice, and bounded button-tree checks before renderer assignment. Loading message commands and
interactions is independent: an interaction-only saved file and even an unavailable message
command read do not prevent slash simulation. Choose Slash command mode, a saved command and the
fake invoker. Options are typed and validated for required fields, numeric finiteness/integer
range, booleans, known fake user/channel/role IDs and exact typed choice membership. `$option`
returns raw IDs and preserves `false` and `0`. Optional omitted options render as empty strings.
Unregistered saved interactions are allowed in this offline simulator.

Action flags gate output and evaluation. Stale text/embed/role payloads behind disabled action
flags have no effect. The minimal empty interaction response is U+200B and is labeled visibly.
Ephemeral and deferred/edit responses are labeled; this review transcript retains ephemeral
content for inspection instead of hiding it from other simulated senders. Only its recipient can
click ephemeral buttons. DMs and role toggles address the invocation/click member; slash
kick/ban/mute uses the configured **user-typed** target option. Deletion affects only fake channel
messages. Buttons show up to five per row; disabled and link-style buttons never execute, and
link URLs remain inert text.

The production implementation has important differences between slash and button events, which
this simulator follows:

- `contextForInteractionEvent` supplies options only for slash invocations. Button actions and
  their nested labels receive **no original slash options**; `$option` is empty on button clicks.
  No slash-option snapshot is inherited. The current clicking member becomes the invoker.
- `executeButtonAction` does not call `executeInteractionModerationActions`. Moderation and
  deletion flags on button actions are ignored and explicitly explained in the trace. Button
  DMs, embeds, replies, nested buttons and invoker role toggles are simulated.
- Button custom IDs resolve across saved interactions in saved order, as in
  `findInteractionByButtonId`; a button removed from saved data is no longer active.

These checks mirror inspected production orchestration and template data semantics, not Discord
network parity. Moderation errors are shown in the simulator's errors panel with atomic rollback;
live operations may already have succeeded and can emit a failure reply. Real guild scope,
registration, permissions, role hierarchy and API behavior still need live deployment validation.

## Scripts, local state and simulated AI

`$eval ... $halt` uses the current production interpreter's return-wrapped semantics: returned
values are converted to strings inside QuickJS, and no return means empty output. Nested allowed
BCFD expressions are resolved into temporary VM variables, never interpolated as executable
source. Quoted JavaScript strings/comments and template-literal static parts stay literal. The
legacy unwrapped interpreter mode, startup scripts, debug bridge and arbitrary production globals
are not loaded. The VM has no host network, IPC, credentials, Discord client, provider or module
loader. JavaScript Proxy construction is disabled to keep state extraction strictly data-only.

Each command or interaction action gets a fresh VM shared by all its active templates. The
session's `botState` and explicitly `$set`-tracked VM variables are restored before execution and
serialized before commit. `$set(name,value)` stores a VM global string, **not** a `botState` key;
`$get(name)` follows production string conversion (`$get(botState)` is `[object Object]`). Explicit
`$set` variables persist across commands/sends; scripts can change those tracked variables to
JSON-compatible values. Deleted/undefined tracked globals are omitted. Arbitrary untracked
JavaScript globals, functions, closures and intrinsic modifications do not persist between
commands. Set collisions with protected VM globals fail closed; temporary expression variables
must not overwrite user globals. This is a deliberate bounded serialization model, whereas live
production uses a shared long-lived VM and can retain arbitrary JavaScript globals.

Both botState and tracked variables require plain JSON objects/arrays, finite numbers, strings,
booleans and null. Cycles, accessors, functions, undefined values, BigInt, symbols, non-plain
objects and sparse/extra-property arrays are rejected. Each snapshot is limited to 65,536
characters, 10,000 values and depth 32. Script memory is limited to 8 MiB and stack to 128 KiB (below the production 512 KiB ceiling).
A VM's 750ms lifetime covers execution, reads, conversions, error handling, state validation and
serialization; all VMs in a request additionally share a 1-second deadline. The disposable worker's
1.5-second outer deadline includes WASM loading. These limits may reject work that succeeds live.

The JSON editor changes local botState only when Apply is clicked. Every accepted result refreshes
the draft, so later sends cannot restore stale editor data over script results. Reset/navigation
discard botState, tracked globals, cooldown timestamps, AI configuration and the fake clock;
no saved/live bot state or files are ever read or written.

`$chat(prompt)` returns the configured, clearly labeled simulated AI response. The failure field
instead causes a simulated execution error and command rollback. No provider/moderation call or
paid request is made. Response text is inert and never recursively interpreted. Production usually
returns provider failures as text; this configurable fail-closed mode intentionally exercises local
failure/rollback and does not predict a provider's error wording or delivery behavior.

## Cooldowns and acceptance

The fake clock starts at 0ms and advances only through the local 1s/10s controls, without sleeping.
Cooldowns use production keys: command ID plus user ID, server ID or global scope. Remaining time
uses ceiling seconds, with exact-boundary expiry. Timestamp zero is valid; this intentionally fixes
production's truthy-timestamp check for an injected clock starting at zero. Changing fake server
IDs changes server-scope keys, and changing sender changes user-scope keys. `$cooldownRemaining`
uses the requested level or the configured default and never records usage itself.

Message cooldown checks follow channel/server, required-role, admin and NSFW gates. A blocked
message gets a reply with its custom template, or the default remaining-time response unless
ignoreErrorMessage is enabled. Custom templates still run with the same context. Slash cooldown
replies are always ephemeral, whether custom or default. Button actions bypass both cooldown
checking and recording, matching the production button handler. Successful execution records
only the configured key; blocked calls retain the prior timestamp. Invalid scopes fail closed.

Commands/actions stage fixture changes, script state, tracked globals, messages and cooldowns
on a clone. All are committed together after bounded extraction succeeds. A failed command keeps
its user's input and earlier successful matching commands, while dropping that command's effects.
An interaction failure restores its whole original fixture. The renderer accepts the complete
worker result only for the current generation; timeout, worker error, reset/navigation and stale
results commit no pending effects at all. This atomic model differs from live Discord operations,
which can partially succeed before a later error.

## Agent draft validation

This feature applies to the built-in agent panel. External MCP clients retain their existing
mutation tool catalog and execution semantics; they do not advertise the fixture helper or
validation argument. MCP mutations reject a supplied `validation` field instead of silently
ignoring it or promising tests they do not run.

The agent's command and interaction create/edit tools accept a `validation` suite containing
explicit fake-state fixtures, input steps and expected assertions. `read_validation_fixture`
returns a fresh complete fixture and the assertion-path guide; it never loads saved/live bot
state. The harness prepares one normalized, unsaved mutation, lints that candidate and tests it
before manual approval or auto-save. The assigned creation ID is retained through validation,
approval and commit. Failed or missing-fixture tests do not save a supported draft. The agent can
inspect the returned report and repair the proposal, with at most three failed validations for a
resource in one run. Existing final resource revision checks still reject concurrent edits.
Planning mode remains read-only. Event commands and genuinely unsupported features remain
editable with a conspicuous unsupported/not-validated report and explicit user approval, including
when the session is in auto mode. Session mode is unchanged. Wrong-kind fixtures, unmatched
inputs, malformed requests, timeouts and failed assertions for supported scenarios cannot use
this exception. Unknown/typo BCFD names are execution failures; only recognized production
features outside the simulator allowlist qualify as unsupported. Any supplied event-command
fixtures must pass the same deep validation and step-kind checks before approval is offered.
Only message-received, slash and button dispatch are simulated.

A suite supports at most six independent cases, twelve total steps and sixty-four total
assertions (eight per step). Each case starts from its own complete deeply validated fake state;
steps within that case share only local messages, members, roles, variables, botState and
cooldowns. `advanceClockMs` advances the fake clock without sleeping. Inputs reject malformed or
spoofed member/role/message references, unsafe JSON objects, accessors, cycles, sparse arrays,
unknown fields, unsupported permission values and excessive work/depth/text. Fixtures never
implicitly import other commands, interactions, startup scripts, saved state or credentials.

Each step includes a JSON Pointer `/outcome` assertion and an explicit behavior assertion, such
as `/effects/messages/0/content`, `/state/botState/count` (with an effect assertion), or a specific
error. Raw execution outcomes are `executed`, `blocked`, `error`, `unmatched`, `unsupported` and
`not_run`. Expected-negative tests prove the intended denial/error and absence of unwanted
outputs; an empty errors array, a wrong trigger or an unsupported expression cannot count as a
successful execution. A suite needs at least one real candidate execution and satisfied behavior
assertions for an overall `passed` result. Otherwise the compact report says `failed`, `blocked`,
`unmatched`, `unsupported` or `not_run`. Timeout, cancellation and oversized report details do
not produce a passing report.

Assertion paths use RFC 6901 string pointers under the supported report roots. Empty tokens
and `~0`/`~1` escapes are supported; invalid escapes are rejected with a bounded linear scan.

Validation snapshots the configured interpreter mode from application settings. `$eval` uses
the same wrapped-return or legacy global-scope behavior as production. Reports carry that mode
alongside the exact candidate SHA-256, existing base revision (or null for a creation) and
fixture SHA-256. The harness checks that binding again before approval/commit; any changed
candidate, fixture or selected interpreter mode invalidates the evidence. Reports include expected/actual values, explicit
matched/executed resource coverage, local effects/state differences, traces/errors and simulation
limitations, bounded below the agent tool-result limit. Diagnostic fields and the complete
result envelope are bounded too; oversized results stay valid JSON and retain outcome, save/
denial and repair-budget fields rather than cutting JSON mid-value. The agent panel shows the report beside
the proposed change and retains the existing approval/rejection controls.

Agent suites run in their own disposable Node worker thread, independently bundled with the
same Playground engine, production parser and locally inlined QuickJS WASM. The privileged main
thread only validates input data and coordinates the worker; it does not evaluate user source.
The worker has an empty environment and execArgv, bounded V8 heap/stack, disabled host network
APIs, per-script/per-step limits and a maximum twenty-second outer lifetime. Completion, worker
error, exit, timeout and agent cancellation terminate it; safe closing error handlers remain until termination settles; request tokens and candidate bindings
reject stale replies. The independent worker asset is unpacked beside the main bundle for
packaged Electron applications. Build/watch hooks also produce it for development. It has no
Electron, filesystem, bot, interaction-registry, provider, webhook or persistence service imports.

Neither suite execution nor report inspection saves resources, writes live botState, restarts
startup JavaScript, registers slash commands or contacts Discord/AI/webhooks. It does not touch
the user's separate Playground tab. Scripts only see fixture data; AI response/error fields are
explicit mocks. The atomic simulator does not prove production partial-effect ordering, Discord
permissions/hierarchy, network delivery, registration or real provider behavior.

Headless tests cover fixture boundaries, exact draft identities, approval/auto/planning behavior,
bounded repairs, stale/cancelled results, expected-negative assertions, matched/executed coverage,
message gates, moderation, DM/ephemeral button visibility, slash/button input, clock/cooldown sequences, script/fake state and
mock AI. Built-entry tests run the production worker/inline WASM without launching Electron or
any UI, exercise runaway-code interruption while a main event-loop heartbeat stays responsive,
and inspect the bundle for privileged/external imports. Verification uses `npm test`,
`npm run typecheck`, `npm run build`, `git diff --check` and headless package-artifact inspection.
