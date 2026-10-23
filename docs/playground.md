# Offline Playground

The Playground is a disposable command testing workspace. It uses the same BCFD parser,
evaluator, keyword registry, event matching and action-order helpers as the live runtime.
The runtime is in `src/shared/runtime`; live services and the synthetic world implement its
capability interfaces. Adding a language keyword no longer requires adding a second playground
allowlist. `read_validation_fixture` exposes the capability manifest derived from that registry.

## Interactive testing

Open Playground, select the saved command/interaction snapshots to include, and choose a fake
sender. Supported events are message, DM, member join, member leave, member ban, reaction,
slash invocation and button click. Reactions target an existing fake transcript message. Member
events do not create incoming chat messages. Buttons resolve against selected snapshots in order.
Snapshots are read-only; executing a command never invokes Discord or saves a resource.

The session controls expose fake identities, roles and permissions, channel/server context,
bot state, a controllable clock, a random seed, startup JavaScript and AI responses. The complete
world JSON editor also exposes normalized users, guilds, memberships, roles with permissions and
positions, channels with overwrites, exact prompt mocks and
injected operation failures. Apply validates and resets the worker. Reset and navigation discard
all session state. Reload explicitly refreshes saved snapshots.

Message reads including `$messageAfterCommand`, `$args` and `$argsCount` use production syntax
and spacing rules. `$chat($messageAfterCommand)` receives the evaluated suffix. Interactive AI
uses the labeled local default unless an exact prompt mock exists; it never calls a provider.
Embeds, URLs, returned AI text and button links remain inert data in the transcript.

The current application setting selects wrapped or global eval mode. A case/session owns a
bounded QuickJS VM, so startup functions, closures and global bindings survive successive steps.
Explicit startup source runs once before the fixture's bot state is loaded. Cases never share
VMs. Date and Math.random use the fake clock and seed. Time advances only through controls or
`advanceClockMs`; tests never sleep to wait for cooldowns. Worker reset discards all globals.

## Disposable validation scenarios

Choose a target under **Validate a disposable scenario**, enter an input and expected reply,
and create a case from the current world. Edit the scenario JSON to add steps, negative cases,
options, button targets, mocks and assertions. Each case starts with its own explicit world;
steps within it share state. These scenarios are temporary and do not save commands or suites.

Version 2 and 3 suites contain `cases` and optional `resources: {commands, interactions}` snapshots.
The candidate replaces a snapshot with the same ID in place; otherwise it is appended. Only
execution of the candidate counts toward candidate coverage. No live bot state or startup source
is loaded implicitly. Startup source belongs in `state.startupSource`.

Every step requires `/outcome` and an effect/error assertion. JSON Pointers address
`{outcome, reason, errors, diagnostics, warnings, incomplete, state, effects}`. For example:

```json
{
  "kind": "message",
  "senderId": "100000000000000001",
  "context": { "guildId": "900000000000000001", "channelId": "900000000000000002" },
  "content": "!chat hello",
  "assertions": [
    { "path": "/outcome", "equals": "executed" },
    { "path": "/effects/messages/0/content", "equals": "Hello from the mock" }
  ]
}
```

For that case, add `{"prompt":"hello","response":"Hello from the mock"}` to
`state.aiMocks`. Strict validation requires an exact mock for every evaluated AI prompt. A
missing mock produces an incomplete run, even if a test expected that error. A mock's `error`
models a provider error response, which production returns as text. `state.failures` injects
adapter exceptions, for example `{"channel.create":"Missing bot permission"}`.

Negative blocked/error cases need a specific nonempty `/reason` or `/errors/N` assertion and
an effects assertion. At least one successful candidate execution is required for an overall
pass. Unmatched, unsupported, timed out, cancelled, truncated or incomplete runs cannot authorize
a save. Reports include assertions, candidate coverage, messages, state/entity differences,
ordered adapter operations and the runtime version.

## Normalized worlds (version 3)

New Playground sessions and `read_validation_fixture` use version 3. Canonical entities live in
`state.world`: `users` hold global identity, `guilds` hold identity and `ownerId`, `memberships`
reference a user by `id` and a guild by `guildId`, and `roles` and `channels` each carry `guildId`.
The same user can belong to several guilds with independent roles, nickname, moderation and voice
state. Each guild includes an explicit `@everyone` role whose ID is its guild ID. The simulated
bot (`900000000000000003`) is an explicit user and needs its own membership/roles in each guild.
Entity IDs must be unique decimal strings within the unsigned 64-bit range (the everyone/guild
identity is the sole shared ID). Membership identity is the pair `(guildId, id)`.

Every v3 suite step supplies `context: {guildId, channelId}`. `senderId` resolves a membership in
that guild. Invalid memberships, foreign channels/roles, message targets in another channel,
parents from another guild and dangling overwrite targets are rejected. Select an event channel
in the UI; use the world JSON editor to add guilds, users, memberships and channels. Top-level
`members`, `roles`, `channels`, guild/channel names and NSFW status are the active projection;
edit canonical `state.world` in JSON. Execution regenerates the projection and commits local
mutations back to the matching guild. Bot state, variables and global/user cooldowns remain
intentionally shared across a case, as in production; server cooldowns use the event guild.

DM steps use `guildId: null` and a type-1 channel with `guildId: ""` and `recipientId`. DMs have
no roles or guild membership. Incoming DM authors must be the recipient; guild-only events
cannot use a DM context. Interactive DM sends can create this channel automatically. Outgoing
private messages create/reuse the recipient's DM channel and carry `guildId: null`.

Supported permissions are `Administrator`, `ViewChannel`, `SendMessages`, `ReadMessageHistory`,
`AddReactions`, `ManageMessages`, `ManageChannels`, `ManageRoles`, `KickMembers`, `BanMembers`
and `MuteMembers`. Put permission names in `role.permissions`. Legacy membership permission
flags remain explicit additive guild grants for compatibility. Channel `overwrites` map a role
or member ID to permission booleans: false denies, true allows, omission inherits. Resolution
combines everyone and member roles, applies the everyone overwrite, combines all role denies
then all role allows, and finally applies the member overwrite. Owners/administrators bypass
overwrites. Hidden channels remove modeled channel permissions. This follows the supported
subset of [Discord's permission rules](https://docs.discord.com/developers/topics/permissions).

The bot's role must outrank a target member/role for moderation or role management; administrator
permission does not bypass hierarchy. Guild owners and the bot itself cannot be moderated;
managed roles, `editable: false` roles, everyone and `manageable: false` members are protected.
Equal role positions are conservatively treated as a hierarchy failure. Deleting one's own
message needs channel access; deleting another author's message needs Manage Messages. Purge,
button and reaction targets are confined to the event channel. Logs include event context and
reports include `/effects/worldChanges` with canonical JSON paths.

Permission gaps remain explicit: thread membership/inherited permissions, voice connection
state prerequisites, timeout-derived restrictions, 2FA, permission grant ceilings when editing
overwrites, Discord error codes and network ordering are not modeled. Reaction permission checks
are conservative even for an already-present reaction. Category overwrites are not implicitly
inherited: supply the effective overwrite fixture on the channel. These are local scenarios and
do not establish deployed Discord access, intents or command registration.

### Existing fixtures and ID migration

Version 2 (including suites with no version) continues to run with its original numeric transcript
IDs, single-guild projections and simplified permission flags. Existing numeric assertions do not
silently change meaning. The UI offers **Upgrade world to string IDs and guild permissions**;
`normalizeWorld` provides the same explicit conversion for code callers. It converts existing
message/reply IDs using exact decimal strings and seeds a normalized guild/bot membership.
Unsafe numeric IDs cannot be migrated. Generated v3 IDs use an integer sequence and BigInt
arithmetic, serialize as strings, and avoid collisions with existing world/message IDs.
`nextId` remains a safe integer allocation counter, not a Discord ID.

To migrate a suite, set `version: 3`, normalize every case state, add `context` to each step and
convert reaction/button `messageId` plus message/reply/deleted-ID assertions to strings. Revisit
assertions for changed ownership, permissions, hierarchy, new IDs and canonical world effects;
upgrading is explicit because these semantics are stronger than v2. Keep snowflakes as strings
through JSON, reports and replay?never pass them through `Number`. `read_validation_fixture`
returns a v3 starting world and context example. The entire canonical world, every context and
assertion are included in fixture evidence; changing any of them invalidates the report. Runtime
version 3 also invalidates evidence generated before these semantics were introduced.

## Agent workflow and save boundary

Both the desktop agent and external MCP clients can call `read_validation_fixture` and
`run_playground`. The latter normalizes and tests an unsaved candidate without writing, and is
available during planning. Supply `kind`, `candidate` and `validation`; the result includes the
normalized candidate and its report. A supplied candidate ID is retained for dependency/button
resolution in this read-only tool.

Creating or editing a command or interaction requires a passing explicit validation suite.
There is no event-command approval bypass. Evidence is bound to the exact normalized candidate,
base revision, full fixture/dependency snapshots, runtime version and interpreter mode. The
commit service retains its own copy of successful evidence and checks it again after mutation
lock admission. A caller-supplied report or callback cannot authorize an untested save. Existing
approval, Auto review, cancellation and saved-resource revision checks remain in effect.

**Open in Playground** on a desktop agent report transfers the exact candidate and fixture
snapshots into a disposable replay. Editing the candidate selection, suite or eval mode clears
the displayed result. Rerunning recomputes evidence; displayed evidence itself grants no write
permission.

## Effects, failures and deliberate behavior corrections

Traditional message actions preserve the live awaited versus detached ordering. Member events
use role (join only), channel embed, channel text, DM embed and DM text order. Reactions use
channel text, DM text, channel embed, DM embed and role order. Slash/button response effects use
the shared sequential response, DM, DM embed and role dispatcher. A failed later operation does
not erase earlier simulated Discord effects. Traditional detached task failures are collected
without preventing later scheduled actions. Interaction DM delivery failures are warnings and
continue to DM embeds and role assignment; rendering/transaction failures and response/role
failures still stop that interaction. The shared delivery helper wraps only the actual DM send.

Each template is a bot-state transaction. Interpreter diagnostics return the live rendered output
(including inline error text or the original unknown keyword), roll back that template's bot state,
and allow later templates/actions to continue. A thrown adapter/transaction error is a command
failure. Successful earlier templates stay committed, even when their subsequent delivery fails.
The same checkpoint implementation restores the original bot-state object graph in both VMs,
including nested objects and arrays referenced by aliases. Non-state global bindings and `$set`
variables survive diagnostics; they are not part of the bot-state transaction. Wrapped eval keeps
local declarations private, while global eval declarations survive later templates and steps.
Session snapshots do not replace unchanged VM objects or global bindings between steps.

Reports separate `errors` (command failures), `diagnostics` (inline interpreter diagnostics),
`warnings` (nonfatal interaction delivery failures), and `incomplete` (simulation limitations).
A diagnostic-bearing execution remains `executed`, but validation requires an explicit passing
`/diagnostics` assertion as well as the ordinary outcome/effect assertions. Unexpected diagnostics
fail validation. Missing mocks, absent script capability, resource limits, failed alias rollback,
unserializable variable evidence and incomplete runs cannot become passing expected-error tests.
Changing these semantics increments the runtime version so earlier reports cannot authorize saves.

### Offline failure parity matrix

`src/shared/playground/failureParity.test.ts` compares the production interpreter/QuickJS context
and shared dispatch against the synthetic engine. Each row checks rendered output, ordered
operations, bot state, errors and diagnostics; delivery failures also check warnings and continuation.
No Discord or provider access is needed.

| Event                 | Failed eval after successful template              | Failed DM after successful response                  | Continuation                    |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------- | ------------------------------- |
| Message               | Inline diagnostic; only failed template rolls back | Earlier send/state retained; detached error recorded | Later detached actions continue |
| DM command            | Same                                               | Same                                                 | Same                            |
| Member join/leave/ban | Same in member action order                        | Same                                                 | Same                            |
| Reaction              | Same in reaction action order                      | Same                                                 | Same                            |
| Slash                 | Same                                               | Delivery warning; response/state retained            | DM embed and role still run     |
| Button                | Same; no inherited slash options                   | Same                                                 | Same                            |

Additional regressions compare wrapped/global eval across steps, nested object/array aliases,
replacement of `botState`, surviving globals, irreversible rollback, missing mocks and resource
limits. Live service coverage verifies rejected detached DM promises are observed while later
channel effects finish.
Worker timeout/crash/reset discards the pending result at the UI boundary.

This change also corrects live DM matching to select DM commands, evaluates member-event
response templates instead of sending them literally, supplies reaction user/member context,
and awaits async bare keywords. These corrections share the same evaluator and dispatch helpers
in production and simulation.

This is an offline behavioral test, not a guarantee of Discord delivery. Network concurrency,
latency, gateway event cascades and intent/registration availability are
not fully reproduced. Permission fixtures and injected failures exercise local failure paths;
they cannot prove a live bot has access. The synthetic dispatcher waits for detached tasks to
settle before reporting; live delivery completion order depends on the network. Injected adapter
failures describe fixture behavior, not Discord's full error catalogue. Playground uses stricter
JSON/output/work limits and a shorter cumulative script deadline. It rejects Proxy construction,
and reads error descriptors without invoking guest accessors. Non-JSON tracked variable snapshots
and irreversible alias rollback produce incomplete evidence and require reset; live rollback can
attempt visible-state recovery and logs the need to restart. Ordinary thrown eval errors preserve
the session. The captured native InternalError family is conservatively incomplete, including
explicitly constructed instances; changing its display name does not change that classification. Global objects outside `botState` are retained in the VM but are not a complete JSON
snapshot of all JavaScript bindings.
Version 3 uses decimal string IDs for all Discord entities, including transcript messages.
A world can contain multiple guilds; each event selects one guild/channel and membership. Clock control
covers elapsed time and Date.now; host timezone-dependent formatting is not configurable.

## Isolation and bounds

User JavaScript runs only inside bundled QuickJS WASM, never host eval. It has no network,
filesystem, IPC, credentials, Discord client or provider handles. The renderer worker contains
no privileged runtime imports; the Node validation worker imports only worker_threads from Node.
Workers receive explicit snapshots, empty environment variables and no inherited exec arguments.

QuickJS has memory, stack and execution deadlines. JSON fixtures, AST work, template expansion,
transcripts, operations and reports are bounded. Suites allow six cases, twelve total steps and
sixty-four total assertions; strict worker lifetime is capped at twenty seconds. Interactive
workers survive successful requests to preserve globals, and terminate on cancellation, reset,
navigation, failure, execution timeout or idle expiry. Tests cover stale-result rejection,
packaged inline WASM, host isolation, cancellation, partial effects and exact evidence binding.

Verification commands: `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`.
