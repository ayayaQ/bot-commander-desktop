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

  let commands: BCFDCommand[] = $state([])
  let isEditing = $state(false)
  let editingCommand: BCFDCommand | null = $state(null)
  let editingIndex: number | null = $state(null)
  let searchQuery = $state('')
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
    await window.electron.ipcRenderer.invoke('save-commands', { bcfdCommands: $state.snapshot(commands) })
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

  let filteredCommands = $derived(commands.filter(
    (cmd) =>
      cmd.command.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cmd.commandDescription.toLowerCase().includes(searchQuery.toLowerCase())
  ))
</script>

<div class="">
  {#if showRepository}
    <CommandRepository
      on:import={handleRepoImport}
      on:close={() => showRepository = false}
    />
  {:else if isEditing}
    <CommandEditor
      mode={editingCommand ? 'edit' : 'add'}
      command={editingCommand}
      index={editingIndex}
      allCommands={commands}
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
            <span class="tooltip tooltip-primary tooltip-bottom" data-tip={$t('browse-repository') || 'Browse Repository'}>
              <button class="btn btn-secondary" onclick={() => showRepository = true}>
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
        <div class="">
          <label class="input flex items-center gap-2 w-full">
            <input type="text" class="grow" placeholder={$t('search')} bind:value={searchQuery} />
            <span class="material-symbols-outlined">search</span>
          </label>
        </div>
      </div>
    </HeaderBar>
    <div class="p-4">
      {#if filteredCommands.length === 0}
        <p class="text-gray-500">{$t('no-commands-found')}</p>
      {:else}
        <ul class="space-y-2">
          {#each filteredCommands as command}
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
  on:shared={() => commandToShare = null}
/>
