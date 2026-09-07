<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDInteractionCommand } from '../types/types'
  import InteractionEditor from './InteractionEditor.svelte'
  import InteractionListItem from './InteractionListItem.svelte'
  import HeaderBar from './HeaderBar.svelte'
  import { fade } from 'svelte/transition'
  import { t } from '../stores/localisation'
  import { connectionStore } from '../stores/connection'
  import InteractionPublishStatus from './InteractionPublishStatus.svelte'
  import {
    interactionPublication,
    publicationRequestPending,
    publishInteractions
  } from '../stores/interactionPublication'
  import TipCard from './TipCard.svelte'
  import {
    getVisibleInteractions,
    interactionStatusOptions,
    type InteractionSortMode,
    type InteractionStatusFilter
  } from '../utils/interactionListSearch'
  import type { ResourceChangedEvent } from '../../../shared/mcpTypes'

  const emptyKaomojis = ['(´。＿。｀)', '(╥_╥)', '(｡•́︿•̀｡)', '(っ˘̩╭╮˘̩)っ', '(ᵕ—ᴗ—)']
  const noResultsKaomojis = ['(￣ω￣;)', '(・・;)', '(¬_¬)', '(-_-;)', '(°ロ°)']
  const emptyKaomoji = emptyKaomojis[Math.floor(Math.random() * emptyKaomojis.length)]
  const noResultsKaomoji = noResultsKaomojis[Math.floor(Math.random() * noResultsKaomojis.length)]

  let interactions: BCFDInteractionCommand[] = $state([])
  let isEditing = $state(false)
  let editingInteraction: BCFDInteractionCommand | null = $state(null)
  let editingIndex: number | null = $state(null)
  let searchQuery = $state('')
  let statusFilter: InteractionStatusFilter = $state('all')
  let sortMode: InteractionSortMode = $state('manual')
  let isSyncing = $derived($interactionPublication.busy || $publicationRequestPending)
  let interactionsRevision = $state('')
  let externalConflict = $state(false)

  onMount(() => {
    const handleResourceChanged = (event: ResourceChangedEvent) => {
      if (event.kind !== 'interactions' || event.source === 'renderer') return
      if (isEditing) externalConflict = true
      else void loadInteractions()
    }
    window.electron.ipcRenderer.on('resource:changed', handleResourceChanged)
    void loadInteractions()
    return () =>
      window.electron.ipcRenderer.removeListener('resource:changed', handleResourceChanged)
  })

  async function loadInteractions() {
    interactions = await window.electron.ipcRenderer.invoke('get-interactions')
    interactionsRevision = await window.electron.ipcRenderer.invoke('get-interactions-revision')
    externalConflict = false
  }

  async function saveInteractions() {
    const result = await window.electron.ipcRenderer.invoke(
      'save-interactions',
      $state.snapshot(interactions),
      interactionsRevision
    )
    interactionsRevision = result.revision || interactionsRevision
  }

  function addInteraction() {
    if (isSyncing) return
    isEditing = true
    editingInteraction = null
    editingIndex = null
    externalConflict = false
  }

  function editInteraction(interaction: BCFDInteractionCommand) {
    if (isSyncing) return
    isEditing = true
    editingInteraction = interaction
    editingIndex = interactions.findIndex((i) => i.id === interaction.id)
    externalConflict = false
  }

  async function handleAdd(event: CustomEvent<BCFDInteractionCommand>) {
    if (externalConflict || isSyncing) return
    interactions = [...interactions, event.detail]
    await saveInteractions()
    isEditing = false
  }

  async function handleUpdate(
    event: CustomEvent<{ interaction: BCFDInteractionCommand; index: number | null }>
  ) {
    if (externalConflict || isSyncing) return
    const { interaction: updatedInteraction, index } = event.detail
    interactions = interactions.map((i, idx) => (idx === index ? updatedInteraction : i))
    await saveInteractions()
    isEditing = false
    editingInteraction = null
    editingIndex = null
  }

  async function deleteInteraction(interaction: BCFDInteractionCommand) {
    if (isSyncing) return
    interactions = interactions.filter((i) => i.id !== interaction.id)
    await saveInteractions()
  }

  async function reloadAfterConflict() {
    isEditing = false
    editingInteraction = null
    editingIndex = null
    await loadInteractions()
  }

  function syncAllCommands() {
    return publishInteractions('sync')
  }

  function registerCommand(interaction: BCFDInteractionCommand) {
    return publishInteractions('register', interaction.id)
  }

  function unregisterCommand(interaction: BCFDInteractionCommand) {
    return publishInteractions('unregister', interaction.id)
  }

  function resetInteractionSearch() {
    searchQuery = ''
    statusFilter = 'all'
    sortMode = 'manual'
  }

  let hasActiveSearchControls = $derived(
    searchQuery.trim() !== '' || statusFilter !== 'all' || sortMode !== 'manual'
  )
  let visibleInteractions = $derived(
    getVisibleInteractions(interactions, searchQuery, statusFilter, sortMode)
  )
</script>

<TipCard
  tipId="tip_interactions"
  icon="smart_button"
  title={$t('interactions')}
  body={$t('tip-interactions-body')}
/>
<InteractionPublishStatus />
<div class="">
  {#if isEditing}
    {#if externalConflict}
      <div class="alert alert-warning m-4">
        <span
          >This interaction data changed externally. Reload before saving to avoid overwriting it.</span
        >
        <button class="btn btn-sm" onclick={reloadAfterConflict}>Reload</button>
      </div>
    {/if}
    <InteractionEditor
      mode={editingInteraction ? 'edit' : 'add'}
      interaction={editingInteraction}
      index={editingIndex}
      on:add={handleAdd}
      on:update={handleUpdate}
      on:cancel={() => {
        isEditing = false
        externalConflict = false
      }}
    />
  {:else}
    <HeaderBar>
      <div class="basis-full">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-2xl font-bold">{$t('interactions')}</h2>
          <div class="flex gap-2 items-center">
            <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('sync-all')}>
              <button
                class="btn btn-secondary"
                onclick={syncAllCommands}
                disabled={isSyncing || !$connectionStore.connected}
              >
                {#if isSyncing}
                  <span class="loading loading-spinner loading-sm"></span>
                {:else}
                  <span class="material-symbols-outlined">sync</span>
                {/if}
                {$t('sync-all')}
              </button>
            </span>
            <button class="btn btn-primary" onclick={addInteraction} disabled={isSyncing}>
              <span class="material-symbols-outlined">add</span>{$t('add-interaction')}
            </button>
          </div>
        </div>
        <div class="space-y-3">
          <label class="input input-bordered flex items-center gap-2 w-full">
            <span class="material-symbols-outlined text-base-content/60">search</span>
            <input type="text" class="grow" placeholder={$t('search')} bind:value={searchQuery} />
            {#if searchQuery.trim()}
              <button
                type="button"
                class="btn btn-ghost btn-xs btn-circle"
                aria-label={$t('reset-search')}
                onclick={() => (searchQuery = '')}
              >
                <span class="material-symbols-outlined text-base">close</span>
              </button>
            {/if}
          </label>

          <div
            class="flex flex-col gap-3 rounded-lg border border-base-300 bg-base-100/60 px-3 py-2 md:flex-row md:items-center md:justify-between"
          >
            <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
              <label class="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <span
                  class="material-symbols-outlined text-base-content/50"
                  title={$t('status')}
                  aria-hidden="true">check_circle</span
                >
                <select
                  class="select select-sm select-bordered w-full sm:min-w-44"
                  bind:value={statusFilter}
                  aria-label={$t('filter-by-status')}
                >
                  {#each interactionStatusOptions as option}
                    <option value={option.value}>{$t(option.labelKey)}</option>
                  {/each}
                </select>
              </label>

              <div
                class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2"
                role="group"
                aria-label={$t('sort-interactions')}
              >
                <span
                  class="material-symbols-outlined text-base-content/50"
                  title={$t('sort-interactions')}
                  aria-hidden="true">sort</span
                >
                <div class="join max-w-full overflow-x-auto">
                  <button
                    type="button"
                    class="btn btn-sm join-item {sortMode === 'manual'
                      ? 'btn-primary'
                      : 'btn-ghost'}"
                    onclick={() => (sortMode = 'manual')}
                  >
                    {$t('sort-manual')}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm join-item {sortMode === 'name-asc'
                      ? 'btn-primary'
                      : 'btn-ghost'}"
                    onclick={() => (sortMode = 'name-asc')}
                  >
                    {$t('sort-name-asc')}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm join-item {sortMode === 'name-desc'
                      ? 'btn-primary'
                      : 'btn-ghost'}"
                    onclick={() => (sortMode = 'name-desc')}
                  >
                    {$t('sort-name-desc')}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm join-item {sortMode === 'registered-first'
                      ? 'btn-primary'
                      : 'btn-ghost'}"
                    onclick={() => (sortMode = 'registered-first')}
                  >
                    {$t('sort-registered-first')}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm join-item {sortMode === 'not-registered-first'
                      ? 'btn-primary'
                      : 'btn-ghost'}"
                    onclick={() => (sortMode = 'not-registered-first')}
                  >
                    {$t('sort-not-registered-first')}
                  </button>
                </div>
              </div>
            </div>

            <div class="flex items-center justify-between gap-3 md:justify-end">
              <span class="badge badge-ghost whitespace-nowrap">
                {$t('showing-interactions')
                  .replace('{shown}', String(visibleInteractions.length))
                  .replace('{total}', String(interactions.length))}
              </span>
              {#if hasActiveSearchControls}
                <button class="btn btn-ghost btn-sm" onclick={resetInteractionSearch}>
                  <span class="material-symbols-outlined text-base">restart_alt</span>
                  {$t('reset-search')}
                </button>
              {/if}
            </div>
          </div>
        </div>
      </div>
    </HeaderBar>
    <div class="p-4">
      {#if visibleInteractions.length === 0}
        <div
          class="flex flex-col items-center justify-center py-16 text-base-content/40 select-none"
        >
          {#if interactions.length === 0}
            <p class="text-5xl mb-3">{emptyKaomoji}</p>
            <p class="text-sm font-medium">{$t('no-interactions')}</p>
            <p class="text-xs mt-1">{$t('add-interaction-hint')}</p>
          {:else}
            <p class="text-5xl mb-3">{noResultsKaomoji}</p>
            <p class="text-sm font-medium">{$t('no-interactions-found')}</p>
          {/if}
        </div>
      {:else}
        <ul class="space-y-2">
          {#each visibleInteractions as interaction}
            <div transition:fade={{ duration: 100 }}>
              <InteractionListItem
                {interaction}
                {editInteraction}
                {deleteInteraction}
                {registerCommand}
                {unregisterCommand}
              />
            </div>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
