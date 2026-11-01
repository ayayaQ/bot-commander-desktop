# Offline reference acceptance

The following ordinary functional examples connect the draft-validation features into complete
reference sequences. They run headlessly in temporary filesystem fixtures, with no live
Discord or AI provider requests.

Run the reviewed ordinary Playground selection and its runner checks:

```sh
npm run test:playground
# Inspect the exact file and test names without executing tests:
node scripts/test-playground.mjs --list
```

## Covered sequences

- **Welcome response:** dispatch the documented type-2 Member Join command with a synthetic
  `memberJoin` event and empty message content. Assert the exact server name, joining member
  mention, member count, punctuation and newline. The member already exists in the explicit
  fixture; this checks offline dispatch and rendering, not a live `GuildMemberAdd` delivery.
- **Counter with cooldown:** execute the documented counter template with a two-second user
  cooldown. The first invocation increments to one and records the fake timestamp. An invocation
  one second later is blocked, emits the expected cooldown reply and changes neither the counter
  nor its timestamp. Advancing the fake clock to exact expiry permits a second increment and
  records a new timestamp. No real sleeping is used.
- **Ephemeral role button:** a slash invocation sends a role button to an explicit recipient.
  A different member's click is blocked with no message or member changes. The recipient's click
  assigns the configured fake role only to that member and returns the expected response.
  Additional normalized-world cases give the fake bot explicit `ManageRoles` and a role at
  position 100: assigning the role at 99 succeeds; missing `ManageRoles`, roles at 100/101, and
  members with highest roles at 100/101 fail without changing memberships. `Administrator`
  does not bypass hierarchy. The recipient needs no management permission. A denied role
  assignment retains the earlier ephemeral response, matching production action order; response
  text alone is not evidence of assignment. Remote interaction delivery is not simulated.
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
validate live event delivery or provider behavior or certify the sandbox's security. See
[Playground limitations](playground.md) for the simulator's broader scope.

## Ordinary CI selection and omissions

`scripts/test-playground.mjs` positively selects both files and exact expanded test names. It
rejects CLI overrides, runs from the repository root, and requires Vitest's JSON results to match
every selected name with a passed assertion result. Missing, renamed, skipped, duplicate or
unexpected executed tests fail the runner even if Vitest exits zero. Failures propagate to CI;
the step summary reports each selected file and its passed/selected count. The runner checks
use Node's built-in test runner and fake child results, including failed/missing reports.

The eight selected files cover ordinary message matching/gates/moderation, persistent execution
state, eval interpolation, mock AI, fake-clock cooldowns, slash/button flows, shared runtime
keywords/events, multi-guild permissions/hierarchy/role creation, causal event sequences, and the
reference flows above. Every selected test body was inspected before selection. The runner's
`--list` output is the authoritative expanded list; adding a file or test requires explicit review.
No assertion in an existing engine, world, runtime or agent workflow suite is changed.

The following test names are omitted within selected files (parameterized names retain their
source placeholders). These conservative omissions keep nonordinary, boundary/security or legacy
assessments outside this ordinary command; they do not claim that every omitted test is a
historically restricted assessment.

| File under `src/shared/playground/` | Omitted source test names                                                                                                                                                                                                                                                                                                                | Reason                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `engine.test.ts`                    | `preserves earlier effects while evaluating the production behavior of %s` (all parameters); `bounds inputs, command count, transcript size, templates and amplified outputs`                                                                                                                                                            | Includes infinite-loop text and resource/amplification bounds; outside ordinary selection. |
| `execution.test.ts`                 | `rolls back an attempt to replace the required botState object with a scalar`; `safely converts script results after an explicit variable shadows the String global`; `preserves an explicit variable whose name resembles an interpolation binding`; `keeps runtime conversion and snapshot helpers out of the script global namespace` | State corruption, shadowing and sandbox/internal binding assessments.                      |
| `interactions.test.ts`              | `handles legitimate prototype-like option names as inert own values`; `honors action flags and does not evaluate inactive stale payloads`; `keeps option text inert rather than reparsing it as template code`                                                                                                                           | Prototype-like inputs and infinite-loop payload fixtures; outside ordinary selection.      |
| `world.test.ts`                     | `retains v2 numeric IDs and offers an explicit string migration without rounding`; `rejects invalid %s references` (all parameters); `rejects a non-boolean role %s flag` (all parameters)                                                                                                                                               | Legacy migration and malformed fixture assessments.                                        |
| `cascades.test.ts`                  | `rejects invalid fixture cascade limits %j` (all parameters); `fails closed on event/work budget exhaustion even if assertions expect the partial effects`; `terminates a host-driven causal loop with %j` (all parameters)                                                                                                              | Invalid limits, exhaustion and host-driven loops.                                          |

`runtimeV2.test.ts`, `referenceAcceptance.test.ts` and
`src/main/services/agentReferenceWorkflow.test.ts` have no omitted tests in this selection.

These other Playground test files are entirely omitted from the new runner:

| Files under `src/shared/playground/`                                                                          | Reason                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentValidation.test.ts`, `agentValidationPointers.test.ts`, `commandSnapshots.test.ts`, `isolation.test.ts` | Mixed candidate/fixture boundaries, pointer, snapshot and isolation assessments; not enrolled in this ordinary selection.                                                 |
| `script.test.ts`, `failureParity.test.ts`                                                                     | Mixed sandbox, tampering, resource exhaustion and failure assessments; not rerouted.                                                                                      |
| `productionParity.test.ts`                                                                                    | Separate production evaluator parity fixtures; not enrolled.                                                                                                              |
| `scheduler.test.ts`, `scheduling.test.ts`                                                                     | Separate virtual scheduler/timing/budget fixtures; causal timing is covered here by selected cascades.                                                                    |
| `botStateDraft.test.ts`, `messageDeletion.test.ts`, `offlineWorker.test.ts`                                   | Separate draft, deletion-boundary and bundled-worker fixtures; not enrolled.                                                                                              |
| `scriptErrorClassification.test.ts`                                                                           | Remains in the existing explicit CI error-classification step, together with `src/renderer/src/utils/playgroundWorkerFeedback.test.ts`; not duplicated in the new runner. |

All tests outside the eight selected files remain outside this runner. Existing CI steps,
`scripts/test-agent-mcp.mjs`, both Windows jobs and the Windows ordinary skill-name selector stay
unchanged. Historical adversarial/legacy-input/skills assessments remain excluded and must not be
recreated or rerouted. Never replace this command with blanket `npm test` or a test glob.

Rendered Playground and native package checks belong to separate A6/A7 handoffs. This ordinary
step does not register placeholder jobs or claim those checks have run.
