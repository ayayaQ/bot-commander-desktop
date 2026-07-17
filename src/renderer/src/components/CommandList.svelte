<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDCommand } from '../types/types'
  import CommandEditor from './CommandEditor.svelte'
  import CommandListItem from './CommandListItem.svelte'
  import HeaderBar from './HeaderBar.svelte'
  import CommandRepository from './CommandRepository.svelte'
  import ShareCommandModal from './ShareCommandModal.svelte'
  import { fade } from 'svelte/transition'
  import { t } from '../stores/localisation'
  import { apiAuthStore } from '../stores/apiAuth'
  import TipCard from './TipCard.svelte'
  import {
    commandTypeOptions,
    getVisibleCommands,
    type CommandSortMode,
    type CommandTypeFilter
  } from '../utils/commandListSearch'

  const emptyKaomojis = ['(´。＿。｀)', '(╥_╥)', '(｡•́︿•̀｡)', '(っ˘̩╭╮˘̩)っ', '(ᵕ—ᴗ—)']
  const noResultsKaomojis = ['(￣ω￣;)', '(・・;)', '(¬_¬)', '(-_-;)', '(°ロ°)']
  const emptyKaomoji = emptyKaomojis[Math.floor(Math.random() * emptyKaomojis.length)]
  const noResultsKaomoji = noResultsKaomojis[Math.floor(Math.random() * noResultsKaomojis.length)]

  let commands: BCFDCommand[] = $state([])
  let isEditing = $state(false)
  let editingCommand: BCFDCommand | null = $state(null)
  let editingIndex: number | null = $state(null)
  let searchQuery = $state('')
  let typeFilter: CommandTypeFilter = $state('all')
  let sortMode: CommandSortMode = $state('manual')
  let showRepository = $state(false)
  let shareDialog: HTMLDialogElement = $state()
  let commandToShare: BCFDCommand | null = $state(null)

  onMount(async () => {
    await loadCommands()
  })

  async function loadCommands() {
    const result = await window.electron.ipcRenderer.invoke('get-commands')
    commands = result.bcfdCommands
  }

  async function saveCommands() {
    await window.electron.ipcRenderer.invoke('save-commands', {
      bcfdCommands: $state.snapshot(commands)
    })
  }

  function addCommand() {
    isEditing = true
    editingCommand = null
  }

  function editCommand(command: BCFDCommand) {
    isEditing = true
    editingCommand = command
    editingIndex = commands.findIndex((cmd) => cmd === command)
  }

  async function handleAdd(event: CustomEvent<BCFDCommand>) {
    commands = [...commands, event.detail]
    await saveCommands()
    isEditing = false
  }

  async function handleUpdate(event: CustomEvent<{ command: BCFDCommand; index: number | null }>) {
    const { command: updatedCommand, index } = event.detail
    commands = commands.map((cmd, i) => (i === index ? updatedCommand : cmd))
    await saveCommands()
    isEditing = false
    editingCommand = null
    editingIndex = null
  }

  async function deleteCommand(command: BCFDCommand) {
    commands = commands.filter((cmd) => cmd !== command)
    await saveCommands()
  }

  async function exportCommands() {
    const result = await window.electron.ipcRenderer.invoke('export-commands')
    if (result.success) {
    } else if (!result.canceled) {
      alert('Error exporting commands: ' + result.error)
    }
  }

  async function importCommands() {
    const result = await window.electron.ipcRenderer.invoke('import-commands')
    if (result.success) {
      commands = [...commands, ...result.commands]
      await saveCommands()
    } else if (!result.canceled) {
      alert('Error importing commands: ' + result.error)
    }
  }

  function openShareModal(command: BCFDCommand) {
    commandToShare = command
    shareDialog.showModal()
  }

  async function handleRepoImport(event: CustomEvent<BCFDCommand>) {
    const importedCommand = event.detail
    commands = [...commands, importedCommand]
    await saveCommands()
    showRepository = false
  }

  function resetCommandSearch() {
    searchQuery = ''
    typeFilter = 'all'
    sortMode = 'manual'
  }

  let hasActiveSearchControls = $derived(
    searchQuery.trim() !== '' || typeFilter !== 'all' || sortMode !== 'manual'
  )
  let visibleCommands = $derived(getVisibleCommands(commands, searchQuery, typeFilter, sortMode))
</script>

<TipCard tipId="tip_commands" icon="chat" title={$t('commands')} body={$t('tip-commands-body')} />
<div class="">
  {#if showRepository}
    <CommandRepository on:import={handleRepoImport} on:close={() => (showRepository = false)} />
  {:else if isEditing}
    <CommandEditor
      mode={editingCommand ? 'edit' : 'add'}
      command={editingCommand}
      index={editingIndex}
      on:add={handleAdd}
      on:update={handleUpdate}
      on:cancel={() => (isEditing = false)}
    />
  {:else}
    <HeaderBar>
      <div class=" basis-full">
        <div class="flex justify-between items-center mb-4">
          <h2 class="text-2xl font-bold">{$t('commands')}</h2>
          <div class="flex gap-2">
            <span
              class="tooltip tooltip-primary tooltip-bottom"
              data-tip={$t('browse-repository') || 'Browse Repository'}
            >
              <button class="btn btn-secondary" onclick={() => (showRepository = true)}>
                <span class="material-symbols-outlined">explore</span>
              </button>
            </span>
            <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('export')}>
              <button class="btn btn-primary" onclick={exportCommands}>
                <span class="material-symbols-outlined">download</span>
              </button>
            </span>
            <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('import')}>
              <button class="btn btn-primary" onclick={importCommands}>
                <span class="material-symbols-outlined">upload</span>
              </button>
            </span>
            <button class="btn btn-primary" onclick={addCommand}>
              <span class="material-symbols-outlined">add</span>{$t('add-command')}
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
                  title={$t('type')}
                  aria-hidden="true">category</span
                >
                <select
                  class="select select-sm select-bordered w-full sm:min-w-48"
                  bind:value={typeFilter}
                  aria-label={$t('filter-by-type')}
                >
                  {#each commandTypeOptions as option}
                    <option value={option.value}>{$t(option.labelKey)}</option>
                  {/each}
                </select>
              </label>

              <div
                class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2"
                role="group"
                aria-label={$t('sort-commands')}
              >
                <span
                  class="material-symbols-outlined text-base-content/50"
                  title={$t('sort-commands')}
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
                    class="btn btn-sm join-item {sortMode === 'type' ? 'btn-primary' : 'btn-ghost'}"
                    onclick={() => (sortMode = 'type')}
                  >
                    {$t('sort-type')}
                  </button>
                </div>
              </div>
            </div>

            <div class="flex items-center justify-between gap-3 md:justify-end">
              <span class="badge badge-ghost whitespace-nowrap">
                {$t('showing-commands')
                  .replace('{shown}', String(visibleCommands.length))
                  .replace('{total}', String(commands.length))}
              </span>
              {#if hasActiveSearchControls}
                <button class="btn btn-ghost btn-sm" onclick={resetCommandSearch}>
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
      {#if visibleCommands.length === 0}
        <div
          class="flex flex-col items-center justify-center py-16 text-base-content/40 select-none"
        >
          {#if commands.length === 0}
            <p class="text-5xl mb-3">{emptyKaomoji}</p>
            <p class="text-sm font-medium">{$t('no-commands')}</p>
            <p class="text-xs mt-1">{$t('add-command-hint')}</p>
          {:else}
            <p class="text-5xl mb-3">{noResultsKaomoji}</p>
            <p class="text-sm font-medium">{$t('no-commands-found')}</p>
          {/if}
        </div>
      {:else}
        <ul class="space-y-2">
          {#each visibleCommands as command}
            <div transition:fade={{ duration: 100 }}>
              <CommandListItem
                {command}
                {editCommand}
                {deleteCommand}
                shareCommand={$apiAuthStore.authenticated ? openShareModal : undefined}
              />
            </div>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<ShareCommandModal
  bind:dialog={shareDialog}
  command={commandToShare}
  on:shared={() => (commandToShare = null)}
/>
