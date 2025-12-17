<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import type { CommandDiff, DiffChange } from '../stores/aiChat'
  import { t } from '../stores/localisation'

  export let diff: CommandDiff

  const dispatch = createEventDispatcher<{
    accept: CommandDiff
    reject: void
  }>()

  function formatValue(value: string | boolean | number): string {
    if (typeof value === 'boolean') {
      return value ? 'Yes' : 'No'
    }
    if (typeof value === 'string') {
      if (value.length > 100) {
        return value.substring(0, 100) + '...'
      }
      return value || '(empty)'
    }
    return String(value)
  }

  function getChangeTypeClass(change: DiffChange): string {
    const oldEmpty = !change.oldValue || change.oldValue === '' || change.oldValue === 0
    const newEmpty = !change.newValue || change.newValue === '' || change.newValue === 0

    if (oldEmpty && !newEmpty) return 'addition'
    if (!oldEmpty && newEmpty) return 'deletion'
    return 'modification'
  }

  function getChangeIcon(change: DiffChange): string {
    const type = getChangeTypeClass(change)
    if (type === 'addition') return 'add_circle'
    if (type === 'deletion') return 'remove_circle'
    return 'change_circle'
  }
</script>

<div class="diff-viewer card bg-base-300 shadow-lg">
  <div class="card-body p-4">
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-lg font-bold flex items-center gap-2">
        <span class="material-symbols-outlined text-warning">compare_arrows</span>
        {$t('proposed-changes')}
      </h3>
      <div class="badge badge-info">{diff.changes.length} {$t('changes')}</div>
    </div>

    <div class="changes-list space-y-2 max-h-64 overflow-y-auto">
      {#each diff.changes as change}
        <div class="change-item p-3 rounded-lg bg-base-200 {getChangeTypeClass(change)}">
          <div class="flex items-start gap-2">
            <span
              class="material-symbols-outlined text-sm mt-0.5
              {getChangeTypeClass(change) === 'addition'
                ? 'text-success'
                : getChangeTypeClass(change) === 'deletion'
                  ? 'text-error'
                  : 'text-warning'}"
            >
              {getChangeIcon(change)}
            </span>
            <div class="flex-1 min-w-0">
              <div class="font-semibold text-sm mb-1">{change.fieldLabel}</div>

              {#if getChangeTypeClass(change) === 'modification'}
                <div class="grid grid-cols-1 gap-1 text-xs">
                  <div class="diff-old p-2 rounded bg-error/20 border-l-2 border-error">
                    <span class="opacity-60">-</span>
                    <code class="break-all">{formatValue(change.oldValue)}</code>
                  </div>
                  <div class="diff-new p-2 rounded bg-success/20 border-l-2 border-success">
                    <span class="opacity-60">+</span>
                    <code class="break-all">{formatValue(change.newValue)}</code>
                  </div>
                </div>
              {:else if getChangeTypeClass(change) === 'addition'}
                <div class="diff-new p-2 rounded bg-success/20 border-l-2 border-success text-xs">
                  <span class="opacity-60">+</span>
                  <code class="break-all">{formatValue(change.newValue)}</code>
                </div>
              {:else}
                <div class="diff-old p-2 rounded bg-error/20 border-l-2 border-error text-xs">
                  <span class="opacity-60">-</span>
                  <code class="break-all">{formatValue(change.oldValue)}</code>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>

    <div class="card-actions justify-end mt-4 pt-3 border-t border-base-content/10">
      <button class="btn btn-ghost btn-sm" on:click={() => dispatch('reject')}>
        <span class="material-symbols-outlined">close</span>
        {$t('reject')}
      </button>
      <button class="btn btn-success btn-sm" on:click={() => dispatch('accept', diff)}>
        <span class="material-symbols-outlined">check</span>
        {$t('accept-changes')}
      </button>
    </div>
  </div>
</div>

<style>
  .change-item {
    transition: all 0.2s ease;
  }

  .change-item:hover {
    transform: translateX(2px);
  }

  code {
    font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
    word-break: break-word;
  }

  .diff-viewer {
    animation: slideIn 0.3s ease-out;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
</style>
