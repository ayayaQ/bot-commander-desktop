# App-wide Agent Skills

## Inspection-draft status

This is an incomplete inspection candidate, not merge-ready feature acceptance. Agent
skill saving is fail-closed on **all platforms**, including Windows, macOS and Linux.
`save_skill` is not advertised. The ordinary pathname writer cannot pin its filesystem
mutation operands; check-then-rename is insufficient. A trusted handle-bound filesystem
adapter plus independent platform validation and product scope decision is still needed.
No runtime flag, environment variable, setting or skill can enable this draft's writer.

Discovery, complete text reads and the bundled creator remain available. The creator can
draft a standard SKILL.md for the user to save manually. The approval, CAS, cancellation
and atomic-backup prototype below is exercised only with a test-only temporary-folder
fixture capability. Those tests do not accept production save workflows or resolve the
known write boundary. Full independent security review remains incomplete. No restricted
adversarial validation is part of this candidate's verification.

The desktop uses the same optional `@ayayaq/vivi/extensions/skills` 0.6.0 parser,
metadata catalog, resource paths and original bundled creator as vivi-cli. Skills are
ordinary `<name>/SKILL.md` directories with standard YAML `name` and `description`,
not a desktop-specific manifest. Existing files are read unchanged. Quoted/folded YAML,
standard optional fields and unknown extension fields are preserved in exact source.
Unknown fields produce visible diagnostics. Unsupported host-specific invocation
fields exclude that source rather than pretending their behavior is implemented.

The Agent panel's **Skills** control shows the app-owned folder
`<Electron userData>/agent-skills`, available skills and diagnostics. Place standard
skill folders there manually, or use **Add folder** to select an existing read-only
collection (or a single skill folder). Folder selection is explicit and persisted;
**Remove folder** stops future reads without deleting any files. There is no automatic
current-directory, project, ancestor or home-directory discovery. Desktop and CLI keep
separate stores; either may read the same deliberately selected external collection.
**Refresh** updates the displayed catalog. Active agent turns keep their original
immutable catalog; folder and file changes appear on a future turn.

`list_skills` discovers metadata, and `read_skill` loads a relevant document or bounded
UTF-8 resource progressively. The bundled `skill-creator` is always read-only and can
draft ordinary portable skills. Existing references, assets, scripts and other safe
relative text files can be read as inert text. Binary assets, executable skill scripts,
shell commands, package installation, network downloads and community installation are
not capabilities of this integration. A skill needing them requires separately available,
authorized host tools. `compatibility` is shown as a requirement, and `allowed-tools`
is descriptive; neither grants access or approval. Skill content remains untrusted
lower-priority guidance, never system policy. Prior loaded skill instructions are
omitted from subsequent provider context and can be read again from the new catalog.

The quarantined `save_skill` prototype proposes exactly one owned-store SKILL.md creation/replacement. Its
approval card shows the exact before/after source and destination. Explicit review is
required in both Manual and Auto modes; Planning advertises only read tools. Built-ins
and selected external folders cannot be edited. Resource creation, deletion, arbitrary
file writes, project edits and script execution are outside this tool's scope.

The host bounds scans to eight selected roots and 1000 directory entries, and uses core
limits of 100 skills including the creator, 64 KiB per file, 2 MiB total documents and
24 KiB summaries. Invalid documents and duplicate canonical names are diagnosed and
excluded; the creator cannot be shadowed. Canonical Unicode names are supported; a physical
folder with a different NFKC spelling must be renamed manually before discovery. UTF-8 reads use bounded buffers and file handles,
with ordinary-file, no-symlink/no-hardlink, canonical-directory and identity/revision checks.
Explicit read-only roots cannot overlap the app state folder. Resource components named
for credentials, authentication, tokens, secrets, private keys, sessions, preferences,
memories, .git/.aws/.codex/.env, and key containers (.pem/.key/.p12/.pfx) are excluded,
matching vivi-cli's host policy. This is an explicit compatibility restriction, not a
general secret detector. Currently configured desktop provider keys are also screened
from discovered documents/resources and rechecked before reads and writes. Resource
reads recheck their source revision, and removed roots cannot authorize old callbacks.

The fixture-only owned-write prototype uses the existing persistence admission/drain and atomic synced-file writer,
an exclusive cross-process store lock, full on-disk revision comparison after review,
and cancellation/path/revision checks immediately before primary rename. Valid old source
is retained as SKILL.md.bak. Pre-rename failure retains the old primary; a successful
rename has a committed receipt even when cancellation follows. Power-loss durability
limitations or post-rename directory-sync errors use the existing visible notices.
A dead host's valid PID lock can be recovered; a live, malformed or unreadable lock fails
closed and may require manual recovery. Invalid/unreadable primary documents remain
untouched and cannot be overwritten through an old approval; resolve the file problem
before retrying. Uncommitted temp files are ignored on discovery. This is ordinary local
filesystem handling, not a claim of complete protection against a hostile process
concurrently replacing filesystem paths, nor proof that third-party workflows execute.

Ordinary verification uses synthetic standard-format folders, a mocked fixture-only
write capability and mocked provider transport with
the installed registry package. No Discord login, real provider call, skill script or
community workflow is executed. Physical Electron UI and Windows filesystem acceptance
remain separate manual checks.
