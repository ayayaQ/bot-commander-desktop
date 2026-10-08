# Agent Skills

Skills are standard `<name>/SKILL.md` folders with YAML frontmatter. The Skills panel lists
metadata, diagnostics, the app-wide folder, and up to eight explicitly selected read-only
folders. No workspace, ancestor, home, or community discovery is performed.

Each agent turn receives a fresh instruction-only catalog at user priority. `list_skills`
lists metadata; `read_skill` loads complete UTF-8 instructions or relative text resources
on demand, within the core byte limits. Earlier skill bodies are omitted on later turns.
Folder names must match normalized skill names. Duplicate names and unsupported invocation
semantics are diagnosed without hiding other valid skills. Selected folders can be removed.
Ordinary Windows case and short-name aliases use actual directory identity for reads.

The bundled read-only `skill-creator` can draft standard SKILL.md content in chat. Save it
manually as `<name>/SKILL.md` in the displayed app-wide folder or a selected folder, then
refresh or start a new turn. Automatic saving is disabled on Windows, macOS, and Linux;
there is no save tool, save dispatch, writer, or approval workflow in this release.

All skills are read-only to the agent. Allowed-tool hints and compatibility metadata grant
no tools or Auto eligibility. Scripts remain inert text; binary assets, shell commands,
dependency installation, and community downloads are unavailable. Existing private-state
and credential-path exclusions remain in force. Skills cannot override current user requests.
This read/manual-draft release does not establish acceptance of automatic skill saves.
