<script lang="ts">
  import { onMount } from 'svelte'
  import type { AgentSkillsStatus } from '../../../shared/agentSkillTypes'
  import type { ResourceChangedEvent } from '../../../shared/mcpTypes'

  let status: AgentSkillsStatus | undefined = $state()
  let busy = $state(false)
  let error = $state('')
  let expanded = $state(false)
  let request = 0

  async function refresh() {
    const current = ++request
    busy = true
    error = ''
    try {
      const result = (await window.electron.ipcRenderer.invoke('skills:list')) as AgentSkillsStatus
      if (current === request) status = result
    } catch (cause) {
      if (current === request) error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (current === request) busy = false
    }
  }
  async function change(channel: string, path?: string) {
    if (busy) return
    const current = ++request
    busy = true
    error = ''
    try {
      const result = (await window.electron.ipcRenderer.invoke(
        channel,
        ...(path ? [path] : [])
      )) as AgentSkillsStatus | null
      if (current === request && result) status = result
    } catch (cause) {
      if (current === request) error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (current === request) busy = false
    }
  }
  onMount(() => {
    void refresh()
    const handleChange = (payload: unknown) => {
      if ((payload as ResourceChangedEvent).kind === 'skills') void refresh()
    }
    window.electron.ipcRenderer.on('resource:changed', handleChange)
    return () => {
      request++
      window.electron.ipcRenderer.removeListener('resource:changed', handleChange)
    }
  })
</script>

<div class="border-t border-base-300 p-3 text-xs">
  <button
    class="btn btn-ghost btn-sm w-full justify-between"
    onclick={() => (expanded = !expanded)}
    aria-expanded={expanded}
  >
    <span>Skills {status ? `(${status.skills.length})` : ''}</span>
    <span class="material-symbols-outlined text-base"
      >{expanded ? 'expand_less' : 'expand_more'}</span
    >
  </button>
  {#if expanded}
    <div class="max-h-80 overflow-y-auto space-y-3 pt-2">
      <p class="line-clamp-2" title={status?.saveSupport.reason}>
        Ask the agent or drag skills into the folder. Changes apply next turn.
      </p>
      {#if status}
        <div class="flex flex-wrap gap-1">
          <button class="btn btn-xs btn-outline" onclick={refresh} disabled={busy}>Refresh</button>
          <button
            class="btn btn-xs btn-outline"
            onclick={() => change('skills:open-folder')}
            title={status.ownedRoot}
            disabled={busy}>Open folder</button
          >
        </div>
        {#each status.externalRoots as path (path)}
          <div class="space-y-1">
            <div class="truncate" title={path}>Read-only: {path}</div>
            <button
              class="btn btn-xs btn-ghost"
              onclick={() => change('skills:remove-root', path)}
              disabled={busy}>Remove folder</button
            >
          </div>
        {/each}
        {#each status.skills as skill (skill.name)}
          <div class="border-t border-base-300 pt-2">
            <div class="font-semibold break-all">
              {skill.name}
              {skill.readOnly ? '(read-only)' : ''}
            </div>
            <div class="opacity-70 line-clamp-2" title={skill.description}>{skill.description}</div>
          </div>
        {/each}
        {#each status.diagnostics as diagnostic}
          <div
            class="text-warning break-words line-clamp-2"
            title={`${diagnostic.source}: ${diagnostic.message}`}
          >
            <span class="break-all">{diagnostic.source}</span>: {diagnostic.message}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
  {#if error}<p class="text-error mt-2 break-words" role="alert">{error}</p>{/if}
</div>
