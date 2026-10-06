# Desktop Agent Skills inspection review brief

## Scope and status

This draft is for independent inspection only. Do not merge it as completed skills
support. It adopts exact registry `@ayayaq/vivi@0.6.0`, standard SKILL.md discovery,
progressive instruction/resource reads and the original bundled creator. Agent saves
are disabled on **all platforms** in production. The creator can draft ordinary content
for manual saving. Full security review, a rooted native save adapter, platform acceptance
and the Windows-primary product decision remain open.

The known boundary is that the quarantined prototype uses pathname-based filesystem
mutation operands. Asynchronous checks followed by a pathname rename do not pin those
operands to an owned directory. Backups have the same limitation. Post-commit identity
checks cannot establish that an earlier outside-store write did not happen. The current
production gate rejects before path resolution/directory/lease creation and omits the tool.
This draft makes no accepted save-workflow or complete security claim.

## Suggested independent-review prompt

Review this exact draft commit as a defensive code inspection. Identify concrete defects,
severity, affected files/lines, consequences, and minimal supported remediation. Distinguish
implemented behavior, ordinary fixture evidence, unverified platform behavior and design
recommendations. Avoid interpreting passing tests as complete security acceptance.

Check these properties:

1. Production save quarantine cannot be enabled by model arguments, skills, renderer IPC,
   settings or environment variables, and remains present in the bundled application
2. Standard skill content is untrusted lower-priority data. Discovery and loaded resources
   cannot create tools, change policy, pre-approve actions or execute code. Prefixes are
   per-turn and not persisted as user requests; previous skill reads do not become authority
3. Discovery is bounded and explicit: one owned store plus user-selected read-only roots,
   no workspace/home/ancestor scan. Duplicate/invalid/unsupported sources are diagnosed
   without silently rewriting or shadowing the bundled creator
4. Text reads enforce strict UTF-8, byte limits, relative-path restrictions, identified roots,
   source revisions and root-removal policy. Review the documented credential/state-component,
   hardlink and state-profile-overlap restrictions, and their compatibility tradeoffs
5. The quarantined approval/CAS prototype binds exact source, revision, destination and
   create/replace decision. Auto mode does not implicitly approve it; Planning remains
   read-only. Cancellation, committed receipts, recovery and durability notices are represented
   honestly even though production writes are unavailable
6. IPC/preload expose only the intended listing/explicit-selection/removal operations. No
   general filesystem writer, MCP skill endpoint or runtime script capability was added
7. A proposed future filesystem adapter must provide a supported rooted transaction,
   lifetime-bound operands, after-review CAS, bounded file creation/backup/replace, precommit
   cancellation and postcommit receipts on each accepted platform. Separate adapter design
   from this draft's unaccepted pathname prototype; require packaging and platform acceptance

Keep this review at the code/property level. This brief contains no exploit payload,
restricted assessment procedure, or request to repeat a denied validation. Further validation
needs its own authorized scope and supported environment.

## Exact code surfaces

- `src/main/services/agentSkillSaveSupport.ts`: production gate; deliberately unavailable
- `src/main/services/agentSkillStore.ts`: catalog, root bindings, text reads and quarantined writer
- `src/main/services/agentSkillService.ts`: app-wide paths, explicitly selected roots, provider-key screening
- `src/main/services/agentExtensions.ts`: exact core extension registry
- `src/main/services/agentService.ts`: per-turn context, routing, approval and receipts
- `src/main/services/atomicPersistence.ts`: existing pathname writer plus pre-rename callback
- `src/main/handlers/ipcHandlers.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`: trusted IPC surface
- `src/shared/agentSkillTypes.ts`: renderer/status/receipt contracts
- `src/renderer/src/components/AgentSkillsPanel.svelte`, `AgentPanel.svelte`: folder/diagnostics UI and exact destination review
- `package.json`, `package-lock.json`: exact 0.6.0 registry pin and required yaml@2.9.1 only
- `docs/AGENT_SKILLS.md`: current behavior, limits, compatibility and unfinished scope

Ordinary focused tests: `agentSkillStore.test.ts`, `agentSkillsWorkflow.integration.test.ts`,
`agentSkillSaveSupport.test.ts`, `ipcHandlers.test.ts`, `agentExtensions.test.ts`.
The first two mock a temporary-folder fixture write capability. That substitution is confined
to test files; it is not production-save acceptance. The support suite uses the real disabled
gate and checks tool omission/rejection in Manual, Auto and Planning modes. Existing regression
scope preserves previously retained ordinary tests; excluded assessments were not rerun.

## Supported adapter references

Windows documentation supplies directory handles and directory-relative rename information;
Node's ordinary filesystem surface does not expose a complete rooted transaction. These are
possible trusted native-adapter primitives, not an implemented or validated solution:

- [Obtaining directory handles](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory)
- [FILE_RENAME_INFO RootDirectory](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
- [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)
- [libuv Windows filesystem source](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c)

A future macOS/Linux implementation needs corresponding descriptor-relative operations
or another independently accepted supported adapter. No dependency or native implementation
is added in this draft.
