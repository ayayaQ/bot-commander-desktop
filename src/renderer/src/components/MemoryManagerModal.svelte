<script lang="ts">
  import { onMount } from 'svelte'
  import type {
    AgentMemoryListResult,
    AgentMemoryWithRevision
  } from '../../../shared/agentTypes'
  import { t } from '../stores/localisation'

  interface Props {
    dialog: HTMLDialogElement
  }

  let { dialog = $bindable() }: Props = $props()
  let result: AgentMemoryListResult = $state({
    memories: [],
    limits: {
      maximumMemories: 100,
      maximumMemoryCharacters: 1000,
      maximumTotalCharacters: 20000
    }
  })
  let drafts: Record<string, string> = $state({})
  let newContent = $state('')
  let loading = $state(false)
  let savingId = $state<string | null>(null)
  let deletingId = $state<string | null>(null)
  let error = $state('')

  let memories = $derived(
    [...result.memories].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  )
  let totalCharacters = $derived(
    result.memories.reduce((total, memory) => total + memory.content.length, 0)
  )

  function applyResult(next: AgentMemoryListResult) {
    const previous = new Map(result.memories.map((memory) => [memory.id, memory.content]))
    result = next
    for (const memory of next.memories) {
      if (
        drafts[memory.id] === undefined ||
        drafts[memory.id] === previous.get(memory.id)
      ) {
        drafts[memory.id] = memory.content
      }
    }
    const ids = new Set(next.memories.map((memory) => memory.id))
    for (const id of Object.keys(drafts)) {
      if (!ids.has(id)) delete drafts[id]
    }
  }

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value)
  }

  async function load() {
    loading = true
    error = ''
    try {
      applyResult(await window.electron.ipcRenderer.invoke('memory:list'))
    } catch (value) {
      error = errorMessage(value)
    } finally {
      loading = false
    }
  }

  async function createMemory() {
    if (!newContent.trim()) return
    savingId = 'new'
    error = ''
    try {
      applyResult(await window.electron.ipcRenderer.invoke('memory:create', newContent))
      newContent = ''
    } catch (value) {
      error = errorMessage(value)
    } finally {
      savingId = null
    }
  }

  async function updateMemory(memory: AgentMemoryWithRevision) {
    savingId = memory.id
    error = ''
    try {
      const next = await window.electron.ipcRenderer.invoke(
        'memory:update',
        memory.id,
        memory.revision,
        drafts[memory.id]
      )
      delete drafts[memory.id]
      applyResult(next)
    } catch (value) {
      error = errorMessage(value)
    } finally {
      savingId = null
    }
  }

  async function deleteMemory(memory: AgentMemoryWithRevision) {
    savingId = memory.id
    error = ''
    try {
      applyResult(
        await window.electron.ipcRenderer.invoke(
          'memory:delete',
          memory.id,
          memory.revision
        )
      )
      deletingId = null
    } catch (value) {
      error = errorMessage(value)
    } finally {
      savingId = null
    }
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value))
  }

  function handleChanged(_event: unknown, next: AgentMemoryListResult) {
    applyResult(next)
  }

  function handleClose() {
    newContent = ''
    deletingId = null
    error = ''
  }

  onMount(() => {
    window.electron.ipcRenderer.on('memory:changed', handleChanged)
    void load()
    return () => window.electron.ipcRenderer.removeListener('memory:changed', handleChanged)
  })
</script>

<dialog bind:this={dialog} class="modal" onclose={handleClose}>
  <div class="modal-box max-w-4xl h-[82vh] p-0 flex flex-col">
    <header class="px-6 py-4 border-b border-base-300 flex items-start gap-4 shrink-0">
      <div class="grow">
        <h3 class="font-bold text-lg">{$t('memories')}</h3>
        <p class="text-sm opacity-70">{$t('memories-description')}</p>
      </div>
      <button class="btn btn-sm btn-circle btn-ghost" onclick={() => dialog.close()} aria-label="Close">
        <span class="material-symbols-outlined">close</span>
      </button>
    </header>

    <div class="grow min-h-0 overflow-y-auto px-6 py-4 space-y-4">
      <div class="alert alert-warning text-sm">
        <span class="material-symbols-outlined">privacy_tip</span>
        <span>{$t('memory-local-warning')}</span>
      </div>

      {#if error}
        <div class="alert alert-error text-sm">
          <span>{error}</span>
          <button class="btn btn-xs btn-ghost" onclick={load}>{$t('refresh')}</button>
        </div>
      {/if}

      <section class="border border-base-300 rounded-box p-4 space-y-3">
        <label class="font-semibold" for="new-memory">{$t('add-memory')}</label>
        <textarea
          id="new-memory"
          class="textarea textarea-bordered w-full"
          rows="3"
          maxlength={result.limits.maximumMemoryCharacters}
          bind:value={newContent}
          placeholder={$t('memory-placeholder')}
        ></textarea>
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs opacity-60">
            {newContent.length}/{result.limits.maximumMemoryCharacters}
          </span>
          <button
            class="btn btn-sm btn-primary"
            onclick={createMemory}
            disabled={!newContent.trim() || savingId !== null}
          >
            {savingId === 'new' ? $t('saving') : $t('add-memory')}
          </button>
        </div>
      </section>

      <div class="flex items-center justify-between text-sm">
        <span>{memories.length}/{result.limits.maximumMemories} {$t('memories').toLowerCase()}</span>
        <span class="opacity-60">{totalCharacters}/{result.limits.maximumTotalCharacters} {$t('characters')}</span>
      </div>

      {#if loading}
        <div class="flex justify-center py-10"><span class="loading loading-spinner"></span></div>
      {:else if memories.length === 0}
        <div class="text-center py-10 opacity-60">{$t('no-memories')}</div>
      {:else}
        <div class="space-y-3">
          {#each memories as memory (memory.id)}
            <article class="border border-base-300 rounded-box p-4 space-y-3">
              <textarea
                class="textarea textarea-bordered w-full"
                rows="3"
                maxlength={result.limits.maximumMemoryCharacters}
                bind:value={drafts[memory.id]}
                aria-label="Memory content"
              ></textarea>
              <div class="text-xs opacity-60 flex flex-wrap gap-x-4 gap-y-1">
                <span>{$t('memory-created-by')} {memory.createdBy}</span>
                <span>{$t('memory-updated')} {formatDate(memory.updatedAt)}</span>
                <span>{(drafts[memory.id] || '').length}/{result.limits.maximumMemoryCharacters}</span>
              </div>
              {#if deletingId === memory.id}
                <div class="alert alert-warning py-2 text-sm">
                  <span>{$t('delete-memory-confirm')}</span>
                  <div class="ml-auto flex gap-2">
                    <button class="btn btn-xs btn-ghost" onclick={() => (deletingId = null)}>{$t('cancel')}</button>
                    <button class="btn btn-xs btn-error" onclick={() => deleteMemory(memory)}>{$t('delete')}</button>
                  </div>
                </div>
              {:else}
                <div class="flex justify-end gap-2">
                  <button class="btn btn-sm btn-ghost text-error" onclick={() => (deletingId = memory.id)} disabled={savingId !== null}>{$t('delete')}</button>
                  <button
                    class="btn btn-sm btn-primary"
                    onclick={() => updateMemory(memory)}
                    disabled={savingId !== null || !drafts[memory.id]?.trim() || drafts[memory.id] === memory.content}
                  >
                    {savingId === memory.id ? $t('saving') : $t('save')}
                  </button>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </div>

    <footer class="px-6 py-4 border-t border-base-300 flex justify-end shrink-0">
      <button class="btn" onclick={() => dialog.close()}>{$t('close')}</button>
    </footer>
  </div>
</dialog>
