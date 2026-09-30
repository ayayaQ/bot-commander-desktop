# Offline command playground

Open the **Playground** bottom-toolbar tab. This is a fake guild/channel, not a
Discord connection. Pick a saved command (or all commands), choose a fake sender,
and type a message. Click a member to insert their mention. Reset restores Alex,
Sam, Riley, the channel fixture and empty botState, and clears the conversation.
Use fixture controls to test role IDs, administrator status, whitelists and NSFW
filters. Saved command changes are loaded only through the read-only reload action.

The channel shows evaluated text/replies, private-message destinations, and embed
text. Image and thumbnail URLs are shown as text and are never fetched. Expand a
run's trace for trigger/filter checks, condition decisions, simulated actions and
before/after fixture botState.

## Supported subset

- Message-received (`type: 0`) exact, starts-with, phrase, wildcard and two-word
  moderation triggers, including the production runtime's case/spacing behavior
- Channel/server whitelist, required-role, administrator and NSFW filters
- Text, channel/DM replies and embeds, reactions in the action log
- Local kick/ban/mute and sender role toggle effects; all members are fictional
- BCFD text, escaped characters, nested supported functions and `$if` / `$elseif` /
  `$else` conditions with the production parser and condition semantics
- Keywords: `name`, `namePlain`, `ID`, `id`, `isBot`, `memberID`,
  `memberEffectiveName`, `message`, `messageAfterCommand`, `argsCount`, `args`,
  `wordCount`, `channel`, `channelID`, `channelAsMention`, `channelIsNSFW`,
  `serverID`, `mentionedName`, `mentionedID`, `mentionedNamePlain`, `upper`,
  `lower`, `length`, `contains`

This is not a complete Discord emulator. Moderation uses the fake administrator
flag as its permission model; individual Discord permission bits, role hierarchy,
voice connection requirements, embed validation and API errors are not modeled.
Missing required roles appear in the filter trace rather than generating Discord's
runtime error reply. Typing timing is only logged. Non-message event commands are
filtered out. Results do not certify that a real bot has the intents or permissions
needed to perform an action.

`$eval`, arbitrary JavaScript, all other BCFD keywords (including AI, network and
state access), cooldown timing, message deletion and specific-channel routing are
unsupported. A matched command with any unsupported construct is blocked before
its outputs or effects. Even an unsupported expression in an unselected condition
branch is rejected. Other matching supported commands may still run.

botState is an independent JSON fixture, never loaded from or saved to the live
bot. This version does not evaluate state reads/writes, so its before/after diff
is intentionally unchanged. Fake member roles/status can change between messages.

## Isolation boundary

The UI's only service request is `get-commands`. Each run sends cloned command and
fixture data to a new renderer Web Worker. The worker imports the pure BCFD parser
directly, not its barrel or the live interpreter. The allowlisted evaluator has
no injected live objects, callbacks, dynamic evaluation, imports, filesystem,
Electron IPC, Discord client, AI service or network calls. Worker isolation alone
is not a network sandbox: rejecting executable user code and unknown keywords is
an essential part of this boundary. Do not replace it with the live interpreter.

The worker is terminated after completion, error or two seconds. Inputs are
limited to 256 KB, 100 commands and 4,000 message characters; templates to 16,000
characters, 64 evaluation levels, 20,000 visits and 64,000 output characters. UI
reset uses a generation guard so late results cannot restore discarded fixtures.

## Verification

Run `npm test`, `npm run typecheck`, and `npm run build`. Focused tests cover
matching edge cases, production template parity, hidden unsupported branches,
immutable inputs, moderation/role simulation, independent state fixtures and
worker timeout/disposal. Isolation tests guard against live-service dependencies.

Manual smoke test: save a message command with `Hello $namePlain`, open Playground,
send as Alex and then Sam, and inspect their different replies. Test a moderation
command mentioning Riley, verify the member status changes locally, then Reset.
Repeat with a required role missing and an unsupported `$chat` or `$eval` in an
unselected branch; no command effects should appear. Verify reset during a run,
empty commands, command reload failure and tab navigation while a run is pending.

### Isolated desktop QA seed

`playground-qa-commands.json` is a test-only saved-command seed. With the app
stopped, copy it to `commands.json` inside a **new, disposable userData directory**
selected for QA. Never overwrite a real user's existing data directory. No token,
login, live bot or Discord connection is required. Test the empty state before
seeding if desired, then restart against that same disposable directory.

On macOS, a fresh userData directory alone does **not** isolate the application's
OS keychain identity. For disposable, no-credential QA with an Electron version
that supports it (verified with Electron 42.8.1), launch with
`--use-mock-keychain` as well as the isolated profile. Never use this test switch
with a real profile or real credentials. Stop immediately if a real keychain
access prompt appears; do not grant access. This is a QA-only launch option, not
a production startup change.

Default fake fixtures:

- Alex `300000000000000001`: administrator, role `moderator`
- Sam `300000000000000002`: non-administrator, role `member`
- Riley `300000000000000003`: non-administrator, no roles
- Server `100000000000000001`, channel `200000000000000001`, name `playground`

Expected runs:

1. `!hello` as Alex → reply `Hello Alex in #playground`; as Sam → `Hello Sam…`
2. `!role <@300000000000000003>` as Alex → mention Riley, toggle `tester` on
   Alex (not Riley); repeat removes the role
3. `!kick <@300000000000000003>` as Alex → Riley becomes kicked; Reset restores
   active. Repeat with `!ban` → banned and `!mute` → voice-muted
4. A moderation command as Sam → no member mutation; trace explains permission
5. `!blocked` → unsupported, no output or role/state effects despite false branch
6. `!staff` as Alex → `Staff hello`; as Sam → required-role filter fails
7. `!embed` → rendered text embed and separate DM, image URL is inert text
8. Reset during a run → empty chat/restored fixtures; no late result reappears
