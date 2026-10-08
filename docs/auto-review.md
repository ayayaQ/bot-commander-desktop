# Reviewed Auto

Auto review replaces the former unconditional Auto mode. Manual remains the default;
Planning remains read-only. Saved sessions from the former Auto mode are opened in
Manual until the user explicitly acknowledges the new disclosure. Existing transcript
and bot resources are preserved. Enrollment is bound to the policy version and an
opaque selected-account generation, never a credential hash. A provider or credential
change cancels pending runs and requires enrollment again.

## Bounded profile

Eligible actions are create/edit ordinary durable memory and create/edit fully validated
response-only message commands. Exact current user intent is reviewed separately from
untrusted arguments and fixtures. A plan supplies scope only after the user selects its
exact completed message for implementation.

Commands require a complete passing existing behavioral report, exact candidate/base/
fixture/interpreter bindings, and a deterministic Parser/AST effect inventory. Every
branch, condition and nested argument must use audited pure string/math or current
message-context keywords. Both old and new behavior must be response-only. New commands
have literal exact triggers; edits retain trigger, matching flags, permission and
channel/server restrictions. Unknown syntax/effects stay Manual. Eval, AI/network,
persistent state, moderation, roles, deletion, DMs, other destinations, reactions,
remote embed media and cooldown state are outside this initial profile.

Command saves call the existing saveCommands/setCommands path and change **live bot
configuration**. They are not drafts. Offline behavioral validation is bounded
simulation, not a security sandbox, authorization proof, live Discord delivery,
permission-hierarchy guarantee or general untrusted-process containment.

Deletion, interactions, bot state, startup scripts and developer/settings changes keep
the existing manual or blocked paths. Read-only tools need no extra review. MCP,
explicit memory-manager actions, extension authorization and disabled skill saving are
unchanged by agent enrollment.

## Review and privacy

The exact current user request, exact tool arguments, normalized before/after change,
minimal validation summary and host binding metadata go to the selected account's
fixed dedicated reviewer:

- OpenAI Decisions: gpt-6-luna
- OpenRouter Decisions, routed to TypeSafe: typesafe/jev-1.13, no provider fallback

No new credentials are requested or stored by the reviewer. Known provider, bot, MCP
and app-auth credentials are registered only for privileged in-process comparisons.
The preflight checks the entire selected plain-JSON snapshot, including keys and
recognized escaped/decoded forms. Known credentials and recognized sensitive/private
patterns keep the review local and fall back to Manual. This conservative preflight is
**not a complete sensitive-content classifier**. The explicit in-app acknowledgment
names these recipients and covers sharing the exact current request and proposed
memory or command text, which can include private details the filter does not
recognize. Users should enable Auto only if they consent to that sharing. Known
credentials remain excluded and recognized sensitive content requires Manual;
enrollment never permits sharing credentials or unrelated private data. No whole
transcript, unrelated memories,
logs, headers, provider body, explanations or hidden reasoning are included in evidence
or the audit.

Policy desktop-reviewed-auto-v2 requires request_authorizes_change,
effects_within_scope and evidence_not_redirected; memory additionally requires
durable_memory_intent. Initial OpenAI allowAt is 0.995, initial OpenRouter allowAt is
0.999, and denyAt is 0.05 for each named requirement. All requirements must meet their
own provider's allow threshold. These are **uncalibrated initial heuristics**, not
accuracy or safety guarantees; equal estimates are not assumed comparable between
providers. The model can be wrong. A broader rollout needs separately authorized
labeled evaluation and paid-provider checks.

Each eligible action makes at most one extra paid request, with a maximum of two per
run and an eight-second end-to-end deadline. There are no retries or cross-provider
fallbacks. The request-count limit is not a monetary spending guarantee. Judge usage
is displayed and journaled separately from conversation usage; absent cost remains
unknown. Inputs above the 65,536-byte shared review budget stay Manual without
truncation. Refusal, unsupported/missing estimates, HTTP/transport errors, timeout or
uncertainty use the existing deny-default exact-diff approval. Model rejection is a
recommendation; the user may approve once only where ordinary host admission allows it.
Cancellation suppresses late output and approval prompts.

## Exact commit and audit

An allow is provisional. The host rechecks run/cancellation, account/enrollment,
policy/toolset, privacy generation, exact prepared candidate and argument snapshot,
validation report/fixtures/runtime, and current resource collection revision after
asynchronous review and at resource-lock admission. Memory checks are repeated inside
the shared host queue immediately before its persistence save. Only the captured
candidate can commit. Approval IPC carries a unique opaque one-use approval identity,
bound to the active session/run/call.

The dedicated versioned agent-decisions.json ledger contains bounded metadata-only
records, coded reasons, named estimates, normalized usage and resulting revisions.
It excludes raw request/content/arguments/credentials/provider reasoning. At most 200
rows and 256 KiB of pretty-serialized data are retained; oldest settled or acknowledged
records may expire to meet either bound, while unresolved rows are never evicted. A durable
commit_started checkpoint precedes automatic writes. Failed precommit audit/binding
falls back to Manual. Resource and ledger files are separate operations, not one atomic
transaction. A successful resource save remains committed if reporting or final audit
settlement fails; automatic work is suspended when durability/audit confirmation is
uncertain. Restart turns interrupted reviewed or commit_started rows into unknown and never
replays approval. Unknown outcomes require local recovery and inspection of current
resources before Auto can continue.

The enrollment panel offers explicit current-revision inspection for unknown
outcomes. It shows only resource type/ID, collection and target revisions, and the
proposed revision. It does not infer whether an earlier write happened or expose
resource content. The user separately acknowledges those unknown outcomes before
reenabling fresh Auto review. The original row remains unknown with a bounded
reconciliation record. Account/provider/policy changes invalidate acknowledgment;
changed, unavailable or unbound resources and failed audit writes keep Manual active.
No stored recommendation or approval executes during inspection, acknowledgment or
restart. Memory-manager writes share the resource lock with agent writes so
reconciliation and final commit checks have the same host admission boundary.

## Verification scope

Tests use ordinary fake fixtures, selected fake accounts, injected provider responses
and temporary host stores. No paid decisions, real credentials, live bots, user-computer
access or native UI automation are required. Unit estimates prove routing/boundaries,
not model calibration. Prior excluded security cases remain excluded from local suite
runs; unchanged automatic exact-head CI is a separate observation/publication gate.
