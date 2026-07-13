<script lang="ts">
  import { diffAgentApproval, type AgentFieldChange } from '../utils/agentApprovalDiff'

  interface Props {
    before: unknown
    after: unknown
  }

  let { before, after }: Props = $props()
  let changes = $derived(diffAgentApproval(before, after))
  let isCreation = $derived(before === null || before === undefined)

  const commandTypeLabels: Record<number, string> = {
    0: 'Message Received',
    1: 'Private Message Received',
    2: 'Member Join',
    3: 'Member Leave',
    4: 'Member Ban',
    5: 'Reaction'
  }

  function formatValue(path: string, value: unknown): string {
    if (value === undefined || value === null || value === '') return 'Empty'
    if (path === '/type' && typeof value === 'number') return commandTypeLabels[value] ?? String(value)
    if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled'
    if (typeof value === 'object') return JSON.stringify(value, null, 2)
    return String(value)
  }

  function isLong(path: string, value: unknown): boolean {
    const formatted = formatValue(path, value)
    return formatted.length > 120 || formatted.includes('\n')
  }

  function icon(change: AgentFieldChange): string {
    if (change.kind === 'added') return 'add_circle'
    if (change.kind === 'removed') return 'remove_circle'
    return 'compare_arrows'
  }

  function color(change: AgentFieldChange): string {
    if (change.kind === 'added') return 'text-success'
    if (change.kind === 'removed') return 'text-error'
    return 'text-warning'
  }
</script>

<div class="border-t border-base-300">
  <div class="px-3 py-2 bg-base-100 flex items-center gap-2">
    <span class="material-symbols-outlined text-base text-warning">difference</span>
    <span class="text-sm font-semibold">{isCreation ? 'New resource fields' : 'Proposed changes'}</span>
    <span class="badge badge-sm badge-neutral ml-auto">{changes.length} {changes.length === 1 ? 'field' : 'fields'}</span>
  </div>

  <div class="max-h-80 overflow-y-auto divide-y divide-base-300">
    {#each changes as change (change.path)}
      <div class="px-3 py-3 bg-base-100">
        <div class="flex items-center gap-2 mb-2">
          <span class="material-symbols-outlined text-base {color(change)}">{icon(change)}</span>
          <span class="font-medium text-sm">{change.label}</span>
          <code class="text-[11px] opacity-45 ml-auto hidden sm:block">{change.path}</code>
        </div>

        {#if change.kind === 'changed'}
          <div class="grid grid-cols-1 items-stretch gap-2">
            <div class="min-w-0 p-2 border-l-2 border-error bg-error/10 rounded-sm">
              <div class="text-[10px] uppercase opacity-55 mb-1">Current</div>
              {#if isLong(change.path, change.before)}
                <pre class="text-xs whitespace-pre-wrap break-words overflow-auto max-h-40">{formatValue(change.path, change.before)}</pre>
              {:else}
                <div class="text-xs break-words">{formatValue(change.path, change.before)}</div>
              {/if}
            </div>
            <span class="material-symbols-outlined justify-self-center opacity-45">arrow_downward</span>
            <div class="min-w-0 p-2 border-l-2 border-success bg-success/10 rounded-sm">
              <div class="text-[10px] uppercase opacity-55 mb-1">Proposed</div>
              {#if isLong(change.path, change.after)}
                <pre class="text-xs whitespace-pre-wrap break-words overflow-auto max-h-40">{formatValue(change.path, change.after)}</pre>
              {:else}
                <div class="text-xs break-words">{formatValue(change.path, change.after)}</div>
              {/if}
            </div>
          </div>
        {:else}
          <div class="p-2 border-l-2 {change.kind === 'added' ? 'border-success bg-success/10' : 'border-error bg-error/10'} rounded-sm">
            <div class="text-[10px] uppercase opacity-55 mb-1">{change.kind === 'added' ? 'New value' : 'Removed value'}</div>
            {#if isLong(change.path, change.kind === 'added' ? change.after : change.before)}
              <pre class="text-xs whitespace-pre-wrap break-words overflow-auto max-h-40">{formatValue(change.path, change.kind === 'added' ? change.after : change.before)}</pre>
            {:else}
              <div class="text-xs break-words">{formatValue(change.path, change.kind === 'added' ? change.after : change.before)}</div>
            {/if}
          </div>
        {/if}
      </div>
    {:else}
      <div class="px-3 py-4 text-sm opacity-60">No field changes detected.</div>
    {/each}
  </div>
</div>
