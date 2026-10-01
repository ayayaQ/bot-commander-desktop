# Offline Playground

The bottom-toolbar Playground tab reads saved commands through `get-commands` and runs
message-received commands in a disposable renderer Web Worker. It never invokes bot execution,
persistence, settings, credentials, AI providers or Discord/network services. User templates are
parsed as data with the production parser, then interpreted by a small allowlist. JavaScript is
never evaluated. A worker is terminated on completion, failure, reset, navigation or its 1.5-second
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

Scripts (`$eval`), AI, state reads/writes, cooldowns, reactions, specific-message targeting,
unknown channels and unlisted BCFD expressions fail closed. Every branch of an evaluated template
is inspected, including inactive conditional branches. A failed command leaves no command outputs
or fake mutations; the user's input remains, and other matching commands may run. Scripts, AI,
state writes and cooldown simulation are explicitly on hold for a later feature.

## Verification

Headless unit tests cover matching, filters, invoker/target distinctions, moderation permissions,
DM/reply/embed data, input immutability, failure rollback, hidden unsupported branches and
resource bounds. Session tests cover disposable-worker termination, deadline, reset/navigation
cancellation and stale completion rejection. Source-graph security tests forbid live services,
network/dynamic evaluation and renderer embed-loading elements. `npm test`, `npm run typecheck`,
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
