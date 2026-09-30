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
  import { createCommandPersistence, prepareCommandImports } from '../utils/commandPersistence'
  import type { ResourceChangedEvent } from '../../../shared/mcpTypes'

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
  let commandsRevision = $state('')
  let externalConflict = $state(false)
  let commandsLoaded = $state(false)
  let loading = $state(false)
  let loadVersion = 0
  let importing = $state(false)
  let operationError = $state('')
  const persistence = createCommandPersistence(
    (snapshot) => window.electron.ipcRenderer.invoke('save-commands', snapshot),
    (snapshot, revision) => {
      commands = snapshot.bcfdCommands
      commandsRevision = revision
    }
  )
  const commandSaveStatus = persistence.status
  let mutationBlocked = $derived(
    !commandsLoaded ||
      loading ||
      $commandSaveStatus.saving ||
      $commandSaveStatus.pending ||
      importing ||
      externalConflict
  )

  onMount(() => {
    const handleResourceChanged = (event: ResourceChangedEvent) => {
      if (event.kind !== 'commands' || event.source === 'renderer') return
      if (isEditing || $commandSaveStatus.pending || importing) externalConflict = true
      else void loadCommands()
    }
    window.electron.ipcRenderer.on('resource:changed', handleResourceChanged)
    void loadCommands()
    return () =>
      window.electron.ipcRenderer.removeListener('resource:changed', handleResourceChanged)
  })

  async function loadCommands() {
    const requested = ++loadVersion
    loading = true
    try {
      const result = await window.electron.ipcRenderer.invoke('get-commands')
      if (requested !== loadVersion) return false
      commands = result.bcfdCommands
      commandsRevision = result.revision || ''
      commandsLoaded = true
      externalConflict = false
      operationError = ''
      return true
    } catch (error) {
      if (requested === loadVersion) {
        operationError = error instanceof Error ? error.message : 'Could not load commands'
      }
      return false
    } finally {
      if (requested === loadVersion) loading = false
    }
  }

  function finishEditing() {
    isEditing = false
    editingCommand = null
    editingIndex = null
  }

  function addCommand() {
    if (mutationBlocked) return
    isEditing = true
    editingCommand = null
    editingIndex = null
    externalConflict = false
  }

  function editCommand(command: BCFDCommand) {
    if (mutationBlocked) return
    isEditing = true
    editingCommand = command
    editingIndex = commands.findIndex((cmd) => cmd.id === command.id)
    externalConflict = false
  }

  async function handleEditorSave(command: BCFDCommand, index: number | null): Promise<boolean> {
    if (externalConflict || !commandsLoaded || loading || $commandSaveStatus.saving) return false
    let next: BCFDCommand[]
    if (editingCommand) {
      if (index === null || !commands[index] || commands[index].id !== editingCommand.id)
        return false
      next = commands.map((current, i) => (i === index ? command : current))
    } else {
      next = [...commands, ...prepareCommandImports([command], commands)]
    }
    return persistence.save(
      { bcfdCommands: next, expectedRevision: commandsRevision },
      finishEditing
    )
  }

  async function deleteCommand(command: BCFDCommand) {
    if (mutationBlocked) return
    await persistence.save({
      bcfdCommands: commands.filter((current) => current.id !== command.id),
      expectedRevision: commandsRevision
    })
  }

  async function reloadAfterConflict() {
    if ($commandSaveStatus.saving || importing) return
    // Keep the draft and pending retry if reading the replacement fails.
    if (await loadCommands()) {
      persistence.discard()
      finishEditing()
      showRepository = false
    }
  }

  function cancelEditing() {
    if ($commandSaveStatus.saving) return
    persistence.discard()
    finishEditing()
    if (externalConflict) void loadCommands()
  }

  async function exportCommands() {
    try {
      const result = await window.electron.ipcRenderer.invoke('export-commands')
      if (!result.success && !result.canceled) {
        operationError = 'Error exporting commands: ' + result.error
      }
    } catch (error) {
      operationError = error instanceof Error ? error.message : 'Could not export commands'
    }
  }

  async function importCommands() {
    if (mutationBlocked) return
    importing = true
    operationError = ''
    try {
      const result = await window.electron.ipcRenderer.invoke('import-commands')
      if (result.success) {
        const imported = prepareCommandImports(result.commands, commands)
        await persistence.save({
          bcfdCommands: [...commands, ...imported],
          expectedRevision: commandsRevision
        })
      } else if (!result.canceled) {
        operationError = 'Error importing commands: ' + result.error
      }
    } catch (error) {
      operationError = error instanceof Error ? error.message : 'Could not import commands'
    } finally {
      importing = false
    }
  }

  function openShareModal(command: BCFDCommand) {
    commandToShare = command
    shareDialog.showModal()
  }

  async function handleRepoImport(event: CustomEvent<BCFDCommand>) {
    if (mutationBlocked) return
    const imported = prepareCommandImports([event.detail], commands)
    await persistence.save(
      { bcfdCommands: [...commands, ...imported], expectedRevision: commandsRevision },
      () => (showRepository = false)
    )
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
  {#if operationError}
    <div class="alert alert-error m-4" role="alert">
      <span>{operationError}</span>
      {#if !commandsLoaded}
        <button class="btn btn-sm" onclick={loadCommands}>Retry loading</button>
      {/if}
    </div>
  {/if}
  {#if $commandSaveStatus.error}
    <div class="alert alert-error m-4" role="alert">
      <span
        >Could not confirm the command save. Your pending changes are kept for retry. {$commandSaveStatus.error}</span
      >
      {#if !isEditing}
        <button
          class="btn btn-sm"
          disabled={$commandSaveStatus.saving || externalConflict || loading}
          onclick={() => persistence.retry()}>Retry save</button
        >
      {/if}
      <button
        class="btn btn-sm btn-ghost"
        disabled={$commandSaveStatus.saving || importing || loading}
        onclick={reloadAfterConflict}>Reload and discard unsaved changes</button
      >
      {#if !isEditing}
        <button
          class="btn btn-sm btn-ghost"
          onclick={() => {
            persistence.discard()
            if (externalConflict) void loadCommands()
          }}>Discard pending save</button
        >
      {/if}
    </div>
  {:else if $commandSaveStatus.saving}
    <p class="m-4 text-sm" role="status">Saving commands…</p>
  {/if}
  {#if externalConflict}
    <div class="alert alert-warning m-4" role="alert">
      <span
        >This command data changed externally. Reload before saving. Reload discards your unsaved
        command changes.</span
      >
      <button
        class="btn btn-sm"
        disabled={$commandSaveStatus.saving || importing}
        onclick={reloadAfterConflict}>Reload</button
      >
    </div>
  {/if}
  {#if showRepository}
    <CommandRepository on:import={handleRepoImport} on:close={() => (showRepository = false)} />
  {:else if isEditing}
    <CommandEditor
      mode={editingCommand ? 'edit' : 'add'}
      command={editingCommand}
      index={editingIndex}
      onSave={handleEditorSave}
      saveBlocked={externalConflict}
      on:cancel={cancelEditing}
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
              <button
                class="btn btn-secondary"
                disabled={mutationBlocked}
                onclick={() => (showRepository = true)}
              >
                <span class="material-symbols-outlined">explore</span>
              </button>
            </span>
            <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('export')}>
              <button class="btn btn-primary" onclick={exportCommands}>
                <span class="material-symbols-outlined">download</span>
              </button>
            </span>
            <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('import')}>
              <button class="btn btn-primary" disabled={mutationBlocked} onclick={importCommands}>
                <span class="material-symbols-outlined">upload</span>
              </button>
            </span>
            <button class="btn btn-primary" disabled={mutationBlocked} onclick={addCommand}>
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
                mutationDisabled={mutationBlocked}
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
