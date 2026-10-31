# Agent Skills

Skills are standard `<name>/SKILL.md` folders with YAML frontmatter. The Skills panel lists
metadata and diagnostics. **Open folder** opens the app-wide skills directory in the system
file manager, creating it if needed. Drag standard skill folders there to import them manually,
then refresh or start a new turn. Previously configured read-only folders remain available
and can be removed. No workspace, ancestor, home, or community discovery is performed.

Each agent turn receives a fresh instruction-only catalog at user priority. `list_skills`
lists metadata; `read_skill` loads complete UTF-8 instructions or relative text resources
on demand, within the core byte limits. Earlier skill bodies are omitted on later turns.
Folder names must match normalized skill names. Duplicate names and unsupported invocation
semantics are diagnosed without hiding other valid skills. Selected folders can be removed.
Ordinary Windows case and short-name aliases use actual directory identity for reads.

Ask the agent to create or update a reusable skill. It reads the bundled read-only
`skill-creator` and proposes a complete standard document through `save_skill`. Manual mode
shows the exact before/after text for approval; enrolled Auto review can approve a requested
skill create/update, with manual fallback when review is uncertain or unavailable. Planning
cannot save. Saved skills appear in the panel immediately and become available next turn.

Saves write only `<owned-folder>/<name>/SKILL.md`, with revision checks, serialized mutations,
atomic replacement and cancellation checks before commit. Existing references are preserved.
Imported folders and the bundled creator remain read-only. You can also save files manually
and refresh the panel. Unsafe paths, symlinks, known provider credentials and unsupported
invocation semantics are rejected. The writer uses the existing cross-platform atomic
persistence service; unsupported directory sync has the same power-loss durability limits.

Allowed-tool hints and compatibility metadata grant no tools or Auto eligibility.
Scripts remain inert text; binary assets, shell commands,
dependency installation, and community downloads are unavailable. Existing private-state
and credential-path exclusions remain in force. Skills cannot override current user requests.
