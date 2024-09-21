<script lang="ts">
  import { onMount } from 'svelte'
  import type { BCFDCommand } from '../../../main/types'
  import CommandEditor from './CommandEditor.svelte'
  import CommandListItem from './CommandListItem.svelte'
  import { fade } from 'svelte/transition'

  let commands: BCFDCommand[] = []
  let isEditing = false
  let editingCommand: BCFDCommand | null = null

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
</script>

<div class="p-4">
  {#if isEditing}
    <CommandEditor
      mode={editingCommand ? 'edit' : 'add'}
      command={editingCommand}
      on:add={handleAdd}
      on:update={handleUpdate}
    />
    <button class="btn btn-secondary mt-4" on:click={() => (isEditing = false)}>Cancel</button>
  {:else}
    <div class="flex justify-between items-center mb-4">
      <h2 class="text-2xl font-bold">Command List</h2>
      <button class="btn btn-primary" on:click={addCommand}><span class="material-symbols-outlined">add</span>Add Command</button>
    </div>
    {#if commands.length === 0}
      <p class="text-gray-500">No commands found.</p>
    {:else}
      <ul class="space-y-2">
        {#each commands as command}
        <div transition:fade={{ duration: 100 }}>
          <CommandListItem {command} {editCommand} {deleteCommand} />
        </div>

        {/each}
      </ul>
    {/if}
  {/if}
</div>
