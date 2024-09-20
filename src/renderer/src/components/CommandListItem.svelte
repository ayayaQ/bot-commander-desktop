<script lang="ts">
  import type { BCFDCommand } from '../types/types'
  import Dialog from './Dialog.svelte'

  export let command: BCFDCommand
  export let editCommand: (command: BCFDCommand) => void
  export let deleteCommand: (command: BCFDCommand) => void

  let dialog: HTMLDialogElement

  function exportCommand() {
    const jsonCommand = JSON.stringify(command, null, 2)
    navigator.clipboard.writeText(jsonCommand)
      .then(() => alert('Command exported to clipboard!'))
      .catch(err => console.error('Failed to copy command: ', err))
  }
</script>

<li class="card bg-base-200 shadow-xl">
  <div class="card-body">
    <div class="flex justify-between items-start">
      <div class="flex items-center justify-center gap-2">
        <div class="flex items-center justify-center"><span class="material-symbols-outlined" style="font-size: 3rem;">message</span></div>
        <div>
        <h3 class="card-title">{command.command}</h3>
        <p>{command.commandDescription}</p>
    </div>
      </div>
      <div class="space-x-2">
        <button class="btn btn-square btn-ghost" on:click={() => editCommand(command)}><span class="material-symbols-outlined">edit</span></button>
        <button class="btn btn-square btn-info" on:click={exportCommand}><span class="material-symbols-outlined">download</span></button>
        <button class="btn btn-square btn-error" on:click={() => dialog.showModal()}><span class="material-symbols-outlined">delete</span></button>

        <Dialog bind:dialog on:close={() => console.log('closed')}>
          <p>Are you sure you want to delete the command "{command.command}"?</p>
          <div class="modal-action">
            <form method="dialog">
              <button class="btn btn-sm btn-error" on:click={() => deleteCommand(command)}
                >Delete</button
              >
              <button class="btn btn-sm btn-secondary">Cancel</button>
            </form>
          </div>
        </Dialog>
      </div>
    </div>
  </div>
</li>
