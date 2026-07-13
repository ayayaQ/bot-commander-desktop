<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDInteractionCommand } from '../types/types'
  import InteractionEditor from './InteractionEditor.svelte'
  import InteractionListItem from './InteractionListItem.svelte'
  import HeaderBar from './HeaderBar.svelte'
  import { fade } from 'svelte/transition'
  import { t } from '../stores/localisation'
  import { connectionStore } from '../stores/connection'
  import TipCard from './TipCard.svelte'
  import {
    getVisibleInteractions,
    interactionStatusOptions,
    type InteractionSortMode,
    type InteractionStatusFilter
  } from '../utils/interactionListSearch'

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
  let isSyncing = $state(false)

  onMount(async () => {
    await loadInteractions()
  })

  async function loadInteractions() {
    interactions = await window.electron.ipcRenderer.invoke('get-interactions')
  }

  async function saveInteractions() {
    await window.electron.ipcRenderer.invoke('save-interactions', $state.snapshot(interactions))
  }

  function addInteraction() {
    isEditing = true
    editingInteraction = null
    editingIndex = null
  }

  function editInteraction(interaction: BCFDInteractionCommand) {
    isEditing = true
    editingInteraction = interaction
    editingIndex = interactions.findIndex((i) => i.id === interaction.id)
  }

  async function handleAdd(event: CustomEvent<BCFDInteractionCommand>) {
    interactions = [...interactions, event.detail]
    await saveInteractions()
    isEditing = false
  }

  async function handleUpdate(
    event: CustomEvent<{ interaction: BCFDInteractionCommand; index: number | null }>
  ) {
    const { interaction: updatedInteraction, index } = event.detail
    interactions = interactions.map((i, idx) => (idx === index ? updatedInteraction : i))
    await saveInteractions()
    isEditing = false
    editingInteraction = null
    editingIndex = null
  }

  async function deleteInteraction(interaction: BCFDInteractionCommand) {
    interactions = interactions.filter((i) => i.id !== interaction.id)
    await saveInteractions()
  }

  async function syncAllCommands() {
    isSyncing = true
    try {
      const result = await window.electron.ipcRenderer.invoke('sync-all-slash-commands')
      if (result.success) {
        await loadInteractions()
      } else {
        alert('Error syncing commands: ' + result.error)
      }
    } finally {
      isSyncing = false
    }
  }

  async function registerCommand(interaction: BCFDInteractionCommand) {
    const result = await window.electron.ipcRenderer.invoke(
      'register-slash-command',
      interaction.id
    )
    if (result.success) {
      await loadInteractions()
    } else {
      alert('Error registering command: ' + result.error)
    }
  }

  async function unregisterCommand(interaction: BCFDInteractionCommand) {
    const result = await window.electron.ipcRenderer.invoke(
      'unregister-slash-command',
      interaction.id
    )
    if (result.success) {
      await loadInteractions()
    } else {
      alert('Error unregistering command: ' + result.error)
    }
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
<div class="">
  {#if isEditing}
    <InteractionEditor
      mode={editingInteraction ? 'edit' : 'add'}
      interaction={editingInteraction}
      index={editingIndex}
      on:add={handleAdd}
      on:update={handleUpdate}
      on:cancel={() => (isEditing = false)}
    />
  {:else}
    <HeaderBar>
      <div class="basis-full">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-2xl font-bold">{$t('interactions')}</h2>
          <div class="flex gap-2 items-center">
            {#if !$connectionStore.connected}
              <span
                class="tooltip tooltip-warning tooltip-bottom"
                data-tip="Bot must be connected to sync commands"
              >
                <div class="flex items-center justify-center select-none">
                  <span class="material-symbols-outlined text-warning">info</span>
                </div>
              </span>
            {/if}
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
            <button class="btn btn-primary" onclick={addInteraction}>
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
