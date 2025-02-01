<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDCommand } from '../types/types'
  import CommandEditor from './CommandEditor.svelte'
  import CommandListItem from './CommandListItem.svelte'
  import { fade } from 'svelte/transition'
  import { t } from '../stores/localisation'

  let commands: BCFDCommand[] = []
  let isEditing = false
  let editingCommand: BCFDCommand | null = null
  let searchQuery = ''

  onMount(async () => {
    await loadCommands()
  })

  async function loadCommands() {
    const result = await (window as any).electron.ipcRenderer.invoke('get-commands')
    commands = result.bcfdCommands
  }

  async function saveCommands() {
    await (window as any).electron.ipcRenderer.invoke('save-commands', { bcfdCommands: commands })
  }

  function addCommand() {
    isEditing = true
    editingCommand = null
  }

  function editCommand(command: BCFDCommand) {
    isEditing = true
    editingCommand = command
  }

  async function handleAdd(event: CustomEvent<BCFDCommand>) {
    commands = [...commands, event.detail]
    await saveCommands()
    isEditing = false
  }

  async function handleUpdate(event: CustomEvent<BCFDCommand>) {
    const updatedCommand = event.detail
    commands = commands.map((cmd) =>
      cmd.command === updatedCommand.command ? updatedCommand : cmd
    )
    await saveCommands()
    isEditing = false
  }

  async function deleteCommand(command: BCFDCommand) {
    commands = commands.filter((cmd) => cmd.command !== command.command)
    await saveCommands()
  }

  $: filteredCommands = commands.filter(
    (cmd) =>
      cmd.command.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cmd.commandDescription.toLowerCase().includes(searchQuery.toLowerCase())
  )
</script>

<div class="">
  {#if isEditing}
    <CommandEditor
      mode={editingCommand ? 'edit' : 'add'}
      command={editingCommand}
      on:add={handleAdd}
      on:update={handleUpdate}
      on:cancel={() => (isEditing = false)}
    />
  {:else}
    <div class="sticky top-0 z-20 bg-base-100 p-4 pb-1">
      <div class="flex justify-between items-center mb-4">
        <h2 class="text-2xl font-bold">{$t('commands')}</h2>
        <button class="btn btn-primary" on:click={addCommand}
          ><span class="material-symbols-outlined">add</span>{$t('add-command')}</button
        >
      </div>
      <div class="mb-4">
        <label class="input input-bordered flex items-center gap-2">
          <input type="text" class="grow" placeholder="Search" bind:value={searchQuery} />
          <span class="material-symbols-outlined">search</span>
        </label>
      </div>
    </div>
    <div class="p-4">
      {#if filteredCommands.length === 0}
        <p class="text-gray-500">{$t('no-commands-found')}</p>
      {:else}
        <ul class="space-y-2">
          {#each filteredCommands as command}
            <div transition:fade={{ duration: 100 }}>
              <CommandListItem {command} {editCommand} {deleteCommand} />
            </div>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
