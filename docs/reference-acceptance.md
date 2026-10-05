# Offline reference acceptance

The following ordinary functional examples connect the draft-validation features into complete
reference sequences. They run headlessly in temporary cloud filesystem fixtures, with no live
Discord or AI provider requests.

Run the reference tests:

```sh
npm test -- src/shared/playground/referenceAcceptance.test.ts src/main/services/agentReferenceWorkflow.test.ts
```

## Covered sequences

- **Welcome response:** render the documented welcome template as a message-received command.
  Assert the exact server name, invoking member mention, member count, punctuation and newline.
  The tutorial's original Member Join / `GuildMemberAdd` dispatch remains unsupported by the
  offline runner; this test covers its response template only.
- **Counter with cooldown:** execute the documented counter template with a two-second user
  cooldown. The first invocation increments to one and records the fake timestamp. An invocation
  one second later is blocked, emits the expected cooldown reply and changes neither the counter
  nor its timestamp. Advancing the fake clock to exact expiry permits a second increment and
  records a new timestamp. No real sleeping is used.
- **Ephemeral role button:** a slash invocation sends a role button to an explicit recipient.
  A different member's click is blocked with no message or member changes. The recipient's click
  assigns the configured fake role only to that member and returns the expected response. Discord
  `ManageRoles`, role hierarchy and remote interaction delivery are not simulated.
- **Create, validate, approve, save, reload:** the production agent prepares a new command with
  a generated identity, and the built disposable validation worker verifies its exact response
  for two explicit members. The candidate and validation report are visible before manual
  approval, while the command store and saved file remain unchanged. Approval uses production
  mutation commit, file service and atomic persistence. Freshly imported production modules
  reload the identical command and retained validation report from the temporary directory.

The workflow test substitutes only the Electron shell, a deterministic in-process provider HTTP
transport and the source-test worker entry location. It does not mock successful validation,
command preparation, mutation commit, filesystem writes or reload results. It does not launch the
desktop UI or contact a provider.

These are bounded example-based functional checks. They do not establish live Discord parity,
exercise event dispatch, validate provider behavior or certify the sandbox's security. See
[Playground limitations](playground.md) for the simulator's broader scope.
