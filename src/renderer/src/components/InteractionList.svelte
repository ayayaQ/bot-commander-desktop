<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDInteractionCommand } from '../types/types'
  import InteractionEditor from './InteractionEditor.svelte'
  import InteractionListItem from './InteractionListItem.svelte'
  import HeaderBar from './HeaderBar.svelte'
  import { fade } from 'svelte/transition'
  import { t } from '../stores/localisation'
  import { connectionStore } from '../stores/connection'

  const emptyKaomojis = ['(´。＿。｀)', '(╥_╥)', '(｡•́︿•̀｡)', '(っ˘̩╭╮˘̩)っ', '(ᵕ—ᴗ—)']
  const noResultsKaomojis = ['(￣ω￣;)', '(・・;)', '(¬_¬)', '(-_-;)', '(°ロ°)']
  const emptyKaomoji = emptyKaomojis[Math.floor(Math.random() * emptyKaomojis.length)]
  const noResultsKaomoji = noResultsKaomojis[Math.floor(Math.random() * noResultsKaomojis.length)]

  let interactions: BCFDInteractionCommand[] = $state([])
  let isEditing = $state(false)
  let editingInteraction: BCFDInteractionCommand | null = $state(null)
  let editingIndex: number | null = $state(null)
  let searchQuery = $state('')
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

  let filteredInteractions = $derived(interactions.filter(
    (i) =>
      i.commandName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      i.commandDescription.toLowerCase().includes(searchQuery.toLowerCase())
  ))
</script>

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
        <div class="">
          <label class="input input-bordered flex items-center gap-2 w-full">
            <input type="text" class="grow" placeholder={$t('search')} bind:value={searchQuery} />
            <span class="material-symbols-outlined">search</span>
          </label>
        </div>
      </div>
    </HeaderBar>
    <div class="p-4">
      {#if filteredInteractions.length === 0}
        <div class="flex flex-col items-center justify-center py-16 text-base-content/40 select-none">
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
          {#each filteredInteractions as interaction}
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
